import "./support/dom";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { currentCompletions, selectedCompletionIndex, startCompletion } from "@codemirror/autocomplete";
import { toggleComment } from "@codemirror/commands";
import { ChangeSet, EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { typstHighlightPlugin } from "../src/editor/highlightPlugin";
import {
  decodeSemanticTokens,
  markSemanticStale,
  semanticStaleField,
  semanticTokensExtension,
  setSemanticActive,
  setSemanticTokens,
} from "../src/editor/semanticTokens";
import type {
  LspCompletionBackend,
  LspCompletionContext,
  LspCompletionItem,
  LspPosition,
} from "../src/editor/shared/lspCompletion";
import {
  LspDocument,
  inTypstMath,
  lspContentChanges,
  mathUsage,
  typstEditorExtensions,
} from "../src/editor/typstEditor";
import { LspClient, canonicalUri } from "../src/lsp/client";
import { bookMain } from "../src/preview/previewEntry";
import { press, sleep, waitFor } from "./support/keyMatrix";

// tinymist 0.15.2's completionProvider.triggerCharacters
const TRIGGERS = ["#", "(", "<", ",", ".", ":", "/", '"', "@"];

function backend(answer: (pos: LspPosition, doc: string) => unknown = () => null) {
  const calls: { pos: LspPosition; context: LspCompletionContext; doc: string }[] = [];
  const b: LspCompletionBackend = {
    triggerCharacters: () => TRIGGERS,
    async request(pos, context, state) {
      const doc = state.doc.toString();
      calls.push({ pos, context, doc });
      return answer(pos, doc);
    },
  };
  return { backend: b, calls };
}

/** `|` marks the cursor. */
function editor(docWithCursor: string, completion = backend().backend) {
  const cursor = docWithCursor.indexOf("|");
  const doc = docWithCursor.replace("|", "");
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: typstEditorExtensions({ completion }, doc),
    }),
    parent: document.body,
  });
}

function withCursor(view: EditorView) {
  const doc = view.state.doc.toString();
  const head = view.state.selection.main.head;
  return doc.slice(0, head) + "|" + doc.slice(head);
}

/** Type like the DOM input path: input handlers (closeBrackets, mathInput) first. */
function typeInput(view: EditorView, text: string) {
  for (const ch of text) {
    const { from, to } = view.state.selection.main;
    const insert = () =>
      view.state.update({
        changes: { from, to, insert: ch },
        selection: { anchor: from + 1 },
        userEvent: "input.type",
      });
    const handled = view.state
      .facet(EditorView.inputHandler)
      .some((h) => h(view, from, to, ch, insert));
    if (!handled) view.dispatch(insert());
  }
}

/** Type one character at a time, pausing past CodeMirror's 100 ms typing delay. */
async function typeSlowly(view: EditorView, text: string, gap = 140) {
  for (const ch of text) {
    typeInput(view, ch);
    await sleep(gap);
  }
}

// ---- math spans ------------------------------------------------------------------------

test("math spans skip escapes, comments, raw text and code strings", () => {
  const inside = (src: string) => {
    const doc = Text.of(src.replace(/[|]/g, "").split("\n"));
    const marks = [...src.matchAll(/[|]/g)].map((m, i) => m.index! - i);
    return marks.map((p) => inTypstMath(doc, p));
  };
  assert.deepEqual(inside("a |$|x + y|$| b"), [false, true, true, false]);
  assert.deepEqual(inside("\\$ not| $m|$"), [false, true]);
  assert.deepEqual(inside("// $ comment|\n$y|$"), [false, true]);
  assert.deepEqual(inside("/* $ */ x| $k|$"), [false, true]);
  assert.deepEqual(inside("`$raw$` x| $z|$"), [false, true]);
  assert.deepEqual(inside("```\n$\n``` x| $q|$"), [false, true]);
  assert.deepEqual(inside('#let s = "$" + x| $w|$'), [false, true]);
  // A markup quote is prose, and `//` after a colon is a URL, not a comment.
  assert.deepEqual(inside('He said "a $b|$ c|"'), [true, false]);
  assert.deepEqual(inside("see https://a.b $m|$ x|"), [true, false]);
  assert.deepEqual(inside("$ unclosed|"), [true]);
});

