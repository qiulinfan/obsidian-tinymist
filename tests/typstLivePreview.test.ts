// T-T5 and T-T6: Typst live preview (src/editor/typstScan.ts, typstLive.ts,
// TypstLiveRenderer in typstRender.ts) on the real editor stack: formulas (T-T5) and the
// text constructs, headings, strong/emph, lists, references and labels (T-T6). A fake
// fragment backend answers in the shape of tinymist's SVG export; the last test mounts live
// mode on the synthetic book (tests/fixtures/book) against a real tinymist, skipped when
// none is found (TINYMIST_BIN overrides the lookup). The existing typstLive.test.ts is the
// real-tinymist editor suite.
import "./support/dom";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { undoDepth } from "@codemirror/commands";
import { EditorSelection, EditorState, RangeSet, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setTypingDiagnostics } from "../src/editor/shared/editorKit";
import { isLive, livePreview, livePreviewCompartment, refreshLive, renderStats } from "../src/editor/shared/livePreview";
import { typstEditorExtensions, typstMathSpans } from "../src/editor/typstEditor";
import { chapterPreamble, hash, topLevelStatements, typstMathAt } from "../src/editor/typstFragment";
import { typstLiveLanguage } from "../src/editor/typstLive";
import { FragmentBackend, TypstLiveRenderer, TypstRender } from "../src/editor/typstRender";
import { TypstConstruct, TypstMath, scanTypst, scanTypstText, typstCallAt } from "../src/editor/typstScan";
import { FragmentError, TypstFragmentRenderer } from "../src/lsp/fragmentRenderer";
import { press } from "./support/keyMatrix";

const BIN =
  process.env.TINYMIST_BIN ??
  ["/opt/homebrew/bin/tinymist", "/usr/local/bin/tinymist", join(homedir(), ".cargo", "bin", "tinymist")].find(
    existsSync,
  );

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeout = 3000, what = "condition"): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeout) throw new Error(`waitFor timeout: ${what}`);
    await sleep(5);
  }
}

const ROOT = resolve("tests/fixtures");
const BOOK = join(ROOT, "book");
const CH1 = join(BOOK, "chapters", "ch1.typ");
const read = (path: string) => readFileSync(path, "utf8");

// ---- T-T5 scanner ------------------------------------------------------------------------

const formulas = (constructs: readonly TypstConstruct[]) => constructs.filter((c): c is TypstMath => c.kind === "math");

/** What a test compares of a construct. */
const shape = (s: string, c: TypstMath) => ({
  text: s.slice(c.from, c.to),
  body: c.body,
  display: c.display,
  block: c.block,
  label: c.label,
});

test("T-T5 scan: formulas in markup only; display by whitespace; a display formula takes its trailing label", () => {
  const s = [
    '#import "../template.typ": *',
    "#let ip(a, b) = $lr(chevron.l #a, #b chevron.r)$",
    '#set math.equation(numbering: "(1)")',
    "Inline $x^2$, a display $ y $ inside a line, and $z$ <not-a-label>.",
    "$ a + b $ <eq:ab>",
    "$",
    "  c",
    "$ <eq:c>",
    "Text $ d $ <eq:d> after.",
    "  $ e $  ",
    "#theorem(title: [$t$])[",
    "  $ f $",
    "  and $g$.",
    "]",
    "#figure($h$, caption: [$i$])",
    "#for k in range(3) [ $x_#k$ ]",
    "#if true [ $j$ ] else [ $j2$ ]",
    "#context [ $k$ ]",
    "#[ $m$ ] #strong[$n$].field #f(1)[$o$][$p$]",
    "\\$5 and `$raw$` and ```typ $block raw$``` // $comment$",
    "/* $block comment$ */ $$ $ $ empty; a string \"$q$\" is markup; $\"$\" + r$",
    "#let s = [",
    "  $u$",
    "]",
    "$unclosed",
  ].join("\n");
  const found = formulas(scanTypstText(s)).map((c) => shape(s, c));
  const inline = (body: string) => ({ text: body, body, display: false, block: false, label: null });
  assert.deepEqual(found, [
    inline("$x^2$"),
    { text: "$ y $", body: "$ y $", display: true, block: false, label: null },
    inline("$z$"),
    { text: "$ a + b $ <eq:ab>", body: "$ a + b $", display: true, block: true, label: "eq:ab" },
    { text: "$\n  c\n$ <eq:c>", body: "$\n  c\n$", display: true, block: true, label: "eq:c" },
    { text: "$ d $ <eq:d>", body: "$ d $", display: true, block: false, label: "eq:d" },
    { text: "$ e $", body: "$ e $", display: true, block: true, label: null },
    { text: "$ f $", body: "$ f $", display: true, block: true, label: null },
    inline("$g$"),
    inline("$m$"),
    inline("$n$"),
    inline("$o$"),
    inline("$p$"),
    inline("$q$"),
    inline('$"$" + r$'),
  ]);
  // The dollars pair as typstMathSpans pairs them (the highlighter and the hover).
  const doc = Text.of(s.split("\n"));
  const spans = typstMathSpans(doc);
  for (const c of formulas(scanTypst(doc))) {
    const k = spans.findIndex((v, i) => i % 2 === 0 && v === c.from + 1);
    assert.ok(k >= 0 && spans[k + 1] === c.mathTo - 1, `${c.body} is a span`);
  }
  assert.equal(scanTypst(doc), scanTypst(doc), "memoized per Text");
});

test("T-T5 scan: a `#\"$\"` string opens no formula, for typstMathSpans (the hover, the cursor preview) as for the scan", () => {
  const s = ['见 #"$" 与 $t$。', 'next $n$ line #box[#"$"] and $v$.', 'C# "quoted $w$" is markup'].join("\n");
  const doc = Text.of(s.split("\n"));
  const spans = typstMathSpans(doc);
  const bodies: string[] = [];
  for (let k = 0; k < spans.length; k += 2) bodies.push(doc.sliceString(spans[k] - 1, spans[k + 1] + 1));
  assert.deepEqual(bodies, ["$t$", "$n$", "$v$", "$w$"]);
  assert.deepEqual(formulas(scanTypst(doc)).map((c) => c.body), bodies);
  assert.equal(typstMathAt(doc, s.indexOf("$t$") + 1)?.body, "$t$");
  assert.equal(typstMathAt(doc, s.indexOf("与")), null);
});

