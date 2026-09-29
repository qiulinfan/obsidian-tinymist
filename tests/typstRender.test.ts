// The Typst render hover (src/editor/typstRender.ts) on the real editor stack with a fake
// fragment backend that answers in the shape of tinymist's SVG export: the section above
// tinymist's hover, the SVG on the baseline in currentColor, errors, and the render cache
// with its invalidation. The fixture book (tests/fixtures/book) supplies the preamble; the
// real renderer process is covered by tests/fragmentRenderer.test.ts.
import "./support/dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { EditorState, Extension, Text } from "@codemirror/state";
import { EditorView, closeHoverTooltips, hoverTooltip } from "@codemirror/view";
import { typstEditorExtensions } from "../src/editor/typstEditor";
import { typstMathAt } from "../src/editor/typstFragment";
import { FragmentBackend, TypstRender, typstRenderHover } from "../src/editor/typstRender";
import { FragmentError } from "../src/lsp/fragmentRenderer";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ROOT = resolve("tests/fixtures");
const CH1 = join(ROOT, "book", "chapters", "ch1.typ");
const CH1_TEXT = readFileSync(CH1, "utf8");

/**
 * A page like tinymist's for `source`: 1pt wide per character of the formula, the
 * baseline marker for inline math, the ink colour on a glyph and a rule.
 */
function page(source: string): string {
  const body = source.slice(source.lastIndexOf("$", source.length - 3)).trimEnd().length;
  const inline = source.includes('fill: rgb("#010203")');
  return [
    `<svg viewBox="0 0 ${body} 24" width="${body}pt" height="24pt" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`,
    inline ? '<g transform="translate(0 16)"><path fill="#010203" fill-rule="nonzero" d="M 0 0v 0.1h 0.1v -0.1Z "/></g>' : "",
    '<g transform="matrix(1 0 0 -1 0 16)"><use xlink:href="#g1" fill="#0a0b0c"/></g><path stroke="#0a0b0c" d="M 0 5 L 9 5"/>',
    '<defs><symbol id="g1" overflow="visible"><path d="M 0 0"/></symbol></defs></svg>',
  ].join("");
}

function fakeBackend(fail?: (source: string) => Error | null) {
  const calls: { dir: string; source: string }[] = [];
  const backend: FragmentBackend = {
    async render(dir, source) {
      calls.push({ dir, source });
      const err = fail?.(source);
      if (err) throw err;
      return page(source);
    },
  };
  return { backend, calls };
}

/** tinymist's text hover (a signature) at any position, answered after a round trip. */
const tinymistHover: Extension = hoverTooltip(
  async (_view, pos) => {
    await sleep(15);
    return {
      pos,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "tym-hover";
        dom.textContent = "let EE = op";
        return { dom };
      },
    };
  },
  { hoverTime: 10 },
);

/** An editor on `text` (the file `path`) with the render hover above tinymist's. */
function editor(render: TypstRender, enabled: () => boolean, text = CH1_TEXT, path = CH1) {
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: typstEditorExtensions(
        {
          completion: { triggerCharacters: () => [], request: async () => null },
          hover: [typstRenderHover({ renderer: () => render, path: () => path, enabled }), tinymistHover],
        },
        text,
      ),
    }),
    parent: document.body,
  });
  /**
   * The pointer comes to rest on `needle`, through CodeMirror's mousemove path (jsdom has
   * no layout: the coordinate mapping is pinned), so a hover that another section's
   * arrival discards is asked again, as with a resting pointer.
   */
  const hoverAt = async (needle: string) => {
    view.dispatch({ effects: closeHoverTooltips });
    const pos = text.indexOf(needle) + 1;
    Object.assign(view, {
      posAtCoords: () => pos,
      coordsAtPos: () => ({ left: 10, right: 12, top: 0, bottom: 10 }),
    });
    const line = view.contentDOM.querySelector(".cm-line")!;
    line.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 11, clientY: 5 }));
    await sleep(380);
    const host = view.dom.querySelector(".cm-tooltip-hover");
    return host ? [...host.children] : [];
  };
  return { view, hoverAt };
}

const kind = (el: Element) =>
  el.classList.contains("lsp-render-hover") ? "render" : el.classList.contains("tym-hover") ? "tinymist" : el.className;