test("math usage counts multi-letter identifiers inside math only", () => {
  const usage = mathUsage(Text.of(["$theta + theta^2$ #theorem[a] $alpha_i x$"]));
  assert.equal(usage.get("theta"), 2);
  assert.equal(usage.get("alpha"), 1);
  assert.equal(usage.get("theorem"), undefined);
  assert.equal(usage.get("x"), undefined);
});

// ---- completion policy ---------------------------------------------------------------------

test("activation: 2 letters in math, triggers at once, 1 char after ( , : =", async () => {
  const cases: [string, string, (LspCompletionContext | null)[]][] = [
    // [document, typed, contexts of the requests sent]
    ["$ |$", "a_i", []], // subscripts and one-letter variables stay quiet
    ["$ |$", "x2", []],
    ["$ |$", "th", [{ triggerKind: 1 }]],
    ["$ x = 1|$", ".", []], // a decimal point, not postfix completion
    ["$arrow|$", ".", [{ triggerKind: 2, triggerCharacter: "." }]],
    ["#set text|", "(f", [{ triggerKind: 2, triggerCharacter: "(" }, { triggerKind: 1 }]],
    ["Some |", "a", []], // one letter of prose
    ["Some |", "he", [{ triggerKind: 1 }]], // tinymist answers prose with nothing
    ["See |", "@", [{ triggerKind: 2, triggerCharacter: "@" }]],
  ];
  for (const [doc, typed, expected] of cases) {
    const { backend: b, calls } = backend();
    const view = editor(doc, b);
    try {
      await typeSlowly(view, typed);
      assert.deepEqual(
        calls.map((c) => c.context),
        expected,
        `${JSON.stringify(doc)} + ${JSON.stringify(typed)}`,
      );
    } finally {
      view.destroy();
    }
  }
});

function item(label: string, sortText: string, from: LspPosition, to: LspPosition): LspCompletionItem {
  return { label, kind: 5, sortText, insertTextFormat: 2, textEdit: { newText: label, range: { start: from, end: to } } };
}

test("in math, symbols the document already uses win ties (theta before theorem)", async () => {
  // tinymist sorts alphabetically: theorem < therefore < theta.
  const answer = (pos: LspPosition) => {
    const from = { line: pos.line, character: pos.character - 3 };
    return {
      isIncomplete: false,
      items: [
        item("theorem", "361", from, pos),
        item("therefore", "362", from, pos),
        item("theta", "363", from, pos),
      ],
    };
  };
  for (const [doc, first] of [
    ["$ theta + 1 $\n$ x = the|$", "theta"],
    ["$ x = the|$", "theorem"],
    ["#theorem[] #theorem[]\n$ x = the|$", "theorem"], // used outside math: no boost
  ]) {
    const view = editor(doc, backend(answer).backend);
    try {
      startCompletion(view);
      await waitFor(() => currentCompletions(view.state).length > 0);
      assert.equal(currentCompletions(view.state)[0].label, first, doc);
    } finally {
      view.destroy();
    }
  }
});

/** tinymist's math symbol items: a glyph in labelDetails, kind 5; functions have a signature. */
function mathItem(label: string, sortText: string | undefined, desc: string, pos: LspPosition, typed: number): LspCompletionItem {
  const fn = desc.startsWith("(");
  return {
    label,
    kind: fn ? 3 : 5,
    labelDetails: { description: desc },
    sortText,
    insertTextFormat: 2,
    textEdit: {
      newText: fn ? `${label}(\${1:})` : label,
      range: { start: { line: pos.line, character: pos.character - typed }, end: pos },
    },
  };
}