test("T-T5 scan: each formula carries the hash of the statements above it, as the renderer's preamble has them", () => {
  const texts = [
    read(CH1),
    read(join(BOOK, "chapters", "ch2.typ")),
    [
      "$a$",
      '#import "../template.typ": *',
      "$b$ #theorem[#let local = 1; $c$]",
      "#show: book.with(title: [x])",
      "#let f(x) = $x$",
      "$ d $",
      '#include "other.typ"',
      "#set text(size: 11pt); $e$",
    ].join("\n"),
    // Text constructs never hide a statement from the scan, nor show it one.
    [
      "*a #let x = 1* $b$",
      "- item #set text(red) $c$",
      '/ Term: #import "x.typ": y',
      "https://example.com/#let-z_a_ and *$d$* _#let w = 2_",
      "@r[#let v = 3] $e$ @s[plain]",
      "#box[*#let u = 4* $f$]",
      "$ g $",
    ].join("\n"),
  ];
  for (const s of texts) {
    const statements = topLevelStatements(s);
    for (const c of formulas(scanTypstText(s))) assert.equal(c.preamble, hash(chapterPreamble(statements, c.from)), c.body);
  }
  assert.deepEqual(formulas(scanTypstText(texts[3])).map((c) => c.body), ["$d$", "$e$", "$ g $"]);
  const keys = formulas(scanTypstText(texts[2])).map((c) => c.preamble);
  assert.deepEqual(
    keys.map((k) => keys.indexOf(k)),
    [0, 1, 1, 3, 4],
    "$a$ alone; $b$ and $c$ after the import; the template rule and #include add nothing; #let and #set do",
  );
});

test("T-T5 scan: the synthetic book's chapters", () => {
  const bodies = (path: string) => formulas(scanTypstText(read(path))).map((c) => (c.block ? `block ${c.body}` : c.body));
  assert.deepEqual(bodies(CH1), [
    "$EE[X] = integral_Omega X dif PP$",
    "$X: Omega -> RR$",
    "block $ Var(X) = EE[(X - EE[X])^2] $",
    "$EE[abs(X)] < infinity$",
    "block $ EE[X] = EE[EE[X given Y]]. $",
    "$a_1$",
    "$sum_(i=1)^n i = n(n+1) / 2$",
  ]);
  // `#let ip(a, b) = $…$` and `#let Lip = $L$` are statements: not rendered.
  assert.deepEqual(bodies(join(BOOK, "chapters", "ch2.typ")), [
    "$inner(x, y)$",
    "$norm(x)$",
    "block $ inner(x, y)^2 <= inner(x, x) inner(y, y) $",
    "$L$",
    "$norm(grad f(x) - grad f(y)) <= Lip norm(x - y)$",
  ]);
  // main.typ: `#let after-chapters = $A$` is a statement.
  assert.deepEqual(bodies(join(BOOK, "main.typ")), []);
});

// ---- T-T5 decorations --------------------------------------------------------------------

/**
 * A page like tinymist's for `source`: 1pt wide per character of the formula, the baseline
 * marker for inline math, the ink colour on a glyph.
 */
function page(source: string): string {
  const body = source.slice(source.lastIndexOf("$", source.length - 3)).trimEnd().length;
  const inline = source.includes('fill: rgb("#010203")');
  return [
    `<svg viewBox="0 0 ${body} 24" width="${body}pt" height="24pt" xmlns="http://www.w3.org/2000/svg">`,
    inline ? '<g transform="translate(0 16)"><path fill="#010203" d="M 0 0v 0.1h 0.1v -0.1Z "/></g>' : "",
    '<path fill="#0a0b0c" d="M 0 0"/></svg>',
  ].join("");
}

/** The formula a fragment source ends with. */
const formula = (source: string) => source.trimEnd().split("\n").at(-1)!.replace(/^#box\(.*?\)\)\)\)/, "");

interface Backend extends FragmentBackend {
  calls: string[];
  /** A Typst error for a source, or a plain Error (the renderer itself failed), or null. */
  fail: (source: string) => Error | null;
  /** Renders wait for this while set. */
  gate: Promise<void> | null;
}

function backend(): Backend {
  const b: Backend = {
    calls: [],
    fail: () => null,
    gate: null,
    async render(_dir, source) {
      b.calls.push(source);
      if (b.gate) await b.gate;
      const err = b.fail(source);
      if (err) throw err;
      return page(source);
    },
  };
  return b;
}

const FILE = join(BOOK, "notes", "live.typ");

function mount(
  text: string,
  b: Backend,
  o: { focus?: boolean; anchor?: number; file?: string; render?: TypstRender } = {},
) {
  const render = o.render ?? new TypstRender(b, ROOT);
  const renderer = new TypstLiveRenderer(render, o.file ?? FILE, () => document);
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      selection: { anchor: o.anchor ?? 0 },
      extensions: typstEditorExtensions(
        {
          completion: { triggerCharacters: () => [], request: async () => null },
          live: livePreview({ language: typstLiveLanguage(), renderer }),
        },
        text,
      ),
    }),
    parent: document.body,
  });
  if (o.focus) view.focus();
  const close = () => {
    view.destroy();
    if (!o.render) render.dispose();
  };
  return { view, render, renderer, close };
}

/** Widgets in place of source (not previews below revealed blocks). */
const widgets = (view: EditorView) => [...view.contentDOM.querySelectorAll<HTMLElement>(".lsp-lp-render:not(.is-below)")];
const text = (view: EditorView) => view.contentDOM.textContent ?? "";
const settled = (view: EditorView) => renderStats(view).pending === 0;

