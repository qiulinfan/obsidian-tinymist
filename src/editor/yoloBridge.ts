import { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { App } from "obsidian";

/**
 * Experimental bridge to the YOLO plugin's AI tab completion.
 *
 * YOLO's inline-suggestion rendering is an ordinary CM6 extension, but its
 * trigger path is gated on the active MarkdownView. We mount the rendering
 * extension into our editor and drive the request path ourselves, handing
 * YOLO a minimal Obsidian-Editor-compatible shim over our EditorView (the
 * accept path calls getCursor/offsetToPos/replaceRange/setCursor on it).
 * Everything here talks to YOLO's public-ish controller surface and fails
 * soft when YOLO is absent or its internals change.
 */

interface YoloInlineController {
  createExtension(): unknown;
}

interface YoloTabController {
  run(
    editor: unknown,
    cursorOffset: number,
    replaceFromOffset?: number | null,
  ): unknown;
}

export interface YoloPlugin {
  getInlineSuggestionController(): YoloInlineController;
  getTabCompletionController(): YoloTabController;
}

export function getYoloPlugin(app: App): YoloPlugin | null {
  const plugins = (
    app as unknown as {
      plugins?: { plugins?: Record<string, unknown> };
    }
  ).plugins?.plugins;
  const yolo = plugins?.["yolo"] as Partial<YoloPlugin> | undefined;
  if (
    yolo &&
    typeof yolo.getInlineSuggestionController === "function" &&
    typeof yolo.getTabCompletionController === "function"
  ) {
    return yolo as YoloPlugin;
  }
  return null;
}

export function yoloRenderExtension(yolo: YoloPlugin): Extension | null {
  try {
    return yolo.getInlineSuggestionController().createExtension() as Extension;
  } catch (err) {
    console.warn("[tinymist] YOLO render extension unavailable:", err);
    return null;
  }
}

interface Pos {
  line: number;
  ch: number;
}

/** Minimal Obsidian-Editor lookalike backed by a CM6 view (0-based lines). */
export class YoloEditorShim {
  constructor(readonly cm: EditorView) {}

  getSelection(): string {
    const { from, to } = this.cm.state.selection.main;
    return this.cm.state.sliceDoc(from, to);
  }

  somethingSelected(): boolean {
    return !this.cm.state.selection.main.empty;
  }

  getCursor(): Pos {
    return this.offsetToPos(this.cm.state.selection.main.head);
  }

  setCursor(pos: Pos): void {
    const offset = this.posToOffset(pos);
    this.cm.dispatch({
      selection: { anchor: offset },
      effects: EditorView.scrollIntoView(offset),
    });
  }

  offsetToPos(offset: number): Pos {
    const clamped = Math.max(0, Math.min(offset, this.cm.state.doc.length));
    const line = this.cm.state.doc.lineAt(clamped);
    return { line: line.number - 1, ch: clamped - line.from };
  }

  posToOffset(pos: Pos): number {
    const doc = this.cm.state.doc;
    const line = doc.line(Math.max(1, Math.min(pos.line + 1, doc.lines)));
    return Math.min(line.from + Math.max(0, pos.ch), line.to);
  }

  replaceRange(text: string, from: Pos, to?: Pos): void {
    const fromOffset = this.posToOffset(from);
    const toOffset = to ? this.posToOffset(to) : fromOffset;
    this.cm.dispatch({
      changes: { from: fromOffset, to: toOffset, insert: text },
    });
  }

  getValue(): string {
    return this.cm.state.doc.toString();
  }

  getLine(line: number): string {
    const doc = this.cm.state.doc;
    return doc.line(Math.max(1, Math.min(line + 1, doc.lines))).text;
  }

  lineCount(): number {
    return this.cm.state.doc.lines;
  }

  lastLine(): number {
    return this.cm.state.doc.lines - 1;
  }

  getRange(from: Pos, to: Pos): string {
    return this.cm.state.sliceDoc(this.posToOffset(from), this.posToOffset(to));
  }
}