test("in math, Greek letters, then other symbols, then functions win ties", async () => {
  // tinymist 0.15.2 for `$ x = the` with a template defining `theorem`, and for `$ x = al`.
  const lists: Record<string, [string, string, string][]> = {
    the: [
      ["mustache", "249", "⎰"],
      ["theorem", "362", "(any) => any"],
      ["therefore", "363", "∴"],
      ["theta", "364", "θ"],
    ],
    al: [
      ["aleph", "060", "א"],
      ["align", "061", "(content) => content"],
      ["alpha", "062", "α"],
    ],
  };
  for (const [word, first] of [["the", "theta"], ["al", "alpha"]]) {
    const answer = (pos: LspPosition) => ({
      isIncomplete: false,
      items: lists[word].map(([l, s, d]) => mathItem(l, s, d, pos, word.length)),
    });
    const view = editor(`#let theorem(body) = body\n$ x = ${word}|$`, backend(answer).backend);
    try {
      startCompletion(view);
      await waitFor(() => currentCompletions(view.state).length > 0);
      assert.equal(currentCompletions(view.state)[0].label, first, word);
    } finally {
      view.destroy();
    }
  }
});

test("after `.` the list keeps tinymist's order: modifiers first, no usage boost for postfix items", async () => {
  // tinymist sends no sortText here: arrow's modifiers, then postfix rewrites (abs, bb).
  const answer = (pos: LspPosition) => {
    const at = { start: pos, end: pos };
    const dot = { line: pos.line, character: pos.character - 1 };
    const postfix = (label: string): LspCompletionItem => ({
      label,
      kind: 3,
      labelDetails: { description: "(content) => content" },
      textEdit: { newText: "", range: at },
      additionalTextEdits: [
        { range: { start: { line: pos.line, character: pos.character - 6 }, end: dot }, newText: `${label}(arrow` },
        { range: { start: dot, end: pos }, newText: ")" },
      ],
    });
    return {
      isIncomplete: false,
      items: [
        { label: "b", kind: 5, labelDetails: { description: "↓" }, textEdit: { newText: "b", range: at } },
        { label: "bar", kind: 5, labelDetails: { description: "↦" }, textEdit: { newText: "bar", range: at } },
        postfix("abs"),
        postfix("bb"),
      ],
    };
  };
  const { backend: b } = backend(answer);
  const view = editor("$bb(R) + bb(Z)$\n$ a arrow|$", b);
  try {
    await typeSlowly(view, ".");
    await waitFor(() => selectedCompletionIndex(view.state) !== null);
    assert.deepEqual(currentCompletions(view.state).map((c) => c.label), ["b", "bar", "abs", "bb"]);
    await sleep(90); // interactionDelay
    press(view, "Tab");
    assert.equal(withCursor(view), "$bb(R) + bb(Z)$\n$ a arrow.b|$");
  } finally {
    view.destroy();
  }
});

test("string values (fonts): one request, filtered while typing, accepting replaces the typed text", async () => {
  // tinymist 0.15.2: quoted labels, but edits at the cursor. Right after the `"` trigger the
  // edit is the bare value; once something is typed it is the value with its opening quote.
  const fonts = ["ADT Slab Numeric", "Arial", "Times New Roman"];
  const answer = (pos: LspPosition, doc: string) => {
    const line = doc.split("\n")[pos.line];
    const atQuote = line[pos.character - 1] === '"';
    return {
      isIncomplete: false,
      items: fonts.map((f, i) => ({
        label: `"${f}"`,
        kind: 6,
        sortText: String(i).padStart(3, "0"),
        textEdit: { newText: atQuote ? f : `"${f}`, range: { start: pos, end: pos } },
      })),
    };
  };
  {
    const { backend: b, calls } = backend(answer);
    const view = editor("#set text(font: |)", b);
    try {
      await typeSlowly(view, '"Ti');
      await waitFor(() => selectedCompletionIndex(view.state) !== null);
      assert.equal(currentCompletions(view.state)[0].label, '"Times New Roman"');
      assert.equal(calls.length, 1);
      await sleep(90);
      press(view, "Enter");
      assert.equal(withCursor(view), '#set text(font: "Times New Roman|")');
    } finally {
      view.destroy();
    }
  }
  {
    // Ctrl-Space inside the string: the typed shape, filtered on what is typed.
    const view = editor('#set text(font: ("Arial", "Ti|"))', backend(answer).backend);
    try {
      startCompletion(view);
      await waitFor(() => selectedCompletionIndex(view.state) !== null);
      assert.equal(currentCompletions(view.state)[0].label, '"Times New Roman"');
      await sleep(90);
      press(view, "Tab");
      assert.equal(withCursor(view), '#set text(font: ("Arial", "Times New Roman|"))');
    } finally {
      view.destroy();
    }
  }
});