test("T-T5 live: formulas render in place; blocks own their lines and label; failures keep the source", async () => {
  const s = [
    '#import "../template.typ": *',
    "期望 $EE[X]$ 与 $bad$。",
    "$ Var(X) = EE[X^2] $ <eq:var>",
    "行内 $ x $ <eq:x> 显示。",
    "#let f(x) = $x^2$",
    "#block[#let q = 1; $q$ and $w$]",
  ].join("\n");
  const b = backend();
  b.fail = (source) =>
    formula(source) === "$bad$"
      ? new FragmentError("unknown variable: bad")
      : formula(source) === "$q$"
        ? new FragmentError("unknown variable: q")
        : null;
  const { view, close } = mount(s, b);
  try {
    await waitFor(() => settled(view) && widgets(view).length === 4, 3000, "widgets");
    const [ee, block, x, w] = widgets(view);
    // Inline: a span holding the SVG on the baseline, in currentColor.
    assert.equal(ee.className, "lsp-lp-render lsp-lp-math");
    assert.equal(ee.tagName, "SPAN");
    const svg = ee.querySelector<SVGSVGElement>("span.tym-fragment > svg")!;
    assert.ok(svg, "the fragment element");
    assert.equal(svg.style.width, `${"$EE[X]$".length / 16}em`);
    assert.equal(svg.style.verticalAlign, `${-(24 - 16) / 16}em`);
    assert.equal(svg.querySelector("path")!.getAttribute("fill"), "currentColor");
    // Display alone on its line: a block over it, label included.
    assert.equal(block.className, "lsp-lp-render lsp-lp-math is-display is-block");
    assert.ok(block.querySelector("div.tym-fragment.is-display > svg"));
    // Display inside a line: a display widget in the line, its label hidden with it.
    assert.equal(x.className, "lsp-lp-render lsp-lp-math is-display");
    assert.ok(w.querySelector("svg"));
    const shown = text(view);
    for (const hidden of ["$EE[X]$", "Var(X)", "<eq:var>", "$ x $", "<eq:x>", "$w$"]) {
      assert.ok(!shown.includes(hidden), `${hidden} is rendered`);
    }
    // Typst rejects $bad$: source with a dotted underline. $q$ needs its block's `#let`: quiet.
    assert.deepEqual([...view.contentDOM.querySelectorAll(".lsp-lp-error")].map((el) => el.textContent), ["$bad$"]);
    assert.ok(shown.includes("$q$"));
    // Math in a statement stays source.
    assert.ok(shown.includes("#let f(x) = $x^2$"));
    assert.ok(!b.calls.some((c) => formula(c) === "$x^2$"), "never rendered");

    // Focused, the cursor reveals: right after the label of the block, the block's source
    // shows with its rendering below; right after an inline formula, that formula.
    view.focus();
    await sleep(40);
    const blockLine = view.state.doc.line(3);
    view.dispatch({ selection: { anchor: blockLine.to } });
    assert.ok(text(view).includes("$ Var(X) = EE[X^2] $ <eq:var>"));
    const below = view.contentDOM.querySelector(".lsp-lp-render.is-below")!;
    assert.ok(below.querySelector("svg"), "the rendering below the source");
    const eeEnd = s.indexOf("$EE[X]$") + "$EE[X]$".length;
    view.dispatch({ selection: { anchor: eeEnd } });
    assert.ok(text(view).includes("期望 $EE[X]$ 与"));
    assert.ok(!text(view).includes("<eq:var>"), "the block renders again");
    // The label end of an inline display formula reveals it (the label is in its range).
    const xLabelEnd = s.indexOf("<eq:x>") + "<eq:x>".length;
    view.dispatch({ selection: { anchor: xLabelEnd } });
    assert.ok(text(view).includes("$ x $ <eq:x>"));
  } finally {
    close();
  }
});

test("T-T5 live: the statements above a formula are in its key; a formula keeps its rendering while they change", async () => {
  const s = ["$x + y$ first.", "#let y = 2", "$x + y$ second.", "$z$ third."].join("\n");
  const b = backend();
  const { view, close } = mount(s, b);
  try {
    await waitFor(() => settled(view) && widgets(view).length === 3, 3000, "widgets");
    // The same formula under different statements: two renders, one with the #let.
    const xy = b.calls.filter((c) => formula(c) === "$x + y$");
    assert.equal(xy.length, 2);
    assert.deepEqual(xy.map((c) => c.includes("#let y = 2")).sort(), [false, true]);

    // Edit the statement: only the formulas below it render again, and they keep their
    // rendering until the new one lands (no flash of source).
    let open!: () => void;
    b.gate = new Promise((r) => (open = r));
    const n = b.calls.length;
    const at = s.indexOf("2\n$x + y$ second");
    view.dispatch({ changes: { from: at, to: at + 1, insert: "3" }, userEvent: "input.type" });
    await sleep(30);
    assert.equal(widgets(view).length, 3, "still rendered while pending");
    b.gate = null;
    open();
    await waitFor(() => settled(view) && b.calls.length === n + 2, 3000, "re-render");
    await sleep(30);
    const again = b.calls.slice(n).map(formula).sort();
    assert.deepEqual(again, ["$x + y$", "$z$"], "the formula above is not rendered again");
    assert.ok(b.calls.slice(n).every((c) => c.includes("#let y = 3")));
    assert.equal(widgets(view).length, 3);

    // A statement being typed that breaks the preamble: the formulas below keep their last
    // rendering (the error is the statement's, not theirs).
    b.fail = (source) => {
      const line = source.split("\n").findIndex((l) => l === "#let y =");
      return line < 0 ? null : new FragmentError("expected expression", line + 1);
    };
    const three = view.state.doc.toString().indexOf("3\n$x + y$ second");
    view.dispatch({ changes: { from: three - 1, to: three + 1 }, userEvent: "delete" });
    assert.ok(view.state.doc.toString().includes("#let y =\n"));
    await waitFor(() => settled(view), 3000, "broken statement");
    await sleep(30);
    assert.equal(widgets(view).length, 3, "the last renderings stay");
    assert.equal(view.contentDOM.querySelector(".lsp-lp-error"), null);
  } finally {
    close();
  }
});

test("T-T5 live: another .typ file's change renders again; the file's own save does not; failures of the renderer retry", async () => {
  const s = "Text $a$ and $b$.\n";
  const b = backend();
  b.fail = () => new Error("tinymist binary not found");
  const { view, render, close } = mount(s, b);
  try {
    await waitFor(() => settled(view) && b.calls.length === 2, 3000, "failed renders");
    await sleep(30);
    assert.equal(widgets(view).length, 0, "no renderer: source");
    assert.equal(view.contentDOM.querySelector(".lsp-lp-error"), null, "quietly");
    // A settings save or switching live mode on retries them.
    b.fail = () => null;
    render.retryFailed();
    await waitFor(() => widgets(view).length === 2, 3000, "retried");
    const n = b.calls.length;
    render.retryFailed(); // nothing failed since: nothing to do
    render.fileChanged(FILE, "modify"); // the file's own autosave
    await sleep(400);
    assert.equal(b.calls.length, n, "its own save keeps its renders");
    render.fileChanged(join(BOOK, "template.typ"), "modify"); // a file its preamble reads
    await waitFor(() => b.calls.length === n + 2 && settled(view), 3000, "epoch");
    await sleep(30);
    assert.equal(widgets(view).length, 2);
  } finally {
    close();
  }
});

