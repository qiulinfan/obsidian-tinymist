import { StateEffect, StateField, Text } from "@codemirror/state";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

export interface SemanticLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

export interface StaleRange {
  from: number;
  to: number;
}

/** A semantic-token response, already mapped to the current document. */
export const setSemanticTokens = StateEffect.define<DecorationSet>();
export const setSemanticActive = StateEffect.define<boolean>();
/** Ranges the last response does not cover (edited after its request). */
export const markSemanticStale = StateEffect.define<readonly StaleRange[]>();

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
});

/**
 * Lines edited since the last semantic-token response, as whole-line ranges. There the
 * baseline tokenizer highlights instead, so typing never shows unstyled text while the
 * next response is on its way.
 */
export const semanticStaleField = StateField.define<readonly StaleRange[]>({
  create: () => [],
  update(value, tr) {
    let next = tr.docChanged
      ? value.map((r) => ({ from: tr.changes.mapPos(r.from, -1), to: tr.changes.mapPos(r.to, 1) }))
      : value;
    for (const e of tr.effects) {
      if (e.is(setSemanticTokens)) next = [];
      else if (e.is(markSemanticStale)) next = next.concat(e.value);
    }
    if (tr.docChanged) {
      const added: StaleRange[] = [];
      tr.changes.iterChangedRanges((_fA, _tA, fromB, toB) => added.push({ from: fromB, to: toB }));
      next = next.concat(added);
    }
    return next === value ? value : wholeLines(tr.state.doc, next);
  },
});

/** Sorted, merged ranges widened to whole lines. */
function wholeLines(doc: Text, ranges: readonly StaleRange[]): StaleRange[] {
  const lines = ranges
    .map((r) => ({
      from: doc.lineAt(Math.min(r.from, doc.length)).from,
      to: doc.lineAt(Math.min(r.to, doc.length)).to,
    }))
    .sort((a, b) => a.from - b.from);
  const out: StaleRange[] = [];
  for (const r of lines) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else out.push(r);
  }
  return out;
}

export function overlapsStale(stale: readonly StaleRange[], from: number, to: number): boolean {
  return stale.some((r) => from <= r.to && r.from <= to);
}

/** Semantic decorations minus stale lines (the baseline tokenizer draws those). */
const semanticDecorations = EditorView.decorations.compute(
  [semanticTokensField, semanticStaleField],
  (state) => {
    const tokens = state.field(semanticTokensField);
    const stale = state.field(semanticStaleField);
    if (!stale.length) return tokens;
    return tokens.update({
      filter: (from, to) => !overlapsStale(stale, from, to),
      filterFrom: stale[0].from,
      filterTo: stale[stale.length - 1].to,
    });
  },
);

export const semanticTokensExtension = [
  semanticActiveField,
  semanticTokensField,
  semanticStaleField,
  semanticDecorations,
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
