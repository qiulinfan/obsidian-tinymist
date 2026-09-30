import { Text } from "@codemirror/state";
import { inWord } from "./highlightPlugin";
import type { Construct } from "./shared/livePreview";
import { mathClose } from "./typstEditor";
import { LINE_KEYWORDS, hash, inChapterPreamble, skipEmbedded, skipGroup, skipTrivia, statementAt } from "./typstFragment";

// The constructs live preview renders in a Typst document (typstLive.ts), found in markup
// mode only. Dollars pair by typstMathSpans' rules (escapes, comments, code strings), raw
// text and comments are skipped, and code is never looked into: statements (`#let`,
// `#set`, `#show`, `#import`, `#include`) and keyword expressions (`#if`, `#for`,
// `#context`, …) whole, calls up to their argument lists (`#figure(…)`), code blocks. The
// content blocks a call carries (`#theorem[…]`, `#f(x)[…][…]`, `#[…]`) are markup and are
// scanned: math there renders, math in code (`#let f(x) = $x$`, a closure's `[$#r$]`)
// does not. The top-level statements met on the way (as topLevelStatements takes them)
// give each formula the identity of its chapter preamble, so a rebuild needs no second
// pass over the document.
//
// Text constructs follow Typst's lexer and parser (checked against `typst compile
// --format html`):
//   headings   `=`…`======` then whitespace, first on a line (indentation allowed) or in a
//              content block (`#block[= Title]`);
//   strong     `*…*` and emphasis `_…_` closed on the same line; a delimiter between two
//              letters or digits of a non-CJK script is text (`2*3`, `snake_case`,
//              `*bold*text` closes later), one in math, raw text, code, a reference or a
//              link does not count, and a `]` closing the enclosing content ends the search;
//   lists      `- `, `+ ` and `/ term:` first on a line or first in a content block
//              (`#box[- a]`). An item's body holds the lines below it indented deeper than
//              its marker (blank lines too). A run is the items of one kind that are
//              siblings: in the same body (or at the top), whatever their indentation
//              (`  + a` then `+ b` is one enum). Blank lines, comments and
//              `#let/#set/#show/#import` lines keep it going; other content outside the
//              last item's body ends it. `+` items count through their run (an explicit
//              `3.` sets the count), `-` bullets go •, ‣, – by list depth, a term runs to
//              its first colon on the line;
//   references `@key` (trailing `.` and `:` are text) with a `[supplement]` of plain
//              markup closing on the same line; labels `<key>` (a display formula's
//              trailing label belongs to the formula);
//   links      `http://` and `https://` runs are text: nothing in them is markup (`_` and
//              `@` in URLs). Math and code in them are left as typstMathSpans and
//              topLevelStatements see them, so formulas and preambles stay theirs.
//
// The scan also records the calls it meets in markup (`#theorem[…]`, `#figure(…)`; not the
// statements or keyword expressions) for the paper hover (`typstCallAt`). Content blocks and
// strong/emphasis nest by recursion, which stops at MAX_DEPTH levels: deeper markup (only
// ever pathological) stays source, and the scan never overflows the stack.

/** A formula in markup: `$x$` (inline) or `$ x $` (display). */
export interface TypstMath extends Construct {
  readonly kind: "math";
  /** The opening `$`. */
  readonly from: number;
  /** After the closing `$`, or after a display formula's trailing `<label>` (revealed with it). */
  readonly to: number;
  /** After the closing `$`. */
  readonly mathTo: number;
  /** Its source, `$` delimiters included. */
  readonly body: string;
  /** Whitespace just inside both delimiters (`$ x $`): a block equation. */
  readonly display: boolean;
  /** Display math alone on its lines (its label aside): drawn as a block over them. */
  readonly block: boolean;
  /** The trailing `<label>` of a display formula (on its closing line), or null. */
  readonly label: string | null;
  /**
   * A hash of the file's statements above the formula (chapterPreamble, the chapter part of
   * its fragment preamble): formulas with equal hashes compile with the same statements.
   */
  readonly preamble: string;
  /**
   * How many formulas with the same source come before it in the file: with the source, it
   * tells a formula from the others as statements above them change (typstLive's fallback).
   */
  readonly nth: number;
}