test("T-T5 live: an edit above two occurrences of one formula keeps each its own rendering", async () => {
  // The same source above and below a #let renders differently (the fake draws a formula
  // under `#let y = 2` 99pt wide); each keeps its own rendering while a statement typed
  // above both is pending, and while it is broken.
  const s = ["$x + y$ first.", "#let y = 2", "$x + y$ second."].join("\n");
  const b = backend();
  const plain = b.render;
  b.render = async (dir, source) => {
    const svg = await plain(dir, source);
    return source.includes("#let y = 2") ? svg.replace(/width="\d+pt"/, 'width="99pt"') : svg;
  };
  const { view, close } = mount(s, b);
  const widths = () => widgets(view).map((w) => w.querySelector("svg")!.style.width);
  try {
    await waitFor(() => settled(view) && widgets(view).length === 2, 3000, "widgets");
    const own = widths();
    assert.notEqual(own[0], own[1], "the two occurrences render differently");
    let open!: () => void;
    b.gate = new Promise((r) => (open = r));
    view.dispatch({ changes: { from: 0, insert: "#let z = 1\n" }, userEvent: "input.type" });
    await sleep(30);
    assert.deepEqual(widths(), own, "pending: each its own last rendering");
    b.gate = null;
    open();
    await waitFor(() => settled(view), 3000, "re-render");
    b.fail = (source) => {
      const line = source.split("\n").findIndex((l) => l === "#let a =");
      return line < 0 ? null : new FragmentError("expected expression", line + 1);
    };
    view.dispatch({ changes: { from: 0, insert: "#let a =\n" }, userEvent: "input.type" });
    await waitFor(() => settled(view), 3000, "broken statement");
    await sleep(30);
    assert.deepEqual(widths(), own, "broken above: each its own last rendering");
    // Broken between the two as well: the one below keeps its own, not the one above's.
    b.fail = (source) => (source.includes("#let a =\n") ? new FragmentError("expected expression", 1) : null);
    const between = view.state.doc.toString().indexOf("$x + y$ second.");
    view.dispatch({ changes: { from: between, insert: "#let b =\n" }, userEvent: "input.type" });
    await waitFor(() => settled(view), 3000, "broken between");
    await sleep(30);
    assert.deepEqual(widths(), own);
  } finally {
    close();
  }
});

test("T-T5 live: a formula keeps its last rendering in a long chapter, whatever the other views render", async () => {
  // More formulas than a view remembers at least (2000): typing a statement at the top keeps
  // the renderings in view while their new renders are pending; another view's formulas
  // take nothing from this view's memory.
  const s = Array.from({ length: 2100 }, (_, i) => `Line $x_(${i})$.`).join("\n");
  const b = backend();
  const { view, render, close } = mount(s, b);
  const other = mount(Array.from({ length: 2100 }, (_, i) => `$y_(${i})$`).join("\n"), b, { render, file: join(BOOK, "notes", "other.typ") });
  let open = () => {};
  try {
    await waitFor(() => settled(view) && settled(other.view) && b.calls.length === 4200, 30000, "all rendered");
    await sleep(30);
    const shown = widgets(view).length;
    assert.ok(shown > 20, `widgets in view: ${shown}`);
    assert.ok(!text(view).includes("$x_("), "every formula in view renders");
    b.gate = new Promise((r) => (open = r));
    view.dispatch({ changes: { from: 0, insert: "#let zz = 1\n" }, userEvent: "input.type" });
    await sleep(30);
    assert.ok(!text(view).includes("$x_("), "the renderings in view stay while pending");
    assert.ok(widgets(view).length >= shown - 1);
  } finally {
    b.gate = null;
    open();
    other.close();
    close();
  }
});

test("T-T5 live: a chapter's autosave leaves the other open chapters alone; a template change renders them again", async () => {
  const b = backend();
  const render = new TypstRender(b, ROOT);
  const CH2 = join(BOOK, "chapters", "ch2.typ");
  const one = mount(read(CH1), b, { render, file: CH1 });
  const two = mount(read(CH2), b, { render, file: CH2 });
  try {
    const all = () => widgets(one.view).length === 7 && widgets(two.view).length === 5;
    await waitFor(() => settled(one.view) && settled(two.view) && all(), 3000, "widgets");
    const n = b.calls.length;
    // ch1's own save at a typing pause: ch2 never reads it (the book main includes both).
    render.fileChanged(CH1, "modify");
    const counts = new Set<number>();
    for (let t = 0; t < 450; t += 5) {
      counts.add(widgets(two.view).length).add(widgets(one.view).length);
      await sleep(5);
    }
    assert.deepEqual([...counts].sort(), [5, 7], "no flash of source");
    assert.equal(b.calls.length, n, "nothing rendered again");
    // The template both chapters import: both render again.
    render.fileChanged(join(BOOK, "template.typ"), "modify");
    await waitFor(() => b.calls.length === n + 12 && settled(one.view) && settled(two.view), 3000, "re-render");
    await waitFor(all, 3000, "widgets again");
  } finally {
    one.close();
    two.close();
    render.dispose();
  }
});