// ---- editing details -----------------------------------------------------------------------

test("Enter continues - / + / 1. list items and ends the list on an empty item", async () => {
  const cases: [string, string][] = [
    ["- foo|", "- foo\n- |"],
    ["  + bar|", "  + bar\n  + |"],
    ["3. x|", "3. x\n4. |"],
    ["- foo| bar", "- foo\n- |bar"],
    ["a\n- |", "a\n|"],
    ["- a\n  - |", "- a\n- |"],
    ["|- foo", "\n|- foo"],
    ["$\n- x|\n$", "$\n- x\n|\n$"], // subtraction in math
    ["plain|", "plain\n|"],
  ];
  for (const [before, after] of cases) {
    const view = editor(before);
    try {
      press(view, "Enter");
      await sleep(0);
      assert.equal(withCursor(view), after, JSON.stringify(before));
    } finally {
      view.destroy();
    }
  }
});

test("Enter after an opening ( [ { indents the new line; the closer keeps the opener's indentation", async () => {
  const cases: [string, string][] = [
    ["#let f(x) = {|}", "#let f(x) = {\n  |\n}"],
    ["#theorem[|]", "#theorem[\n  |\n]"],
    ["#figure(|)", "#figure(\n  |\n)"],
    ["#let f(x) = {|", "#let f(x) = {\n  |"],
    ["  #let f(x) = {|}", "  #let f(x) = {\n    |\n  }"],
    ["#f(|a, b)", "#f(\n  |a, b)"],
    ["#let f(x) = {\n  let a = 1|\n}", "#let f(x) = {\n  let a = 1\n  |\n}"],
    ["#let f(x) = { // c|", "#let f(x) = { // c\n  |"],
    ['#link("https://typst.app")[|]', '#link("https://typst.app")[\n  |\n]'],
    ['#let s = "{"|', '#let s = "{"\n|'],
    ["#f(a)[b]|", "#f(a)[b]\n|"],
    ["Interval [0, 1)|", "Interval [0, 1)\n|"],
    ["see (Lemma 3|", "see (Lemma 3\n|"],
    ["\\{|", "\\{\n|"], // an escaped brace is text
    ["- foo(|", "- foo(\n- |"], // list continuation comes first
    ["#let a = {\n    1\n}\n#let f(x) = {|}", "#let a = {\n    1\n}\n#let f(x) = {\n    |\n}"],
  ];
  for (const [before, after] of cases) {
    const view = editor(before);
    try {
      press(view, "Enter");
      await sleep(0);
      assert.equal(withCursor(view), after, JSON.stringify(before));
    } finally {
      view.destroy();
    }
  }
});

