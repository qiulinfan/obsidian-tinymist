import { StreamLanguage } from "@codemirror/language";

interface TypstState {
  blockComment: number;
  inMath: boolean;
}

/**
 * Baseline highlighting only: headings, hash expressions, math, strings,
 * comments, labels, references, raw text, and emphasis. Semantic tokens from
 * the LSP will layer real language awareness on top (roadmap v0.2).
 */
export const typstLanguage = StreamLanguage.define<TypstState>({
  name: "typst",
  startState: () => ({ blockComment: 0, inMath: false }),
  token(stream, state) {
    if (state.blockComment > 0) {
      while (!stream.eol()) {
        if (stream.match("/*")) {
          state.blockComment++;
          continue;
        }
        if (stream.match("*/")) {
          state.blockComment--;
          if (state.blockComment === 0) return "comment";
          continue;
        }
        stream.next();
      }
      return "comment";
    }
    if (stream.match("//")) {
      stream.skipToEnd();
      return "lineComment";
    }
    if (stream.match("/*")) {
      state.blockComment = 1;
      return "comment";
    }
    if (state.inMath) {
      if (stream.eat("$")) {
        state.inMath = false;
        return "keyword";
      }
      while (!stream.eol() && stream.peek() !== "$") stream.next();
      return "number";
    }
    if (stream.eat("$")) {
      state.inMath = true;
      return "keyword";
    }
    if (stream.sol() && stream.match(/^=+\s/)) {
      stream.skipToEnd();
      return "heading";
    }
    if (stream.match(/^#[A-Za-z_][A-Za-z0-9_-]*/)) return "keyword";
    if (stream.match(/^@[A-Za-z_][A-Za-z0-9_:.-]*/)) return "link";
    if (stream.match(/^<[A-Za-z_][A-Za-z0-9_:.-]*>/)) return "labelName";
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^`(?:[^`\\]|\\.)*`?/)) return "monospace";
    if (stream.match(/^\*(?:[^*\n]|\\\*)+\*/)) return "strong";
    if (stream.match(/^_(?:[^_\n]|\\_)+_/)) return "emphasis";
    stream.next();
    return null;
  },
});
