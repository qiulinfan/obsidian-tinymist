import { StateEffect, StateField, Text } from "@codemirror/state";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

export interface SemanticLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

export const setSemanticTokens = StateEffect.define<DecorationSet>();
export const setSemanticActive = StateEffect.define<boolean>();

/** Whether LSP semantic tokens are live; the baseline tokenizer then yields. */
export const semanticActiveField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSemanticActive)) value = e.value;
    return value;
  },
});

export const semanticTokensField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setSemanticTokens)) value = e.value;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const semanticTokensExtension = [
  semanticActiveField,
  semanticTokensField,
];

/** Decode LSP relative-encoded semantic tokens into class decorations. */
export function decodeSemanticTokens(
  doc: Text,
  data: number[],
  legend: SemanticLegend,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let line = 0;
  let char = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i];
    const deltaChar = data[i + 1];
    const length = data[i + 2];
    const typeIdx = data[i + 3];
    const modBits = data[i + 4];
    if (deltaLine > 0) {
      line += deltaLine;
      char = deltaChar;
    } else {
      char += deltaChar;
    }
    if (line >= doc.lines) break;
    const docLine = doc.line(line + 1);
    const from = Math.min(docLine.from + char, docLine.to);
    const to = Math.min(from + length, docLine.to);
    if (to <= from) continue;
    let cls = "tym-sem-" + (legend.tokenTypes[typeIdx] ?? "text");
    for (let b = 0; b < legend.tokenModifiers.length; b++) {
      if (modBits & (1 << b)) cls += " tym-mod-" + legend.tokenModifiers[b];
    }
    builder.add(from, to, Decoration.mark({ class: cls }));
  }
  return builder.finish();
}