/** A heading `== Title`: from its first `=` to the end of its line. */
export interface TypstHeading extends Construct {
  readonly kind: "heading";
  /** After the `=` run and the spaces after it (the marker hidden off the cursor's line). */
  readonly markerTo: number;
  /** The number of `=`. */
  readonly level: number;
}

/** `*strong*` or `_emph_`: from the opening delimiter to after the closing one. */
export interface TypstStyle extends Construct {
  readonly kind: "strong" | "emph";
}

/** A list (`- `) or enum (`+ `) item's marker character, and what it shows. */
export interface TypstItem extends Construct {
  readonly kind: "item";
  /** A bullet by list depth (•, ‣, –), or the item's number in its run ("2."). */
  readonly marker: string;
}

/** A term item's `/ Term:`, from the `/` to after the colon. */
export interface TypstTerm extends Construct {
  readonly kind: "term";
  /** The term: after the marker and its spaces, up to the colon. */
  readonly termFrom: number;
  readonly termTo: number;
}

/** A reference `@key`, with its supplement `[…]` when that closes on the same line. */
export interface TypstRef extends Construct {
  readonly kind: "ref";
  readonly key: string;
  /** The supplement's source, or null. */
  readonly supplement: string | null;
}

/** A label `<key>` in markup. */
export interface TypstLabel extends Construct {
  readonly kind: "label";
  readonly key: string;
}

export type TypstConstruct = TypstMath | TypstHeading | TypstStyle | TypstItem | TypstTerm | TypstRef | TypstLabel;

/** A call in markup: `#name(…)`, `#name[…]`, `#name.field(…)[…]` (not a statement or keyword). */
export interface TypstCall {
  /** Its `#`. */
  readonly from: number;
  /** After its name and fields (`#theorem`, `#thm.with`): where its first argument group opens. */
  readonly nameTo: number;
  /** After the whole expression (every chained argument group). */
  readonly to: number;
  /** `theorem`, `thm.with`. */
  readonly name: string;
  /** It carries a content block (`#theorem[…]`, `#box(…)[…]`). */
  readonly content: boolean;
}

