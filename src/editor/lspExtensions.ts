import { Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { EditorState, Text } from "@codemirror/state";
import { hoverTooltip, Tooltip } from "@codemirror/view";
import { App, Component, MarkdownRenderer } from "obsidian";
import { LspClient, LspDiagnostic, LspPosition } from "../lsp/client";
import type { InfoRenderer } from "./shared/lspCompletion";

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

/**
 * tinymist's text hover, closed by an edit or a selection change like the render hover
 * above it. `skip` drops an answer (its Markdown) at `pos`.
 */
export function lspHoverTooltip(
  app: App,
  getLsp: () => LspClient | null,
  getPath: () => string | null,
  skip?: (state: EditorState, pos: number, markdown: string) => boolean,
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
      if (!md.trim() || skip?.(view.state, pos, md)) return null;
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
    { hoverTime: 300, hideOnChange: true },
  );
}

/** Completion info panel: tinymist's Markdown docs through Obsidian's renderer. */
export function markdownInfoRenderer(
  app: App,
  getPath: () => string | null,
): InfoRenderer {
  return (doc) => {
    const dom = document.createElement("div");
    if (doc.kind === "plaintext") {
      dom.className = "lsp-completion-info";
      dom.textContent = doc.value;
      return dom;
    }
    dom.className = "tym-completion-doc markdown-rendered";
    const component = new Component();
    component.load();
    void MarkdownRenderer.render(app, doc.value, dom, getPath() ?? "", component);
    return { dom, destroy: () => component.unload() };
  };
}
