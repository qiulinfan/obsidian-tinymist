import { Text } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { LiveContext, LiveLanguage, RenderRequest, RenderResult, TextWidget, renderConstruct } from "./shared/livePreview";
import { MathFragment } from "./typstFragment";
import { TypstConstruct, TypstMath, scanTypst, scanTypstText } from "./typstScan";

// Live preview for Typst (the shared core is src/editor/shared/livePreview.ts): formulas in
// markup (typstScan.ts) render in place through the fragment renderer and show their source
// while the cursor is on them. Inline `$x$` becomes an inline widget; display `$ x $`
// becomes a block over its lines when alone on them (with its trailing `<label>`; revealed,
// the source shows with the rendering below it), else a display widget inside the line. A
// formula Typst rejects keeps its source (dotted underline; the render hover shows why),
// one that only fails without the code around it keeps it quietly.
//
// A formula's preamble holds the file's statements above it, so their text is part of its
// key: editing a `#let` re-renders the formulas below it. Meanwhile, and while a statement
// above is broken (Typst's error lies in the preamble), a formula keeps its last rendering
// instead of flashing back to source: its own, found by its source and which occurrence of
// that source it is (the same formula under other statements renders differently), and
// remembered per view. An error in the formula itself keeps its source as usual (and
// tinymist's diagnostics keep any construct they mark source).
//
// Text constructs (found as typstScan.ts describes) are styled in place, their markup hidden
// while the cursor is away: a heading line takes the heading's size (its `= ` shows while
// the cursor is on the line), `*strong*` and `_emph_` their style (the delimiters show
// while the cursor touches them), a `- ` or `+ ` marker becomes its bullet or number (the
// marker shows only while the cursor touches the marker itself, so the bullet stays while
// the item is typed), `/ Term:` a bold term (its `/ ` and `:` show while the cursor is on
// them), `@key` a link-coloured chip (`Supplement @key` with a supplement, shown without its
// strong/emph delimiters: no numbers), `<key>` a faint chip. A construct holding an error
// diagnostic keeps its markup visible.

/** A formula's render request (TypstLiveRenderer, typstRender.ts). */
export interface TypstMathRequest extends RenderRequest {
  /** The document the formula lies in: its statements above the formula join its preamble. */
  readonly doc: Text;
  readonly math: MathFragment;
}

export const isTypstMathRequest = (req: RenderRequest): req is TypstMathRequest =>
  (req as Partial<TypstMathRequest>).math !== undefined && (req as Partial<TypstMathRequest>).doc !== undefined;

/** A failure Typst located in a statement of the preamble, not in the formula. */
export interface PreambleFailure {
  readonly ok: false;
  readonly message: string;
  readonly preamble: true;
}

const isPreambleFailure = (r: RenderResult): boolean => !r.ok && (r as Partial<PreambleFailure>).preamble === true;

/**
 * The request for formula `m`: its key is the formula's (`formula`: epoch, mode and source)
 * plus the hash of the file's statements above it, so equal keys still render identically.
 */
function mathRequest(ctx: LiveContext, m: TypstMath, formula: RenderRequest): TypstMathRequest {
  return {
    ...formula,
    key: `${formula.key}\n${m.preamble}`,
    doc: ctx.state.doc,
    math: { from: m.from, to: m.mathTo, body: m.body, display: m.display },
  };
}

/** Formulas a view remembers the last rendering of before it drops those gone from its text. */
const REMEMBERED = 2000;

/** A formula as its view remembers it: its source and which occurrence of that source it is. */
const occurrence = (m: TypstMath) => `${m.nth}\n${m.body}`;

/**
 * A view's formulas' last renderings: per occurrence, the key it last rendered with (its
 * epoch included: a new epoch's store holds none of them). Past twice the document's
 * formulas (at least REMEMBERED), the occurrences its text no longer has are dropped.
 */
class LastRendered {
  private readonly keys = new Map<string, string>();
  private limit = REMEMBERED;

  get(m: TypstMath): string | undefined {
    return this.keys.get(occurrence(m));
  }

  remember(m: TypstMath, key: string, doc: Text): void {
    const at = occurrence(m);
    if (this.keys.get(at) === key) return;
    this.keys.set(at, key);
    if (this.keys.size <= this.limit) return;
    const kept = new Set<string>();
    for (const c of scanTypst(doc)) if (c.kind === "math") kept.add(occurrence(c));
    for (const k of this.keys.keys()) if (!kept.has(k)) this.keys.delete(k);
    this.limit = Math.max(REMEMBERED, 2 * this.keys.size);
  }
}

