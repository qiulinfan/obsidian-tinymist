import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { semanticActiveField, setSemanticActive } from "./semanticTokens";

/**
 * Obsidian inlines its own copy of the CM6 language plumbing, so Lezer
 * style props attached by the exposed modules never reach its highlight
 * pass. We therefore tokenize directly and emit class decorations
 * ourselves. LSP semantic tokens (roadmap v0.2) will reuse this
 * decoration pipeline.
 */

interface TokState {
  blockComment: number;
  inMath: boolean;
}

const TRIGGER = /[#@<"`*_$/=]/;

function tokenizeLine(
  text: string,
  lineStart: number,
  atDocLineStart: boolean,
  s: TokState,
  push: (from: number, to: number, cls: string) => void,
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
      while (i < n && text[i] !== "$") i++;
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
    } else if ((m = /^\*(?:[^*\n]|\\\*)+\*/.exec(rest))) {
      push(lineStart + i, lineStart + i + m[0].length, "tym-strong");
    } else if ((m = /^_(?:[^_\n]|\\_)+_/.exec(rest))) {
      push(lineStart + i, lineStart + i + m[0].length, "tym-emphasis");
    }
    i += m ? m[0].length : 1;
  }
}

const MAX_TOKENIZE_LENGTH = 500_000;

function buildDecorations(view: EditorView): DecorationSet {
  const doc = view.state.doc;
  // LSP semantic tokens supersede the baseline tokenizer once available.
  if (view.state.field(semanticActiveField, false)) return Decoration.none;
  if (doc.length > MAX_TOKENIZE_LENGTH) return Decoration.none;
  const end = view.visibleRanges.length
    ? view.visibleRanges[view.visibleRanges.length - 1].to
    : doc.length;
  const builder = new RangeSetBuilder<Decoration>();
  const state: TokState = { blockComment: 0, inMath: false };
  for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
    const line = doc.line(lineNo);
    if (line.from > end) break;
    tokenizeLine(line.text, line.from, true, state, (from, to, cls) => {
      builder.add(from, to, Decoration.mark({ class: cls }));
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
      const semanticFlipped = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setSemanticActive)),
      );
      if (update.docChanged || update.viewportChanged || semanticFlipped) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
