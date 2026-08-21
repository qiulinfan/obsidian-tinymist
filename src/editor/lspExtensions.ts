import {
  Completion,
  CompletionContext,
  CompletionResult,
  snippet,
} from "@codemirror/autocomplete";
import { Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { EditorState, Text } from "@codemirror/state";
import { hoverTooltip, Tooltip } from "@codemirror/view";
import { App, Component, MarkdownRenderer } from "obsidian";
import { LspClient, LspDiagnostic, LspPosition } from "../lsp/client";

export function posToOffset(doc: Text, pos: LspPosition): number {
  const lineNo = Math.min(pos.line + 1, doc.lines);
  const line = doc.line(lineNo);
  return Math.min(line.from + pos.character, line.to);
}

export function offsetToPos(doc: Text, offset: number): LspPosition {
  const line = doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

export function lspDiagnosticsToCm(
  state: EditorState,
  diags: LspDiagnostic[],
): CmDiagnostic[] {
  return diags.map((d) => {
    let from = posToOffset(state.doc, d.range.start);
    let to = posToOffset(state.doc, d.range.end);
    if (to < from) [from, to] = [to, from];
    if (from === to && to < state.doc.length) to++;
    const severity =
      d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info";
    return { from, to, severity, message: d.message, source: d.source };
  });
}

interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: { range?: { start: LspPosition }; newText?: string };
  sortText?: string;
}

const KIND_NAMES: Record<number, string> = {
  1: "text",
  2: "method",
  3: "function",
  4: "constructor",
  5: "field",
  6: "variable",
  7: "class",
  8: "interface",
  9: "module",
  10: "property",
  12: "constant",
  13: "enum",
  14: "keyword",
  15: "snippet",
  16: "color",
  17: "file",
  18: "reference",
  19: "folder",
  21: "constant",
  22: "struct",
};

function lspSnippetToCm(text: string): string {
  return text
    .replace(/\$\{\d+:([^{}]*)\}/g, "${$1}")
    .replace(/\$\{\d+\}/g, "${}")
    .replace(/\$\d+/g, "${}");
}

export function lspCompletionSource(
  getLsp: () => LspClient | null,
  getPath: () => string | null,
) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const lsp = getLsp();
    const path = getPath();
    if (!lsp || lsp.status !== "running" || !path) return null;
    const word = ctx.matchBefore(/[#@]?[\w.-]*$/);
    if (!ctx.explicit && (!word || word.from === word.to)) return null;

    let raw: unknown;
    try {
      raw = await lsp.completion(path, offsetToPos(ctx.state.doc, ctx.pos));
    } catch {
      return null;
    }
    const items: LspCompletionItem[] = Array.isArray(raw)
      ? (raw as LspCompletionItem[])
      : ((raw as { items?: LspCompletionItem[] } | null)?.items ?? []);
    if (!items.length) return null;

    let from = word ? word.from : ctx.pos;
    const firstEdit = items[0]?.textEdit?.range?.start;
    if (firstEdit) from = posToOffset(ctx.state.doc, firstEdit);

    const options: Completion[] = items.slice(0, 300).map((it) => {
      const insert = it.textEdit?.newText ?? it.insertText ?? it.label;
      const option: Completion = {
        label: it.label,
        type: KIND_NAMES[it.kind ?? 1] ?? "text",
        detail: it.detail,
        boost: it.sortText ? undefined : 0,
      };
      if (it.insertTextFormat === 2) {
        option.apply = snippet(lspSnippetToCm(insert));
      } else if (insert !== it.label) {
        option.apply = insert;
      }
      return option;
    });
    return { from, options, validFor: /^[\w.-]*$/ };
  };
}

interface LspHover {
  contents:
    | string
    | { kind?: string; value: string; language?: string }
    | Array<string | { language?: string; value: string }>;
  range?: { start: LspPosition; end: LspPosition };
}

function hoverToMarkdown(contents: LspHover["contents"]): string {
  const one = (
    c: string | { language?: string; value: string },
  ): string =>
    typeof c === "string"
      ? c
      : c.language
        ? "```" + c.language + "\n" + c.value + "\n```"
        : c.value;
  return Array.isArray(contents)
    ? contents.map(one).join("\n\n")
    : one(contents);
}

export function lspHoverTooltip(
  app: App,
  getLsp: () => LspClient | null,
  getPath: () => string | null,
) {
  return hoverTooltip(
    async (view, pos): Promise<Tooltip | null> => {
      const lsp = getLsp();
      const path = getPath();
      if (!lsp || lsp.status !== "running" || !path) return null;
      let hv: LspHover | null;
      try {
        hv = (await lsp.hover(
          path,
          offsetToPos(view.state.doc, pos),
        )) as LspHover | null;
      } catch {
        return null;
      }
      if (!hv?.contents) return null;
      const md = hoverToMarkdown(hv.contents);
      if (!md.trim()) return null;
      let from = pos;
      let to = pos;
      if (hv.range) {
        from = posToOffset(view.state.doc, hv.range.start);
        to = posToOffset(view.state.doc, hv.range.end);
      }
      return {
        pos: from,
        end: to,
        above: true,
        create: () => {
          const dom = document.createElement("div");
          dom.className = "tym-hover markdown-rendered";
          const component = new Component();
          component.load();
          void MarkdownRenderer.render(app, md, dom, path, component);
          return { dom, destroy: () => component.unload() };
        },
      };
    },
    { hoverTime: 300 },
  );
}