test("T-T5 live: a broken template keeps the last renderings; formulas never rendered show the failure", async () => {
  const b = backend();
  const { view, render, close } = mount(read(CH1), b, { file: CH1 });
  try {
    await waitFor(() => settled(view) && widgets(view).length === 7, 3000, "widgets");
    const n = b.calls.length;
    // An autosave caught the template half-typed: Typst's error is in the template, at the
    // preamble's import of it (typstExportError: the trace's line 1).
    b.fail = () => new FragmentError("unclosed delimiter (book/template.typ:9)", 1);
    render.fileChanged(join(BOOK, "template.typ"), "modify");
    await waitFor(() => b.calls.length === n + 7 && settled(view), 3000, "re-render");
    await sleep(30);
    assert.equal(widgets(view).length, 7, "the last renderings stay");
    assert.equal(view.contentDOM.querySelector(".lsp-lp-error"), null, "no formula is blamed");
    // A formula typed meanwhile has no last rendering: its source, underlined (the hover
    // shows the template's error at the import).
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nNew $q$ here.\n" }, userEvent: "input.type" });
    await waitFor(() => settled(view), 3000, "new formula");
    await sleep(30);
    assert.deepEqual(shownIn(view, ".lsp-lp-error"), ["$q$"]);
    b.fail = () => null;
    render.fileChanged(join(BOOK, "template.typ"), "modify");
    await waitFor(() => settled(view) && widgets(view).length === 8, 3000, "fixed");
  } finally {
    close();
  }
});

test("T-T5 live: a render the renderer failed (a slow start) is tried again when the renderer answers", async () => {
  const b = backend();
  let cold = true;
  b.fail = () => {
    if (!cold) return null;
    cold = false;
    return new Error("rendering took longer than 5 s");
  };
  const { view, close } = mount("First $a$ then $b$ and $c$.\n", b);
  try {
    await waitFor(() => settled(view) && widgets(view).length === 3, 3000, "all three render");
    assert.equal(view.contentDOM.querySelector(".lsp-lp-error"), null);
  } finally {
    close();
  }
});

test("T-T5 live: the key arbiter stays first; switching modes keeps the document, selection and undo history", async () => {
  const s = "Text $a$.\n$ b $\n";
  const b = backend();
  const { view, close } = mount(s, b, { focus: true, anchor: 0 });
  try {
    await waitFor(() => widgets(view).length === 2, 3000, "widgets");
    view.dispatch({ changes: { from: 0, insert: "More " }, userEvent: "input.type" });
    view.dispatch({ selection: EditorSelection.single(2, 4) });
    const doc = view.state.doc;
    view.dispatch({ effects: livePreviewCompartment.reconfigure([]) });
    assert.equal(isLive(view.state), false);
    assert.equal(widgets(view).length, 0);
    assert.equal(view.state.doc, doc);
    assert.deepEqual([view.state.selection.main.anchor, view.state.selection.main.head], [2, 4]);
    assert.equal(undoDepth(view.state), 1);
  } finally {
    close();
  }
});

// ---- T-T6 text constructs ------------------------------------------------------------------

/** A construct as a test compares it: its kind, source and what it shows. */
function describe(s: string, c: TypstConstruct): string {
  const text = JSON.stringify(s.slice(c.from, c.to));
  switch (c.kind) {
    case "math":
      return `math ${text}${c.block ? " block" : ""}`;
    case "heading":
      return `h${c.level} ${text} hides ${JSON.stringify(s.slice(c.from, c.markerTo))}`;
    case "item":
      return `item ${text} ${c.marker}`;
    case "term":
      return `term ${text} ${JSON.stringify(s.slice(c.termFrom, c.termTo))}`;
    case "ref":
      return `ref ${text} ${c.key}${c.supplement === null ? "" : ` [${c.supplement}]`}`;
    case "label":
      return `label ${text} ${c.key}`;
    default:
      return `${c.kind} ${text}`;
  }
}

test("T-T6 scan: headings, strong/emph, lists, references and labels, as Typst parses them", () => {
  const s = [
    '#import "../template.typ": *',
    "= Intro <sec:intro>",
    "== Sub *bold* title",
    "  === Indented",
    "==NoSpace and a = b",
    "Some *strong* and _emph_; 2*3 = 6, snake_case, *bold*text and x* here.",
    "中*粗体*字 and _强调_。 *a $x*y$ b* and _see @r, too_.",
    "*unclosed and _also",
    "- one",
    "  - two",
    "    - three",
    "- four",
    "+ first",
    "",
    "+ second",
    "// a comment",
    "#let x = 1",
    "+ third",
    "text at zero",
    "+ again",
    "7. seven",
    "+ eight",
    "  - under an enum",
    "/ Term: its description",
    "/ Colon $a: b$ inside: desc",
    "/ no colon here",
    "See @fig:a. and @thm:b[Theorem] and <lbl>, `@raw <raw> *raw*` // @comment *c*",
    "#let s = [*code* @code <code>]",
    "#f(x, [*arg* @arg])[*body* @body]",
    "#box[- in box] https://x.com/a_b_c/@user_x_ and _after_.",
    "$ a_b * c $ <eq:x>",
    "/* _block_ */ a < b and <3 and @ alone",
    "#theorem[",
    "  + inner",
    "  + block",
    "]",
    "#block[= In block]",
    "  + a",
    "+ b",
    "+ x",
    "  + y",
    " + z",
  ].join("\n");
  assert.deepEqual(
    scanTypstText(s).map((c) => describe(s, c)),
    [
      'h1 "= Intro <sec:intro>" hides "= "',
      'label "<sec:intro>" sec:intro',
      'h2 "== Sub *bold* title" hides "== "',
      'strong "*bold*"',
      'h3 "=== Indented" hides "=== "',
      // No space after the marker: text. `2*3` and `snake_case` are words; `*bold*text`
      // closes at the next delimiter outside a word.
      'strong "*strong*"',
      'emph "_emph_"',
      'strong "*bold*text and x*"',
      // CJK characters are no word characters; math and references are passed over.
      'strong "*粗体*"',
      'emph "_强调_"',
      'strong "*a $x*y$ b*"',
      'math "$x*y$"',
      'emph "_see @r, too_"',
      'ref "@r" r',
      // Unclosed on its line: nothing.
      // Bullets by depth; `+` after a `-` run at the same indentation starts a new run;
      // blank, comment and `#let` lines keep it; text at its indentation ends it; an
      // explicit number sets the count.
      'item "-" •',
      'item "-" ‣',
      'item "-" –',
      'item "-" •',
      'item "+" 1.',
      'item "+" 2.',
      'item "+" 3.',
      'item "+" 1.',
      'item "+" 8.',
      'item "-" •', // list depth counts lists only
      'term "/ Term:" "Term"',
      'term "/ Colon $a: b$ inside:" "Colon $a: b$ inside"',
      'math "$a: b$"',
      // A trailing `.` is text; a supplement belongs to its reference; raw text, comments,
      // statements and call arguments hold no constructs.
      'ref "@fig:a" fig:a',
      'ref "@thm:b[Theorem]" thm:b [Theorem]',
      'label "<lbl>" lbl',
      'strong "*body*"',
      'ref "@body" body',
      // A content block may open with a list marker; nothing in a link is markup.
      'item "-" •',
      'emph "_after_"',
      'math "$ a_b * c $ <eq:x>" block',
      // Not labels: `a < b`, `<3`; not a reference: `@ alone`.
      'item "+" 1.',
      'item "+" 2.',
      // A content block may open with a heading. Items are one run when siblings, whatever
      // their indentation: `+ b` ends the body of the deeper `+ a` and follows it, and `+ z`
      // follows `+ y` inside `+ x`.
      'h1 "= In block" hides "= "',
      'item "+" 1.',
      'item "+" 2.',
      'item "+" 3.',
      'item "+" 1.',
      'item "+" 2.',
    ],
  );
});