/**
 * The request to draw for formula `m`: its own, or, while that is pending or failed in the
 * preamble, the formula's last rendering under other statements above it (still cached:
 * the epoch is the same). The render of its own is queued meanwhile.
 */
function shown(ctx: LiveContext, last: LastRendered, m: TypstMath, req: TypstMathRequest): RenderRequest {
  const r = ctx.peek(req);
  if (r?.ok) last.remember(m, req.key, ctx.state.doc);
  if (r && !isPreambleFailure(r)) return req;
  const key = last.get(m);
  if (key === undefined || key === req.key) return req;
  const stale: RenderRequest = { ...req, key };
  if (ctx.peek(stale)?.ok !== true) return req;
  if (!r) ctx.result(req);
  return stale;
}

const hidden = Decoration.replace({});
const strong = Decoration.mark({ class: "lsp-lp-strong" });
const emph = Decoration.mark({ class: "lsp-lp-em" });
const headings = [1, 2, 3, 4, 5, 6].map((n) => Decoration.line({ class: `lsp-lp-h${n}` }));

const chip = (text: string, cls: string, title: string) => Decoration.replace({ widget: new TextWidget(text, cls, title) });

/**
 * A reference's supplement as its chip shows it: `*strong*` and `_emph_` without their
 * delimiters (as the scanner finds them, so `snake_case` keeps its `_`) and escapes resolved.
 * Null when it holds other markup (raw text, a reference, a label): the chip shows `@key`.
 */
function supplementText(src: string): string | null {
  if (src.includes("`")) return null;
  const delimiters = new Set<number>();
  for (const c of scanTypstText(src)) {
    if (c.kind !== "strong" && c.kind !== "emph") return null;
    delimiters.add(c.from).add(c.to - 1);
  }
  let out = "";
  for (let i = 0; i < src.length; i++) {
    if (delimiters.has(i)) continue;
    if (src[i] === "\\" && i + 1 < src.length) i++;
    out += src[i];
  }
  return out.trim() || null;
}

/** A construct's decorations (LiveLanguage.decorate) in a view remembering `last`. */
function decorate(c: TypstConstruct, ctx: LiveContext, last: LastRendered): void {
  if (c.kind === "math") {
    const formula = ctx.request("math", c.body, c.display, c.from);
    renderConstruct(ctx, c, shown(ctx, last, c, mathRequest(ctx, c, formula)));
    return;
  }
  if (c.kind === "heading") {
    const line = ctx.state.doc.lineAt(c.from).from;
    ctx.mark(line, line, headings[Math.min(c.level, 6) - 1]);
  } else if (c.kind === "strong" || c.kind === "emph") {
    ctx.mark(c.from + 1, c.to - 1, c.kind === "strong" ? strong : emph);
  } else if (c.kind === "term" && c.termTo > c.termFrom) {
    ctx.mark(c.termFrom, c.termTo, strong);
  }
  const revealed = c.kind === "heading" ? ctx.touchLines(c.from, c.from) : ctx.touch(c.from, c.to);
  if (revealed || ctx.hasError(c.from, c.to)) return;
  switch (c.kind) {
    case "heading":
      ctx.replace(c.from, c.markerTo, hidden);
      break;
    case "strong":
    case "emph":
      ctx.replace(c.from, c.from + 1, hidden);
      ctx.replace(c.to - 1, c.to, hidden);
      break;
    case "item":
      ctx.replace(c.from, c.to, Decoration.replace({ widget: new TextWidget(c.marker, "lsp-lp-bullet") }));
      break;
    case "term":
      ctx.replace(c.from, c.termFrom, hidden);
      ctx.replace(c.termTo, c.to, hidden);
      break;
    case "ref": {
      const supplement = c.supplement === null ? null : supplementText(c.supplement);
      const text = supplement ? `${supplement} @${c.key}` : `@${c.key}`;
      ctx.replace(c.from, c.to, chip(text, "lsp-lp-chip is-ref", ctx.state.sliceDoc(c.from, c.to)));
      break;
    }
    case "label":
      ctx.replace(c.from, c.to, chip(c.key, "lsp-lp-chip is-label", `<${c.key}>`));
      break;
  }
}

/**
 * Typst's live-preview language for one view: its formulas' last renderings are the view's
 * (scans stay memoized per text in typstScan.ts).
 */
export function typstLiveLanguage(): LiveLanguage<TypstConstruct> {
  const last = new LastRendered();
  return { scan: scanTypst, decorate: (c, ctx) => decorate(c, ctx, last) };
}