test("Tab nests a list item from its marker on, also typed right after a letter", async () => {
  const cases: [string, string[], string][] = [
    ["- |", ["Tab"], "  - |"],
    ["- foo|", ["Tab"], "  - foo|"],
    ["- fo|o", ["Tab"], "  - fo|o"],
    ["- foo|", ["Enter", "Tab"], "- foo\n  - |"],
    ["1. x|", ["Enter", "Tab"], "1. x\n  2. |"],
    ["  - nested|", ["Enter", "Shift-Tab"], "  - nested\n- |"],
    ["$\n- x|\n$", ["Tab"], "$\n- x |\n$"], // subtraction in math
    ["plain|", ["Tab"], "plain |"],
  ];
  for (const [before, keys, after] of cases) {
    const view = editor(before);
    try {
      for (const key of keys) {
        press(view, key);
        await sleep(0);
      }
      assert.equal(withCursor(view), after, `${JSON.stringify(before)} ${keys.join(" ")}`);
    } finally {
      view.destroy();
    }
  }
  // Tab right after typing waits for completion (Tab-ahead); nothing comes, so it nests.
  const view = editor("- fo|");
  try {
    typeInput(view, "o");
    assert.equal(press(view, "Tab").handled, true);
    await sleep(300);
    assert.equal(withCursor(view), "  - foo|");
  } finally {
    view.destroy();
  }
});

test("Tab right after a letter still inserts a space when no completion comes", async () => {
  // CM reports completions as loading for 100 ms after every typed letter, even when the
  // source then answers nothing; Tab-ahead used to swallow that Tab.
  const view = editor("Some|");
  try {
    typeInput(view, "a");
    assert.equal(press(view, "Tab").handled, true);
    await sleep(300);
    assert.equal(withCursor(view), "Somea |");
  } finally {
    view.destroy();
  }
});

test("* and _ typed over a selection wrap it; not in math", () => {
  const view = editor("a bold b|");
  try {
    view.dispatch({ selection: { anchor: 2, head: 6 } });
    typeInput(view, "*");
    assert.equal(view.state.doc.toString(), "a *bold* b");
    assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), "bold");
    typeInput(view, "_");
    assert.equal(view.state.doc.toString(), "a *_bold_* b");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "$ x y $" }, selection: { anchor: 2, head: 3 } });
    typeInput(view, "_");
    assert.equal(view.state.doc.toString(), "$ _ y $");
  } finally {
    view.destroy();
  }
});

test("Typst language data: // comments, $ opens display math, quotes pair", () => {
  const view = editor("x = 1|");
  try {
    toggleComment(view);
    assert.equal(view.state.doc.toString(), "// x = 1");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
    typeInput(view, "$$");
    assert.equal(withCursor(view), "$ | $");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
    typeInput(view, '"');
    assert.equal(withCursor(view), '"|"');
  } finally {
    view.destroy();
  }
});

// ---- LSP document sync -------------------------------------------------------------------------

/** Apply LSP incremental changes in order, the way a server does. */
function applyLsp(text: string, changes: ReturnType<typeof lspContentChanges>): string {
  for (const c of changes) {
    const lines = text.split("\n");
    const at = (p: LspPosition) =>
      lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
    text = text.slice(0, at(c.range.start)) + c.text + text.slice(at(c.range.end));
  }
  return text;
}

test("incremental didChange entries reproduce every multi-range edit", () => {
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
  const pieces = ["a", "\n", "θ", "𝔸", "$x$", "  ", "#f(", "\n\n"];
  for (let round = 0; round < 300; round++) {
    let text = "";
    for (let i = rand(12); i > 0; i--) text += pieces[rand(pieces.length)];
    const doc = Text.of(text.split("\n"));
    const specs: { from: number; to: number; insert: string }[] = [];
    let pos = 0;
    for (let i = rand(4); i >= 0 && pos <= doc.length; i--) {
      const from = pos + rand(doc.length - pos + 1);
      const to = from + rand(doc.length - from + 1);
      specs.push({ from, to, insert: pieces[rand(pieces.length)].repeat(rand(3)) });
      pos = to + 1;
    }
    const changes = ChangeSet.of(specs, doc.length);
    assert.equal(
      applyLsp(text, lspContentChanges(changes, doc)),
      changes.apply(doc).toString(),
      JSON.stringify({ text, specs }),
    );
  }
});