const IDENT = /[A-Za-z_][\w-]*/y;
/** A label right after a display formula, on the same line (`$ x $ <eq:x>`). */
const LABEL = /[ \t]*<([\p{L}\p{N}_][\p{L}\p{N}_:.-]*)>/uy;
/** A reference: `@`, an identifier character, then those, `.` and `:` (Typst's label literal). */
const REF = /@[\p{XID_Continue}_-][\p{XID_Continue}_\-.:]*/uy;
/** A label `<key>` in markup. */
const TAG = /<([\p{XID_Continue}_-][\p{XID_Continue}_\-.:]*)>/uy;
/** An explicit enum number (`3. `). */
const NUMBER = /(\d+)\.(?=\s|$)/y;
/** Statements produce no content: a line starting with one keeps the list runs going. */
const NEUTRAL = /#(?:let|set|show|import)(?![\w-])/y;
/** What a link may hold (Typst's link_prefix); brackets must balance. */
const URL_CHAR = /[0-9A-Za-z!#$%&*+,\-./:;=?@_~']/;
/** Nesting levels (content blocks, strong and emphasis) the scan looks into. */
const MAX_DEPTH = 64;
/** Calls longer than this get no paper render (the hover compiles them whole). */
export const PAPER_MAX_CHARS = 4000;
/** Typst's default list markers, by list depth. */
const BULLETS = ["•", "‣", "–"];
/** Where markup may start something the scanner cares about. */
const SPECIAL = /[\\/`$#*_@<\n]/g;
const SPACE = /\s/;

/** Only whitespace in s[from, to). */
function blank(s: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (!SPACE.test(s[i])) return false;
  return true;
}

function lineEndAt(s: string, i: number): number {
  const at = s.indexOf("\n", i);
  return at < 0 ? s.length : at;
}

/** A scan in progress: its output and the chapter preamble so far. */
interface Scan {
  readonly s: string;
  readonly out: TypstConstruct[];
  /** The calls met in markup, inner ones before the call holding them. */
  readonly calls: TypstCall[];
  /** The top-level statements met so far that join the preamble, as its text. */
  preamble: string;
  /** hash(preamble), computed when a formula needs it. */
  key: string | null;
  /** Per formula source, the formulas met with it so far. */
  readonly seen: Map<string, number>;
  /** The end of the last link met: markup constructs start only after it. */
  link: number;
}

/**
 * A list run open in a markup region: the column of its last item's marker (deeper lines
 * belong to that item), the column of the item whose body holds the run (-1: none), the
 * items' kind and its count.
 */
interface Run {
  indent: number;
  readonly parent: number;
  readonly kind: "-" | "+" | "/";
  n: number;
}

interface Scanned {
  readonly constructs: readonly TypstConstruct[];
  readonly calls: readonly TypstCall[];
}

const cache = new WeakMap<Text, Scanned>();

function scanned(doc: Text): Scanned {
  let out = cache.get(doc);
  if (!out) cache.set(doc, (out = scanText(doc.toString())));
  return out;
}

/** The live-preview constructs of an editor document in document order, memoized per Text. */
export function scanTypst(doc: Text): readonly TypstConstruct[] {
  return scanned(doc).constructs;
}

/** scanTypst over a string. */
export function scanTypstText(s: string): TypstConstruct[] {
  return scanText(s).constructs;
}

function scanText(s: string): { constructs: TypstConstruct[]; calls: TypstCall[] } {
  const scan: Scan = { s, out: [], calls: [], preamble: "", key: null, seen: new Map(), link: -1 };
  markup(scan, 0, s.length, true, false, 0);
  return { constructs: scan.out, calls: scan.calls };
}

/**
 * The call in markup whose `#name` is at `pos` (its `#` to the end of its name, inclusive)
 * when it renders as a page: it carries a content block (`#theorem[…]`) or is `#figure(…)`
 * or `#image(…)`, and is at most PAPER_MAX_CHARS long. Null elsewhere (math, code,
 * statements, other calls).
 */
export function typstCallAt(doc: Text, pos: number): TypstCall | null {
  for (const c of scanned(doc).calls) {
    if (pos < c.from || pos > c.nameTo) continue;
    const paper = c.content || c.name === "figure" || c.name === "image";
    return paper && c.to - c.from <= PAPER_MAX_CHARS ? c : null;
  }
  return null;
}

/**
 * Scan markup in [from, to): the file (`top`), the inside of a content block (`block`:
 * list markers may open it) or of a strong or emphasis, `depth` levels down.
 */
function markup(scan: Scan, from: number, to: number, top: boolean, block: boolean, depth: number): void {
  const { s } = scan;
  const runs: Run[] = [];
  let i = from;
  if (from === 0 || s[from - 1] === "\n") i = lineStart(scan, runs, from, to, true);
  else if (block) i = lineStart(scan, runs, from, to, false);
  while (i < to) {
    SPECIAL.lastIndex = i;
    const m = SPECIAL.exec(s);
    if (!m || m.index >= to) return;
    i = m.index;
    const c = s[i];
    if (c === "\n") {
      i = lineStart(scan, runs, i + 1, to, true);
    } else if (c === "\\") {
      i += s[i + 1] === "\n" ? 1 : 2; // an escape (`\$`, `\#`); a line break keeps its newline
    } else if (c === "$") {
      i = math(scan, i, to);
    } else if (c === "#") {
      const stmt = top ? statementAt(s, i) : null;
      if (stmt) {
        if (inChapterPreamble(stmt.statement)) {
          scan.preamble += (scan.preamble ? "\n" : "") + stmt.statement.text;
          scan.key = null;
        }
        i = stmt.next;
      } else {
        i = embedded(scan, i + 1, depth);
      }
    } else if (c === "*" || c === "_") {
      i = style(scan, i, to, top, depth);
    } else if (c === "@") {
      i = ref(scan, i, to);
    } else if (c === "<") {
      i = label(scan, i);
    } else {
      if (c === "/" && s[i + 1] === "/") {
        const start = linkStart(s, i);
        if (start >= 0) scan.link = Math.max(scan.link, linkEnd(s, start));
      }
      const end = skipTrivia(s, i); // a comment or raw text
      i = end < 0 ? i + 1 : end;
    }
  }
}

/**
 * At `i` a line starts (`line`), or a content block does: a heading, a list, enum or term
 * marker, or an enum number there, and what the line does to the region's list runs.
 * Returns where the scan goes on.
 */
function lineStart(scan: Scan, runs: Run[], i: number, to: number, line: boolean): number {
  const { s, out } = scan;
  let q = i;
  while (q < to && (s[q] === " " || s[q] === "\t")) q++;
  if (q >= to || s[q] === "\n") return q; // blank: the runs go on
  const c = s[q];
  const spaced = q + 1 >= s.length || SPACE.test(s[q + 1]);
  if (c === "/" && (s[q + 1] === "/" || s[q + 1] === "*")) return q; // a comment
  if (c === "#") {
    NEUTRAL.lastIndex = q;
    if (NEUTRAL.test(s)) return q;
  }
  const indent = line ? q - i : q - (s.lastIndexOf("\n", q - 1) + 1);
  if (c === "=") {
    let r = q + 1;
    while (s[r] === "=") r++;
    if (r >= s.length || SPACE.test(s[r])) {
      let markerTo = r;
      while (s[markerTo] === " " || s[markerTo] === "\t") markerTo++;
      close(runs, indent);
      out.push({ kind: "heading", from: q, to: Math.min(lineEndAt(s, q), to), markerTo, level: r - q });
      return markerTo;
    }
  } else if ((c === "-" || c === "+") && spaced) {
    const run = open(runs, indent, c);
    const depth = runs.reduce((n, r) => (r.kind === "-" ? n + 1 : n), 0);
    out.push({ kind: "item", from: q, to: q + 1, marker: c === "+" ? `${run.n}.` : BULLETS[(depth - 1) % BULLETS.length] });
    return q + 1;
  } else if (c === "/" && spaced) {
    const colon = find(s, q + 1, Math.min(lineEndAt(s, q), to), (at) => s[at] === ":");
    if (colon >= 0) {
      open(runs, indent, "/");
      let termFrom = q + 1;
      while (s[termFrom] === " " || s[termFrom] === "\t") termFrom++;
      out.push({ kind: "term", from: q, to: colon + 1, termFrom, termTo: colon });
      return q + 1;
    }
  } else if (c >= "0" && c <= "9") {
    NUMBER.lastIndex = q;
    const n = NUMBER.exec(s);
    if (n) {
      open(runs, indent, "+", parseInt(n[1], 10));
      return q + n[0].length;
    }
  }
  close(runs, indent);
  return q;
}

/**
 * The run an item at `indent` joins: inside the last item's body (deeper than its marker) a
 * new one, else that of its siblings (the runs whose body it is not in end; a run of
 * another kind there ends too).
 */
function open(runs: Run[], indent: number, kind: Run["kind"], n?: number): Run {
  while (runs.length && runs[runs.length - 1].parent >= indent) runs.pop();
  let top: Run | undefined = runs[runs.length - 1];
  if (top && top.indent >= indent) {
    if (top.kind === kind) {
      top.n = n ?? top.n + 1;
      top.indent = indent;
      return top;
    }
    runs.pop();
    runs.push((top = { indent, parent: top.parent, kind, n: n ?? 1 }));
    return top;
  }
  runs.push((top = { indent, parent: top ? top.indent : -1, kind, n: n ?? 1 }));
  return top;
}

/** Content at `indent`: the runs whose last item's body it is not in end. */
function close(runs: Run[], indent: number): void {
  while (runs.length && runs[runs.length - 1].indent >= indent) runs.pop();
}

/** The formula opening at `i`, if it closes before `to`; returns where markup goes on. */
function math(scan: Scan, i: number, to: number): number {
  const { s } = scan;
  const close = mathClose(s, i + 1);
  if (close >= to) return i + 1; // unclosed (being typed): no formula
  const mathTo = close + 1;
  if (blank(s, i + 1, close)) return mathTo;
  const display = SPACE.test(s[i + 1]) && SPACE.test(s[close - 1]);
  let end = mathTo;
  let label: string | null = null;
  if (display) {
    LABEL.lastIndex = mathTo;
    const l = LABEL.exec(s);
    if (l && mathTo + l[0].length <= to) {
      label = l[1];
      end = mathTo + l[0].length;
    }
  }
  const block = display && blank(s, s.lastIndexOf("\n", i - 1) + 1, i) && blank(s, end, lineEndAt(s, end));
  scan.key ??= hash(scan.preamble);
  const body = s.slice(i, mathTo);
  const nth = scan.seen.get(body) ?? 0;
  scan.seen.set(body, nth + 1);
  scan.out.push({ kind: "math", from: i, to: end, mathTo, body, display, block, label, preamble: scan.key, nth });
  return end;
}

/** `*strong*` or `_emph_` opening at `i`, closed before the end of its line (and `to`). */
function style(scan: Scan, i: number, to: number, top: boolean, depth: number): number {
  const { s } = scan;
  const d = s[i];
  if (i < scan.link || inWord(s, i)) return i + 1;
  const close = find(s, i + 1, Math.min(lineEndAt(s, i), to), (at) => s[at] === d && !inWord(s, at));
  if (close < 0) return i + 1; // unclosed: text for now
  if (close > i + 1) scan.out.push({ kind: d === "*" ? "strong" : "emph", from: i, to: close + 1 });
  if (depth < MAX_DEPTH) markup(scan, i + 1, close, top, false, depth + 1);
  return close + 1;
}

/**
 * The reference at `i`, with a supplement of plain markup closing on its line before `to`
 * (one holding code or math stays markup after the chip: its statements and formulas are
 * the scan's, as topLevelStatements and typstMathSpans take them).
 */
function ref(scan: Scan, i: number, to: number): number {
  const { s } = scan;
  const end = i < scan.link ? -1 : refEnd(s, i);
  if (end < 0) return i + 1;
  let stop = end;
  let supplement: string | null = null;
  if (s[end] === "[") {
    const close = skipGroup(s, end);
    if (close > end && close <= to && !/[\n#$]/.test(s.slice(end, close))) {
      supplement = s.slice(end + 1, close - 1);
      stop = close;
    }
  }
  scan.out.push({ kind: "ref", from: i, to: stop, key: s.slice(i + 1, end), supplement });
  return stop;
}

/** The label at `i`, if one is there. */
function label(scan: Scan, i: number): number {
  const end = i < scan.link ? -1 : tagEnd(scan.s, i);
  if (end < 0) return i + 1;
  scan.out.push({ kind: "label", from: i, to: end, key: scan.s.slice(i + 1, end - 1) });
  return end;
}

/** After the reference `@key` at `i` (without trailing `.` and `:`), or -1. */
function refEnd(s: string, i: number): number {
  REF.lastIndex = i;
  const m = REF.exec(s);
  if (!m) return -1;
  let end = i + m[0].length;
  while (s[end - 1] === "." || s[end - 1] === ":") end--;
  return end;
}

/** After the label `<key>` at `i`, or -1. */
function tagEnd(s: string, i: number): number {
  TAG.lastIndex = i;
  const m = TAG.exec(s);
  return m ? i + m[0].length : -1;
}

/** The start of the link whose `//` is at `i` (`http://`, `https://`), or -1. */
function linkStart(s: string, i: number): number {
  if (s.startsWith("https:", i - 6)) return i - 6;
  if (s.startsWith("http:", i - 5)) return i - 5;
  return -1;
}

/** The end of the link starting at `i`, as Typst's lexer takes it. */
function linkEnd(s: string, i: number): number {
  const open: string[] = [];
  let j = i;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === "(" || c === "[") open.push(c);
    else if (c === ")" || c === "]") {
      if (open.pop() !== (c === ")" ? "(" : "[")) break;
    } else if (!URL_CHAR.test(c)) break;
  }
  // Punctuation at its end is text ("see https://typst.app.").
  while (j > i && "!,.:;?'".includes(s[j - 1])) j--;
  return j;
}

/**
 * The first position in [i, end) where `hit` holds, walking markup as the scan does:
 * escapes, comments, raw text, math, embedded code, references (with a supplement) and
 * labels are passed over, and nothing in a link counts. -1 when there is none, or a `]`
 * closes the enclosing content first.
 */
function find(s: string, i: number, end: number, hit: (at: number) => boolean): number {
  let depth = 0;
  let link = -1;
  while (i < end) {
    const c = s[i];
    if (c === ":" && s[i + 1] === "/" && s[i + 2] === "/" && i >= link) {
      const start = linkStart(s, i + 1);
      if (start >= 0) link = linkEnd(s, start);
    }
    if (i >= link) {
      if (hit(i)) return i;
      const after = c === "@" ? refEnd(s, i) : c === "<" ? tagEnd(s, i) : -1;
      if (after >= 0) {
        i = c === "@" && s[after] === "[" ? Math.max(skipGroup(s, after), after) : after;
        continue;
      }
    }
    if (c === "\\") i += 2;
    else if (c === "$") i = mathClose(s, i + 1) + 1;
    else if (c === "#") i = Math.max(skipEmbedded(s, i + 1), i + 1);
    else if (c === "[") (depth++, i++);
    else if (c === "]") {
      if (depth-- === 0) return -1;
      i++;
    } else {
      const t = skipTrivia(s, i);
      i = t < 0 ? i + 1 : t;
    }
  }
  return -1;
}

/**
 * The embedded expression after a `#` (at `i - 1`) that is not a top-level statement, at
 * markup depth `depth`: code is skipped, the content blocks a call carries are scanned as
 * markup, and a call is recorded. Returns its end.
 */
function embedded(scan: Scan, i: number, depth: number): number {
  const { s } = scan;
  let j: number;
  const c = s[i];
  if (c === "[") {
    j = i; // `#[…]`: content
  } else if (c === "(" || c === "{" || c === '"') {
    return Math.max(skipEmbedded(s, i), i); // code, and whatever chains onto it
  } else {
    IDENT.lastIndex = i;
    const id = IDENT.exec(s);
    if (!id) return i; // a lone `#`: text
    // Statements (in content blocks) and keyword expressions are code, bodies included.
    if (LINE_KEYWORDS.has(id[0])) return Math.max(skipEmbedded(s, i), i);
    j = i + id[0].length;
  }
  // Calls, content blocks and fields chain on, as in Typst (no space in between).
  let nameTo = -1;
  let content = false;
  for (;;) {
    if (s[j] === "(" || s[j] === "[") {
      if (nameTo < 0) nameTo = j;
      const end = skipGroup(s, j);
      // Unclosed (being typed): the rest of its line is not markup.
      if (end < 0) return lineEndAt(s, j);
      if (s[j] === "[") {
        content = true;
        if (depth < MAX_DEPTH) markup(scan, j + 1, end - 1, false, true, depth + 1);
      }
      j = end;
      continue;
    }
    if (s[j] === ".") {
      IDENT.lastIndex = j + 1;
      const field = IDENT.exec(s);
      if (field) {
        j += 1 + field[0].length;
        continue;
      }
    }
    if (c !== "[" && nameTo > i) scan.calls.push({ from: i - 1, nameTo, to: j, name: s.slice(i, nameTo), content });
    return j;
  }
}