const lineTexts = (view: EditorView) => [...view.contentDOM.querySelectorAll(".cm-line")].map((l) => l.textContent);
const shownIn = (view: EditorView, selector: string) =>
  [...view.contentDOM.querySelectorAll<HTMLElement>(selector)].map((el) => el.textContent);

test("scan: calls in markup for the paper hover (a content body, #figure, #image; at most 4,000 characters)", () => {
  const s = [
    '#let thm(body) = block[#body]',
    '#show: thm',
    "#theorem(title: [T])[",
    "  Body $x$ with #figure(image(\"a.png\"), caption: [#emph[c]]) inside.",
    "]",
    "#h(1em) #box[b] #thm.with(x: 1)[w] #image(\"b.png\") #f(1)",
    "$#box[m]$ `#raw[r]` // #comment[c]",
    "#if true [#strong[k]] #{ box[code] }",
    `#box[${"x".repeat(4000)}]`,
    "#strong[open",
  ].join("\n");
  const doc = Text.of(s.split("\n"));
  const at = (needle: string, offset = 1) => {
    const c = typstCallAt(doc, s.indexOf(needle) + offset);
    return c && `${c.name}${c.content ? "[]" : ""}: ${s.slice(c.from, c.nameTo)}`;
  };
  assert.equal(at("#theorem", 0), "theorem[]: #theorem", "at its #");
  assert.equal(at("#theorem", 8), "theorem[]: #theorem", "at the end of its name");
  assert.equal(at("#theorem", 9), null, "its arguments are not its name");
  assert.equal(at("#figure"), "figure: #figure", "inside a content block");
  assert.equal(at("#emph"), null, "in an argument: code, not markup");
  assert.equal(at("#box[b]"), "box[]: #box");
  assert.equal(at("#thm.with"), "thm.with[]: #thm.with");
  assert.equal(at("#image(\"b"), "image: #image");
  assert.equal(at("#h(1em)"), null, "no content body");
  assert.equal(at("#f(1)"), null);
  assert.equal(at("#let"), null, "a statement");
  assert.equal(at("#show"), null);
  assert.equal(at("#box[m]"), null, "in math");
  assert.equal(at("#raw"), null, "in raw text");
  assert.equal(at("#comment"), null, "in a comment");
  assert.equal(at("#strong[k]"), null, "in a keyword expression");
  assert.equal(at("box[code]", 0), null, "in a code block");
  assert.equal(at("#box[xx"), null, "past 4,000 characters");
  assert.equal(at("#strong[open"), null, "unclosed");
  const theorem = typstCallAt(doc, s.indexOf("#theorem"))!;
  assert.equal(s.slice(theorem.from, theorem.to), s.slice(s.indexOf("#theorem"), s.indexOf("]\n#h") + 1));
});

test("scan: nesting deeper than the scanner looks into stays source, and never overflows the stack", () => {
  const depth = 20000;
  const deep = `${"#[".repeat(depth)}$deep$${"]".repeat(depth)}`;
  const s = ["#let a = 1", "#[#[#[$shallow$]]]", deep, "$after$", `*${"_*".repeat(3000)}x*`].join("\n");
  const found = formulas(scanTypstText(s)).map((c) => c.body);
  assert.deepEqual(found, ["$shallow$", "$after$"], "the formula 20,000 blocks down stays source");
  assert.deepEqual(topLevelStatements(s).map((t) => t.text), ["#let a = 1"]);
  const doc = Text.of(s.split("\n"));
  assert.equal(typstMathAt(doc, s.indexOf("$after$") + 1)?.body, "$after$");
  assert.equal(typstCallAt(doc, s.indexOf("#[#[#[$sh")), null);
});

test("scan: unclosed content blocks on many lines scan in linear time", () => {
  // Each unclosed `#box[` ends at its line; unmemoized, the ones below were scanned again for
  // each one above (2^18 times the last here: seconds; now a few ms).
  const open = Array.from({ length: 18 }, (_, i) => `第 ${i} 行文字 #box[ 未闭合的内容块 $x_${i}$ 以及更多文字。`);
  const s = ["#let a = 1", ...open, ...Array.from({ length: 200 }, (_, i) => `正常的一行 ${i}，公式 $y_${i}$。`), "$after$"].join("\n");
  const t0 = performance.now();
  const found = formulas(scanTypstText(s)).map((c) => c.body);
  const statements = topLevelStatements(s).map((t) => t.text);
  const ms = performance.now() - t0;
  assert.equal(found.length, 201, "the formulas after the unclosed lines render");
  assert.equal(found.at(-1), "$after$");
  assert.deepEqual(statements, ["#let a = 1"]);
  assert.ok(ms < 1000, `scanned in ${ms.toFixed(0)} ms`);
  // An unclosed group inside a closed one ends at its line, as in Typst (the `]` closes it).
  const t = "#theorem[\n  Let #f(a, b\n] and $z$";
  assert.deepEqual(formulas(scanTypstText(t)).map((c) => c.body), ["$z$"]);
  assert.equal(typstCallAt(Text.of(t.split("\n")), 1)?.to, t.indexOf("] and") + 1);
});