test("two panes on one file share the server's copy: one didOpen, each edit once, didClose with the last", () => {
  const log: string[] = [];
  let server = "";
  const fake = {
    status: "running",
    didOpen: (_p: string, text: string) => (log.push("open"), (server = text)),
    didChange: (_p: string, text: string) => (log.push("full"), (server = text)),
    didChangeRanges: (_p: string, changes: ReturnType<typeof lspContentChanges>) => (
      log.push("ranges"), (server = applyLsp(server, changes))
    ),
    didClose: () => log.push("close"),
  };
  const lsp = fake as unknown as LspClient;
  const path = "/vault/a.typ";
  const a = new LspDocument(() => lsp);
  const b = new LspDocument(() => lsp);
  const edit = (doc: Text, from: number, insert: string) => {
    const changes = ChangeSet.of({ from, insert }, doc.length);
    return { doc: changes.apply(doc), changes, startDoc: doc };
  };
  const a0 = Text.of(["Hello"]);
  const b0 = Text.of(["Hello"]);
  assert.equal(a.open(path, a0), true);
  assert.equal(b.open(path, b0), true); // attached (diagnostics apply), but no second didOpen
  // Typed in pane A; pane B reloads A's save and replays the same edit on its own document.
  const a1 = edit(a0, 5, " world");
  a.sync(a1.doc, a1);
  const b1 = edit(b0, 5, " world");
  b.sync(b1.doc, b1);
  assert.equal(server, "Hello world");
  // A's next keystroke still goes out as ranges; B catches up the same way.
  const a2 = edit(a1.doc, 11, "!");
  a.sync(a2.doc, a2);
  const b2 = edit(b1.doc, 11, "!");
  b.sync(b2.doc, b2);
  // B types next: its document matches the server's text, so ranges again.
  const b3 = edit(b2.doc, 0, "> ");
  b.sync(b3.doc, b3);
  assert.equal(server, "> Hello world!");
  assert.deepEqual(log, ["open", "ranges", "ranges", "ranges"]);
  b.close();
  assert.deepEqual(log.slice(4), []); // A still has it open
  const a3 = edit(a2.doc, 0, "> ");
  a.sync(a3.doc, a3);
  assert.deepEqual(log.slice(4), []); // A reloaded B's edit: already on the server
  a.close();
  assert.deepEqual(log.slice(4), ["close"]);
  // A restarted server is a new client: the file is opened on it again.
  const restarted = { ...fake } as unknown as LspClient;
  const c = new LspDocument(() => restarted);
  assert.equal(c.open(path, a3.doc), true);
  assert.deepEqual(log.slice(5), ["open"]);
});

// ---- semantic tokens ---------------------------------------------------------------------------

test("semantic tokens: edited lines fall back to the baseline tokenizer until the next response", () => {
  const legend = { tokenTypes: ["keyword"], tokenModifiers: [] };
  const doc = "#let a = 1\n#let b = 2\n";
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [semanticTokensExtension, typstHighlightPlugin] }),
    parent: document.body,
  });
  // "#let" on lines 0 and 1, as tinymist encodes it.
  const tokens = () => [0, 0, 4, 0, 0, 1, 0, 4, 0, 0];
  const classes = (line: number) =>
    [...view.contentDOM.querySelectorAll(".cm-line")[line].querySelectorAll("span")].map((s) => s.className);
  try {
    view.dispatch({
      effects: [
        setSemanticActive.of(true),
        setSemanticTokens.of(decodeSemanticTokens(view.state.doc, tokens(), legend)),
      ],
    });
    assert.deepEqual(classes(0), ["tym-sem-keyword"]);
    assert.deepEqual(classes(1), ["tym-sem-keyword"]);
    // Typing on line 2: its (mapped) semantic marks give way to baseline ones.
    view.dispatch({ changes: { from: 14, insert: "x" }, userEvent: "input.type" });
    assert.deepEqual(view.state.field(semanticStaleField), [{ from: 11, to: 22 }]);
    assert.deepEqual(classes(0), ["tym-sem-keyword"]);
    assert.deepEqual(classes(1), ["tym-keyword"]);
    // A response for an older text, mapped, still leaves the late edit stale.
    view.dispatch({
      effects: [
        setSemanticTokens.of(decodeSemanticTokens(view.state.doc, tokens(), legend)),
        markSemanticStale.of([{ from: 14, to: 15 }]),
      ],
    });
    assert.deepEqual(classes(1), ["tym-keyword"]);
    view.dispatch({ effects: setSemanticTokens.of(decodeSemanticTokens(view.state.doc, tokens(), legend)) });
    assert.deepEqual(view.state.field(semanticStaleField), []);
    assert.deepEqual(classes(1), ["tym-sem-keyword"]);
  } finally {
    view.destroy();
  }
});

