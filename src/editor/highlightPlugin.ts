import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import {
  markSemanticStale,
  overlapsStale,
  semanticActiveField,
  semanticStaleField,
  setSemanticActive,
  setSemanticTokens,
} from "./semanticTokens";

/**
 * Obsidian inlines its own copy of the CM6 language plumbing, so Lezer
 * style props attached by the exposed modules never reach its highlight
 * pass. We therefore tokenize directly and emit class decorations
 * ourselves. Once LSP semantic tokens are live, this only fills in the
 * lines edited since the last semantic response.
 */

interface TokState {
  blockComment: number;
  inMath: boolean;
}

type Push = (from: number, to: number, cls: string) => void;

const TRIGGER = /[\\#@<"`*_$/=]/;

/** Letters and digits outside the CJK scripts: `*` and `_` between two of them are text. */
const WORDY = /(?![\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}])[\p{Alphabetic}\p{N}]/u;

function wordy(s: string, at: number): boolean {
  const cp = s.codePointAt(at);
  return cp !== undefined && WORDY.test(String.fromCodePoint(cp));
}

/**
 * A `*` or `_` at `i` between two word characters is text (Typst's in_word; the live
 * preview scanner, typstScan.ts, takes the rule from here).
 */
export function inWord(s: string, i: number): boolean {
  let p = i - 1;
  if (p > 0 && (s.charCodeAt(p) & 0xfc00) === 0xdc00) p--; // the low half of a pair
  return p >= 0 && wordy(s, p) && wordy(s, i + 1);
}

/**
 * After the formula whose content starts at `i` on this line (escapes skipped), or -1 when
 * it does not close on the line.
 */
function mathEnd(text: string, i: number): number {
  while (i < text.length && text[i] !== "$") i += text[i] === "\\" ? 2 : 1;
  return i < text.length ? i + 1 : -1;
}

/**
 * `*strong*` or `_emph_` opening at `i`, closed on its line as Typst closes it: a delimiter
 * between two word characters is text (`snake_case`, `2*3`, `*a*b` closes later), an
 * escaped one closes nothing, and a formula inside is passed over and tinted as math (its
 * `*` or `_` closes nothing either). Returns where tokenizing goes on.
 */
function style(text: string, lineStart: number, i: number, push: Push): number {
  const d = text[i];
  if (inWord(text, i)) return i + 1;
  const maths: [number, number][] = [];
  let j = i + 1;
  for (;;) {
    if (j >= text.length) return i + 1; // unclosed: text
    const c = text[j];
    if (c === "\\") j += 2;
    else if (c === "$") {
      const end = mathEnd(text, j + 1);
      if (end < 0) return i + 1; // a formula going on below: the `$` opens it
      maths.push([j, end]);
      j = end;
    } else if (c === d && !inWord(text, j)) break;
    else j++;
  }
  if (j === i + 1) return j + 1; // empty
  push(lineStart + i, lineStart + j + 1, d === "*" ? "tym-strong" : "tym-emphasis");
  for (const [from, to] of maths) {
    push(lineStart + from, lineStart + from + 1, "tym-keyword");
    if (to - 1 > from + 1) push(lineStart + from + 1, lineStart + to - 1, "tym-math");
    push(lineStart + to - 1, lineStart + to, "tym-keyword");
  }
  return j + 1;
}

function tokenizeLine(
  text: string,
  lineStart: number,
  atDocLineStart: boolean,
  s: TokState,
  push: Push,
): void {
  const n = text.length;
  let i = 0;
  if (atDocLineStart && s.blockComment === 0 && !s.inMath) {
    const heading = /^=+\s/.exec(text);
    if (heading) {
      push(lineStart, lineStart + n, "tym-heading");
      return;
    }
  }
  while (i < n) {
    if (s.blockComment > 0) {
      const start = i;
      while (i < n && s.blockComment > 0) {
        if (text.startsWith("/*", i)) {
          s.blockComment++;
          i += 2;
        } else if (text.startsWith("*/", i)) {
          s.blockComment--;
          i += 2;
        } else {
          i++;
        }
      }
      push(lineStart + start, lineStart + i, "tym-comment");
      continue;
    }
    if (s.inMath) {
      const start = i;
      // An escape (`\$`) is part of the math.
      while (i < n && text[i] !== "$") i = Math.min(n, i + (text[i] === "\\" ? 2 : 1));
      if (i > start) push(lineStart + start, lineStart + i, "tym-math");
      if (i < n) {
        push(lineStart + i, lineStart + i + 1, "tym-keyword");
        s.inMath = false;
        i++;
      }
      continue;
    }
    const ch = text[i];
    if (!TRIGGER.test(ch)) {
      i++;
      continue;
    }
    if (ch === "\\") {
      i += 2; // an escape: `\$5` is text, not math
      continue;
    }
    if (text.startsWith("//", i)) {
      push(lineStart + i, lineStart + n, "tym-comment");
      return;
    }
    if (text.startsWith("/*", i)) {
      s.blockComment = 1;
      continue;
    }
    if (ch === "$") {
      push(lineStart + i, lineStart + i + 1, "tym-keyword");
      s.inMath = true;
      i++;
      continue;
    }
    if (ch === "*" || ch === "_") {
      i = style(text, lineStart, i, push);
      continue;
    }
    const rest = text.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^#[A-Za-z_][A-Za-z0-9_.-]*/.exec(rest))) {
      push(lineStart + i, lineStart + i + m[0].length, "tym-keyword");
    } else if ((m = /^@[A-Za-z_][A-Za-z0-9_:.-]*/.exec(rest))) {
      push(lineStart + i, lineStart + i + m[0].length, "tym-ref");
    } else if ((m = /^<[A-Za-z_][A-Za-z0-9_:.-]*>/.exec(rest))) {
      push(lineStart + i, lineStart + i + m[0].length, "tym-label");
    } else if ((m = /^"(?:[^"\\]|\\.)*"/.exec(rest))) {
      push(lineStart + i, lineStart + i + m[0].length, "tym-string");
    } else if ((m = /^`(?:[^`\\]|\\.)*`/.exec(rest))) {
      push(lineStart + i, lineStart + i + m[0].length, "tym-raw");
    }
    i += m ? m[0].length : 1;
  }
}

const MAX_TOKENIZE_LENGTH = 500_000;

function buildDecorations(view: EditorView): DecorationSet {
  const doc = view.state.doc;
  // LSP semantic tokens supersede the baseline tokenizer except on stale lines.
  const semantic = view.state.field(semanticActiveField, false) ?? false;
  const stale = view.state.field(semanticStaleField, false) ?? [];
  if (semantic && !stale.length) return Decoration.none;
  if (doc.length > MAX_TOKENIZE_LENGTH) return Decoration.none;
  const end = view.visibleRanges.length
    ? view.visibleRanges[view.visibleRanges.length - 1].to
    : doc.length;
  const builder = new RangeSetBuilder<Decoration>();
  const state: TokState = { blockComment: 0, inMath: false };
  for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
    const line = doc.line(lineNo);
    if (line.from > end) break;
    const draw = !semantic || overlapsStale(stale, line.from, line.to);
    tokenizeLine(line.text, line.from, true, state, (from, to, cls) => {
      if (draw) builder.add(from, to, Decoration.mark({ class: cls }));
    });
  }
  return builder.finish();
}

export const typstHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      const semanticChanged = update.transactions.some((tr) =>
        tr.effects.some(
          (e) =>
            e.is(setSemanticActive) ||
            e.is(setSemanticTokens) ||
            e.is(markSemanticStale),
        ),
      );
      if (update.docChanged || update.viewportChanged || semanticChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