test("T-T6 live: text constructs are styled with their markup hidden, which shows where the cursor is", async () => {
  const s = [
    "= Title <sec:t>",
    "Text *strong* and _emph_ with @sec:t and @sec:t[Section].",
    "- one",
    "  - two",
    "+ first",
    "+ second",
    "/ Term: description",
    "`*raw*` and #let x = [*code* @code]",
  ].join("\n");
  const { view, close } = mount(s, backend());
  try {
    const L = (n: number) => view.state.doc.line(n);
    // Unfocused, everything is styled.
    assert.deepEqual(lineTexts(view), [
      "Title sec:t",
      "Text strong and emph with @sec:t and Section @sec:t.",
      "• one",
      "  ‣ two",
      "1. first",
      "2. second",
      "Term description",
      "`*raw*` and #let x = [*code* @code]",
    ]);
    const first = view.contentDOM.querySelector(".cm-line")!;
    assert.ok(first.classList.contains("lsp-lp-h1"), "the heading's line class");
    assert.deepEqual(shownIn(view, ".lsp-lp-strong"), ["strong", "Term"]);
    assert.deepEqual(shownIn(view, ".lsp-lp-em"), ["emph"]);
    assert.deepEqual(shownIn(view, ".lsp-lp-bullet"), ["•", "‣", "1.", "2."]);
    assert.deepEqual(shownIn(view, ".lsp-lp-chip.is-label"), ["sec:t"]);
    const refs = [...view.contentDOM.querySelectorAll<HTMLElement>(".lsp-lp-chip.is-ref")];
    assert.deepEqual(refs.map((el) => [el.textContent, el.title]), [
      ["@sec:t", "@sec:t"],
      ["Section @sec:t", "@sec:t[Section]"],
    ]);

    view.focus();
    await sleep(40);
    const at = (pos: number) => {
      view.dispatch({ selection: { anchor: pos } });
      return lineTexts(view);
    };
    // A heading's marker shows while the cursor is on its line; the label while it is touched.
    assert.equal(at(L(1).from + 4)[0], "= Title sec:t");
    assert.equal(at(L(1).to)[0], "= Title <sec:t>");
    assert.equal(at(L(8).to)[0], "Title sec:t");
    // Strong, emphasis and references while touched, inclusively.
    const strongEnd = s.indexOf("*strong*") + "*strong*".length;
    assert.equal(at(strongEnd)[1], "Text *strong* and emph with @sec:t and Section @sec:t.");
    assert.equal(at(s.indexOf("_emph_"))[1], "Text strong and _emph_ with @sec:t and Section @sec:t.");
    assert.equal(at(s.indexOf("t[Section]") + 1)[1], "Text strong and emph with @sec:t and @sec:t[Section].");
    // A list marker only while the marker itself is touched: the bullet stays while the
    // item is typed.
    assert.equal(at(L(3).from + 2)[2], "• one");
    assert.equal(at(L(3).from + 1)[2], "- one");
    assert.equal(at(L(4).from)[3], "  ‣ two");
    assert.equal(at(L(4).from + 2)[3], "  - two");
    assert.equal(at(L(5).to)[4], "1. first");
    // A term shows its markup while the cursor is on `/ Term:`.
    assert.equal(at(L(7).to)[6], "Term description");
    assert.equal(at(L(7).from + 4)[6], "/ Term: description");
  } finally {
    close();
  }
});

test("T-T6 live: a construct holding an error diagnostic shows its source", async () => {
  const s = "See @missing here.\n= Heading\nnext";
  const { view, close } = mount(s, backend());
  try {
    assert.deepEqual(lineTexts(view), ["See @missing here.", "Heading", "next"]);
    assert.equal(shownIn(view, ".lsp-lp-chip").length, 1);
    const from = s.indexOf("@missing");
    setTypingDiagnostics(view, [{ from, to: from + 8, severity: "error", message: "label `<missing>` does not exist" }]);
    assert.equal(shownIn(view, ".lsp-lp-chip").length, 0, "the reference's source and its underline");
    setTypingDiagnostics(view, [{ from, to: from + 8, severity: "warning", message: "style" }]);
    assert.equal(shownIn(view, ".lsp-lp-chip").length, 1, "warnings do not keep the source");
    const heading = s.indexOf("= Heading");
    setTypingDiagnostics(view, [{ from: heading + 2, to: heading + 9, severity: "error", message: "x" }]);
    assert.equal(lineTexts(view)[1], "= Heading");
    setTypingDiagnostics(view, []);
    assert.deepEqual(lineTexts(view), ["See @missing here.", "Heading", "next"]);
  } finally {
    close();
  }
});

test("T-T6 live: a supplement's chip shows its text without markup", () => {
  const { view, close } = mount("See @a[*Fig*], @b[snake_case], @c[_it_ \\* x], @d[`raw`] and @e[@f].", backend());
  try {
    const refs = [...view.contentDOM.querySelectorAll<HTMLElement>(".lsp-lp-chip.is-ref")];
    assert.deepEqual(
      refs.map((el) => [el.textContent, el.title]),
      [
        ["Fig @a", "@a[*Fig*]"],
        ["snake_case @b", "@b[snake_case]"],
        ["it * x @c", "@c[_it_ \\* x]"],
        ["@d", "@d[`raw`]"],
        ["@e", "@e[@f]"],
      ],
    );
  } finally {
    close();
  }
});

test("T-T6 live: selection moves re-decorate text constructs exactly as a full build does", async () => {
  const lines: string[] = [];
  for (let i = 0; i < 6; i++) {
    lines.push(
      `== Section ${i} <sec:${i}>`,
      `Text *bold ${i}* and _it_ with $x_${i}$, @sec:${i} and @eq:${i}[Eq].`,
      "- item",
      "  - nested *strong*",
      "+ one",
      "+ two $y$",
      "/ Term: text",
      `$ z_${i} $ <eq:${i}>`,
      "",
    );
  }
  const b = backend();
  const { view, close } = mount(lines.join("\n"), b);
  try {
    // 13 formulas: the six `$y$` are one (the same statements above them).
    await waitFor(() => settled(view) && b.calls.length === 13, 3000, "formulas");
    view.focus();
    await sleep(40);
    // What the view draws: the field's sets and the one-line replacements near the viewport.
    const sets = () => view.state.facet(EditorView.decorations).map((d) => (typeof d === "function" ? d(view) : d));
    let seed = 11;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
    const { doc } = view.state;
    // Half at line starts: the edges of the lines a construct may test.
    const pos = () => (rand(2) === 0 ? doc.line(1 + rand(doc.lines)).from : rand(doc.length + 1));
    let patched = 0;
    for (let i = 0; i < 150; i++) {
      const a = pos();
      const ranges = [EditorSelection.range(a, rand(4) === 0 ? pos() : a)];
      if (rand(5) === 0) ranges.push(EditorSelection.cursor(pos()));
      const builds = renderStats(view).builds;
      view.dispatch({ selection: EditorSelection.create(ranges) });
      if (renderStats(view).builds > builds) patched++;
      const after = sets();
      view.dispatch({ effects: refreshLive.of(null) }); // a full build of the same state
      assert.ok(RangeSet.eq(after, sets()), `decorations after move ${i}`);
    }
    assert.ok(patched > 50, `moves that re-decorated: ${patched}`);
    assert.equal(b.calls.length, 13, "moves render nothing new");
  } finally {
    close();
  }
});