// ---- plugin plumbing -----------------------------------------------------------------------------

test("bookMain: the nearest main.typ that includes the chapter", () => {
  const root = mkdtempSync(join(tmpdir(), "tinymist-book-"));
  try {
    const book = join(root, "math", "prob");
    mkdirSync(join(book, "chapters"), { recursive: true });
    mkdirSync(join(book, "homeworks"), { recursive: true });
    const main = join(book, "main.typ");
    writeFileSync(main, '#include "chapters/03-joint&cond.typ"\n');
    const chapter = join(book, "chapters", "03-joint&cond.typ");
    const homework = join(book, "homeworks", "hw01.typ");
    for (const f of [chapter, homework]) writeFileSync(f, "");
    assert.equal(bookMain(chapter, root), main);
    assert.equal(bookMain(homework, root), null); // main.typ does not include it
    assert.equal(bookMain(main, root), null);
    assert.equal(bookMain(chapter, join(root, "other")), null); // outside the vault
    // Only real includes count: not a name inside another path, not a commented-out one.
    const hw = join(root, "hw");
    mkdirSync(join(hw, "template"), { recursive: true });
    mkdirSync(join(hw, "sub"), { recursive: true });
    const hwMain = join(hw, "main.typ");
    writeFileSync(
      hwMain,
      [
        '#import "template/data.typ": *',
        '#include "11.typ"',
        '// #include "draft.typ"',
        '/* #include "old.typ" */',
        '#{ include "code.typ" }',
        '#include "/hw/sub/x.typ"', // from the vault root
      ].join("\n"),
    );
    for (const f of ["a.typ", "1.typ", "11.typ", "draft.typ", "old.typ", "code.typ", "sub/x.typ"]) {
      writeFileSync(join(hw, f), "");
    }
    assert.equal(bookMain(join(hw, "a.typ"), root), null); // "a.typ" is part of "data.typ"
    assert.equal(bookMain(join(hw, "1.typ"), root), null); // "1.typ" is part of "11.typ"
    assert.equal(bookMain(join(hw, "draft.typ"), root), null);
    assert.equal(bookMain(join(hw, "old.typ"), root), null);
    assert.equal(bookMain(join(hw, "11.typ"), root), hwMain);
    assert.equal(bookMain(join(hw, "code.typ"), root), hwMain);
    assert.equal(bookMain(join(hw, "sub", "x.typ"), root), hwMain);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostic URIs are canonical whatever the server's percent-encoding", () => {
  assert.equal(canonicalUri("file:///a/L^+(mu).typ"), canonicalUri("file:///a/L%5E+(mu).typ"));
  assert.equal(canonicalUri("file:///a/joint%26cond.typ"), "file:///a/joint&cond.typ");
  assert.equal(canonicalUri("untitled:1"), "untitled:1");
});

test("styles.css embeds the shared editor.css verbatim", () => {
  const styles = readFileSync("styles.css", "utf8");
  const begin = "/* shared:editor.css begin */\n";
  const start = styles.indexOf(begin) + begin.length;
  const end = styles.indexOf("/* shared:editor.css end */");
  assert.ok(start >= begin.length && end > start, "markers missing");
  assert.equal(styles.slice(start, end), readFileSync("src/editor/shared/editor.css", "utf8"));
});
