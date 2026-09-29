import "./support/dom";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { currentCompletions, startCompletion } from "@codemirror/autocomplete";
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
  inTypstMath,
  lspContentChanges,
  mathUsage,
  typstEditorExtensions,
} from "../src/editor/typstEditor";
import { canonicalUri } from "../src/lsp/client";
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
