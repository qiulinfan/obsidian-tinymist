import { HighlightStyle, StreamLanguage } from "@codemirror/language";
import { tags } from "@lezer/highlight";

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
  tokenTable: {
    lineComment: tags.lineComment,
    comment: tags.blockComment,
    keyword: tags.keyword,
    heading: tags.heading,
    link: tags.link,
    labelName: tags.labelName,
    string: tags.string,
    monospace: tags.monospace,
    strong: tags.strong,
    emphasis: tags.emphasis,
    number: tags.number,
  },
});

/** Class-based so themes style everything via CSS variables in styles.css. */
export const typstHighlightStyle = HighlightStyle.define([
  { tag: tags.lineComment, class: "tym-comment" },
  { tag: tags.blockComment, class: "tym-comment" },
  { tag: tags.keyword, class: "tym-keyword" },
  { tag: tags.heading, class: "tym-heading" },
  { tag: tags.link, class: "tym-ref" },
  { tag: tags.labelName, class: "tym-label" },
  { tag: tags.string, class: "tym-string" },
  { tag: tags.monospace, class: "tym-raw" },
  { tag: tags.strong, class: "tym-strong" },
  { tag: tags.emphasis, class: "tym-emphasis" },
  { tag: tags.number, class: "tym-math" },
]);