test("render hover: the formula's SVG above tinymist's hover, on the baseline, in currentColor", async () => {
  const { backend, calls } = fakeBackend();
  const render = new TypstRender(backend, ROOT);
  const { view, hoverAt } = editor(render, () => true);
  try {
    const sections = await hoverAt("EE[X] = integral");
    assert.deepEqual(sections.map(kind), ["render", "tinymist"]);
    const box = sections[0].querySelector(":scope > span.tym-fragment")!;
    const svg = box.querySelector("svg")!;
    const body = "$EE[X] = integral_Omega X dif PP$";
    assert.equal(svg.getAttribute("width"), null, "sized by style, in em");
    assert.equal(svg.style.width, `${body.length / 16}em`);
    assert.equal(svg.style.height, `${24 / 16}em`);
    assert.equal(svg.style.verticalAlign, `${-(24 - 16) / 16}em`, "the depth below the baseline");
    assert.ok(!svg.innerHTML.includes("#010203"), "marker stripped");
    assert.equal(svg.querySelectorAll('[fill="currentColor"], [stroke="currentColor"]').length, 2);
    assert.match(svg.querySelector("use")!.getAttribute("xlink:href")!, /^#f\w+-g1$/);

    // The chapter's folder, the book main's lines, the chapter's import, the frame.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dir, dirname(CH1));
    assert.ok(
      calls[0].source.startsWith(
        '#import "/book/template.typ": *\n#let meta = yaml("/book/meta.yaml")\n#set math.equation(numbering: "(1.1)")\n#import "../template.typ": *\n#set page(',
      ),
    );
    assert.ok(calls[0].source.endsWith(`fill: rgb("#010203"))))${body}\n`));

    const display = await hoverAt("Var(X) = EE");
    const block = display[0].querySelector(":scope > div.tym-fragment.is-display svg") as SVGSVGElement;
    assert.ok(block, "display math is a block");
    assert.equal(block.style.verticalAlign, "");

    assert.deepEqual((await hoverAt("期望写作")).map(kind), ["tinymist"], "outside math");
    assert.deepEqual((await hoverAt("`$x$`")).map(kind), ["tinymist"], "raw text");
  } finally {
    view.destroy();
    render.dispose();
  }
});

test("render hover: Typst's error with the formula, and nothing while the setting is off", async () => {
  let on = true;
  const { backend } = fakeBackend((s) =>
    s.includes("EE[abs(X)]") ? new FragmentError("unknown variable: abs") : s.includes("sum_(i=1)") ? new Error("tinymist binary not found") : null,
  );
  const render = new TypstRender(backend, ROOT);
  const { view, hoverAt } = editor(render, () => on);
  try {
    const [error] = await hoverAt("EE[abs(X)]");
    assert.equal(error.querySelector(".lsp-render-hover-message")?.textContent, "unknown variable: abs");
    assert.equal(error.querySelector(".lsp-render-hover-source")?.textContent, "$EE[abs(X)] < infinity$");
    const [missing] = await hoverAt("sum_(i=1)");
    assert.equal(missing.querySelector(".lsp-render-hover-message")?.textContent, "tinymist binary not found");
    on = false;
    assert.deepEqual((await hoverAt("EE[X] = integral")).map(kind), ["tinymist"]);
  } finally {
    view.destroy();
    render.dispose();
  }
});

test("TypstRender cache: one render per formula and preamble; another file's change drops it", async () => {
  let broken = false;
  const { backend, calls } = fakeBackend((s) =>
    s.includes("frac(1, $") ? new FragmentError("unclosed delimiter") : broken ? new Error("timed out") : null,
  );
  const render = new TypstRender(backend, ROOT);
  const doc = Text.of(CH1_TEXT.split("\n"));
  const at = (d: Text, needle: string) => typstMathAt(d, d.toString().indexOf(needle))!;
  const math = (needle: string, d = doc) => render.math(CH1, d, at(d, needle));
  try {
    await math("EE[X] = integral");
    await math("EE[X] = integral");
    assert.equal(calls.length, 1, "a hit");
    // An edit elsewhere in the buffer leaves the key alone; a new statement above changes it.
    await math("EE[X] = integral", Text.of((CH1_TEXT + "\nmore text").split("\n")));
    assert.equal(calls.length, 1);
    await math("EE[X] = integral", Text.of(("#let extra = 1\n" + CH1_TEXT).split("\n")));
    assert.equal(calls.length, 2, "the chapter part is in the key");

    // Saving the chapter itself keeps its renders and its epoch (an autosave at every
    // typing pause); other files' renders are dropped. A template change drops them all.
    const CH2 = join(ROOT, "book", "chapters", "ch2.typ");
    const [epoch1, epoch2] = [render.epoch(CH1), render.epoch(CH2)];
    render.fileChanged(CH1);
    await sleep(350);
    await math("EE[X] = integral");
    assert.equal(calls.length, 2);
    assert.deepEqual([render.epoch(CH1), render.epoch(CH2)], [epoch1, epoch2 + 1]);
    render.fileChanged(join(ROOT, "book", "template.typ"));
    await sleep(350);
    assert.deepEqual([render.epoch(CH1), render.epoch(CH2)], [epoch1 + 1, epoch2 + 2]);
    await math("EE[X] = integral");
    assert.equal(calls.length, 3);
    // Two files in one batch: the chapter's own renders go too.
    render.fileChanged(CH1);
    render.fileChanged(join(ROOT, "book", "template.typ"));
    await sleep(350);
    assert.equal(render.epoch(CH1), epoch1 + 2);
    await math("EE[X] = integral");
    assert.equal(calls.length, 4);
    calls.pop();

    // Typst errors are cached; failures of the renderer itself are not.
    const bad = Text.of([CH1_TEXT, "$frac(1, $"].join("\n").split("\n"));
    assert.deepEqual(await math("frac(1, $", bad), { ok: false, message: "unclosed delimiter" });
    await math("frac(1, $", bad);
    assert.equal(calls.length, 4);
    broken = true;
    const other = Text.of([CH1_TEXT, "$y + z$"].join("\n").split("\n"));
    assert.deepEqual(await math("y + z", other), { ok: false, message: "timed out" });
    broken = false;
    assert.ok((await math("y + z", other)).ok);
    assert.equal(calls.length, 6);

    // The same text in another folder is another render: relative imports resolve there.
    const twin = Text.of(['#import "defs.typ": *', "$x + y$"]);
    const inFolder = (dir: string) => render.math(join(ROOT, dir, "a.typ"), twin, at(twin, "x + y"));
    const n = calls.length;
    await inFolder("one");
    await inFolder("two");
    await inFolder("one");
    assert.deepEqual(calls.slice(n).map((c) => c.dir), [join(ROOT, "one"), join(ROOT, "two")]);

    // A render that finishes after a change (debounced 300 ms) is not cached.
    let delay = 400;
    let slowCalls = 0;
    const slow = new TypstRender({ render: async (_d, s) => (slowCalls++, await sleep(delay), page(s)) }, ROOT);
    const pending = slow.math(CH1, doc, at(doc, "EE[X] = integral"));
    slow.fileChanged(join(ROOT, "book", "template.typ"));
    await pending;
    delay = 0;
    await slow.math(CH1, doc, at(doc, "EE[X] = integral"));
    assert.equal(slowCalls, 2, "rendered again");
    slow.dispose();

    // Least recently used out after 2000.
    const many = Text.of([CH1_TEXT, ...Array.from({ length: 2001 }, (_, i) => `$x_${i}$`)].join("\n").split("\n"));
    const before = calls.length;
    for (let i = 0; i < 2001; i++) await math(`x_${i}$`, many);
    await math("x_2000$", many);
    assert.equal(calls.length, before + 2001);
    await math("x_0$", many);
    assert.equal(calls.length, before + 2002, "the oldest was dropped");
  } finally {
    render.dispose();
  }
});

test("TypstRender: renders are dropped 300 ms after the last .typ change, not the first", async () => {
  const render = new TypstRender({ render: async (_d, s) => page(s) }, ROOT);
  const TEMPLATE = join(ROOT, "book", "template.typ");
  try {
    const epoch = render.epoch(CH1);
    render.fileChanged(join(ROOT, "book", "chapters", "ch2.typ"));
    await sleep(250);
    // A template write late in the window: tinymist may not have seen it at 300 ms.
    render.fileChanged(TEMPLATE);
    await sleep(100);
    assert.equal(render.epoch(CH1), epoch, "a later change postpones the drop");
    await sleep(250);
    assert.equal(render.epoch(CH1), epoch + 1, "one drop, 300 ms after the last change");
  } finally {
    render.dispose();
  }
});

test("render hover: math that needs its loop's or closure's variables shows no section; typos keep the error", async () => {
  const text = [
    '#let rates = (("a", 1), ("b", 2))',
    "#table(columns: 2, [$k$], ..rates.map(((k, r)) => ([#k], [$#r$])))",
    "#for i in range(3) [ $x_#i$ ]",
    "#strong[see $alpah$]",
    "",
  ].join("\n");
  // What Typst says of these formulas compiled alone, at the formula's line.
  const errors: Record<string, string> = {
    "$#r$": "unknown variable: r",
    "$x_#i$": "unknown variable: i",
    "$alpah$": "unknown variable: alpah",
  };
  const { backend } = fakeBackend((s) => {
    const lines = s.trimEnd().split("\n");
    const body = Object.keys(errors).find((b) => lines.at(-1)!.endsWith(b));
    return body ? new FragmentError(errors[body], lines.length) : null;
  });
  const render = new TypstRender(backend, ROOT);
  const file = join(ROOT, "book", "notes", "rates.typ");
  const { view, hoverAt } = editor(render, () => true, text, file);
  try {
    assert.deepEqual((await hoverAt("#r$")).map(kind), ["tinymist"], "a closure parameter");
    assert.deepEqual((await hoverAt("x_#i")).map(kind), ["tinymist"], "a loop variable");
    assert.deepEqual((await hoverAt("$k$")).map(kind), ["render", "tinymist"]);
    const [typo] = await hoverAt("alpah");
    assert.equal(typo.querySelector(".lsp-render-hover-message")?.textContent, "unknown variable: alpah");
    assert.equal(typo.querySelector(".lsp-render-hover-source")?.textContent, "$alpah$");
  } finally {
    view.destroy();
    render.dispose();
  }
});

test("TypstRender: an error in a preamble statement is located there, not blamed on the formula", async () => {
  // The fake backend fails on a statement of the source as Typst would: at its line.
  const failAt = (needle: string, message: string) => (s: string) => {
    const line = s.split("\n").findIndex((l) => l.includes(needle));
    return line < 0 ? null : new FragmentError(message, line + 1);
  };
  const doc = (lines: string[]) => Text.of(lines);
  const at = (d: Text, needle: string) => typstMathAt(d, d.toString().indexOf(needle))!;
  let fail: (s: string) => Error | null = failAt("#let f(x) = x +", "expected expression");
  const backend: FragmentBackend = {
    async render(_dir, source) {
      const err = fail(source);
      if (err) throw err;
      return page(source);
    },
  };
  const render = new TypstRender(backend, ROOT);
  try {
    const typed = doc(["#import \"../template.typ\": *", "", "#let f(x) = x +", "The sum $a + b$ is fine."]);
    assert.deepEqual(await render.math(CH1, typed, at(typed, "a + b")), {
      ok: false,
      message: "expected expression",
      at: "book/chapters/ch1.typ:3: #let f(x) = x +",
    });
    // The cached error follows the statement when lines move above it.
    const moved = doc(["#import \"../template.typ\": *", "", "", "", "#let f(x) = x +", "The sum $a + b$ is fine."]);
    assert.equal((await render.math(CH1, moved, at(moved, "a + b")) as { at?: string }).at, "book/chapters/ch1.typ:5: #let f(x) = x +");

    // A statement of the book main, at its own line there.
    fail = failAt("#set math.equation", "expected string, found integer");
    const ch1 = Text.of(CH1_TEXT.split("\n"));
    const main = readFileSync(join(ROOT, "book", "main.typ"), "utf8").split("\n");
    const mainLine = main.findIndex((l) => l.startsWith("#set math.equation")) + 1;
    assert.deepEqual(await render.math(CH1, ch1, at(ch1, "EE[X] = integral")), {
      ok: false,
      message: "expected string, found integer",
      at: `book/main.typ:${mainLine}: #set math.equation(numbering: "(1.1)")`,
    });

    // The formula's own error: no location, the hover shows the formula.
    fail = failAt("$y + z$", "unknown variable: z");
    const own = doc(["$y + z$"]);
    assert.deepEqual(await render.math(CH1, own, at(own, "y + z")), { ok: false, message: "unknown variable: z" });
  } finally {
    render.dispose();
  }

  // In the hover: the statement in place of the formula.
  fail = failAt("#let f(x) = x +", "expected expression");
  const text = "#let f(x) = x +\nThe sum $a + b$ is fine.\n";
  const hovered = new TypstRender(backend, ROOT);
  const { view, hoverAt } = editor(hovered, () => true, text);
  try {
    const [error] = await hoverAt("a + b");
    assert.equal(error.querySelector(".lsp-render-hover-message")?.textContent, "expected expression");
    assert.equal(error.querySelector(".lsp-render-hover-source")?.textContent, "book/chapters/ch1.typ:1: #let f(x) = x +");
  } finally {
    view.destroy();
    hovered.dispose();
  }
});