test("T-T6 keys: Tab, Shift-Tab, Enter, Escape and Backspace next to styled constructs act as in source mode", async () => {
  const s = [
    "= Title <sec:t>",
    "Text *strong* and _emph_ with @sec:t[Sec].",
    "- one",
    "  - two",
    "+ first",
    "/ Term: description",
    "",
  ].join("\n");
  const b = backend();
  const live = mount(s, b);
  const source = new EditorView({
    state: EditorState.create({
      doc: s,
      extensions: typstEditorExtensions({ completion: { triggerCharacters: () => [], request: async () => null } }, s),
    }),
    parent: document.body,
  });
  try {
    live.view.focus();
    await sleep(40);
    const reset = (view: EditorView, pos: number) =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: s }, selection: { anchor: pos } });
    const outcome = (view: EditorView) => {
      const { anchor, head } = view.state.selection.main;
      return `${JSON.stringify(view.state.doc.toString())} ${anchor}-${head}`;
    };
    let styled = 0;
    for (let pos = 0; pos <= s.length; pos++) {
      for (const key of ["Tab", "Shift-Tab", "Enter", "Escape", "Backspace"]) {
        reset(live.view, pos);
        reset(source, pos);
        if (key === "Tab" && live.view.contentDOM.querySelector(".lsp-lp-bullet, .lsp-lp-chip")) styled++;
        const a = press(live.view, key);
        const b2 = press(source, key);
        assert.equal(outcome(live.view), outcome(source), `${key} at ${pos}`);
        assert.deepEqual(a, b2, `${key} at ${pos}: handled the same`);
      }
    }
    assert.ok(styled > s.length / 2, "most positions have styled constructs around");
    // Enter continues a list: the new item's bullet renders while its text is typed.
    reset(live.view, s.indexOf("- one") + "- one".length);
    press(live.view, "Enter");
    assert.deepEqual(lineTexts(live.view).slice(2, 5), ["• one", "• ", "  ‣ two"]);
    press(live.view, "Tab");
    assert.deepEqual(lineTexts(live.view).slice(2, 5), ["• one", "  ‣ ", "  ‣ two"]);
    reset(live.view, s.indexOf("+ first") + "+ first".length);
    press(live.view, "Enter");
    assert.deepEqual(lineTexts(live.view).slice(4, 6), ["1. first", "2. "]);
  } finally {
    live.close();
    source.destroy();
  }
});

// ---- against a real tinymist ---------------------------------------------------------------

/** Every file below `dir`, as paths relative to it. */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .sort();
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("live mode on the synthetic book against a real tinymist", { skip: !BIN && "tinymist not found", timeout: 60000 }, async (t) => {
  const vault = mkdtempSync(join(tmpdir(), "tinymist-live-preview-"));
  cpSync(BOOK, join(vault, "book"), { recursive: true });
  const before = files(vault);
  const debug = console.debug;
  console.debug = () => {}; // the client forwards tinymist's stderr log here
  const fragments = new TypstFragmentRenderer({ bin: () => BIN!, root: vault });
  const render = new TypstRender(fragments, vault);
  const views: EditorView[] = [];
  let pid: number | null = null;
  try {
    for (const [chapter, inline, blocks] of [
      ["ch1.typ", 5, 2],
      ["ch2.typ", 4, 1],
    ] as const) {
      const path = join(vault, "book", "chapters", chapter);
      const source = read(path);
      const renderer = new TypstLiveRenderer(render, path, () => document);
      const view = new EditorView({
        state: EditorState.create({
          doc: source,
          extensions: typstEditorExtensions(
            {
              completion: { triggerCharacters: () => [], request: async () => null },
              live: livePreview({ language: typstLiveLanguage(), renderer }),
            },
            source,
          ),
        }),
        parent: document.body,
      });
      views.push(view);
      const t0 = Date.now();
      await waitFor(() => settled(view) && widgets(view).length === inline + blocks, 30000, `${chapter} widgets`);
      const ms = Date.now() - t0;
      pid ??= fragments.pid;
      const all = widgets(view);
      assert.equal(all.filter((w) => w.classList.contains("is-block")).length, blocks, chapter);
      for (const w of all) {
        const svg = w.querySelector<SVGSVGElement>(".tym-fragment > svg")!;
        assert.ok(svg, `${chapter}: an SVG in every widget`);
        assert.ok(parseFloat(svg.style.width) > 0 && parseFloat(svg.style.height) > 0);
        assert.ok(svg.querySelector('[fill="currentColor"], [stroke="currentColor"]'), "ink in currentColor");
      }
      assert.equal(view.contentDOM.querySelector(".lsp-lp-error"), null, `${chapter}: every formula renders`);
      const stats = renderStats(view);
      assert.equal(stats.renders, inline + blocks);
      t.diagnostic(`${chapter}: ${inline + blocks} widgets in ${ms} ms (render p50 ${stats.p50} ms, p95 ${stats.p95} ms)`);
    }
    // Aliases from the template through the chapter's import (EE, PP, RR, Var, given).
    assert.equal(files(vault).join("\n"), before.join("\n"), "nothing written to the vault");
  } finally {
    for (const view of views) view.destroy();
    render.dispose();
    fragments.dispose();
    if (pid !== null) await waitFor(() => !alive(pid!), 5000, "renderer exit");
    await sleep(50); // its last log lines
    console.debug = debug;
    rmSync(vault, { recursive: true, force: true });
  }
});
