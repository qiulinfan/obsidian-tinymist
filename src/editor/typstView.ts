import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { TextFileView, WorkspaceLeaf } from "obsidian";
import { pathToUri } from "../lsp/client";
import type TinymistPlugin from "../main";
import { typstHighlightPlugin } from "./highlightPlugin";
import {
  lspCompletionSource,
  lspDiagnosticsToCm,
  lspHoverTooltip,
  offsetToPos,
  posToOffset,
} from "./lspExtensions";
import {
  SemanticLegend,
  decodeSemanticTokens,
  semanticTokensExtension,
  setSemanticActive,
  setSemanticTokens,
} from "./semanticTokens";
import { typstLanguage } from "./typstLanguage";

interface LspRangeLike {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface LspTextEdit {
  range: LspRangeLike;
  newText: string;
}

export const VIEW_TYPE_TYPST = "tinymist-typst";

export class TypstView extends TextFileView {
  private editor: EditorView | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private semanticTimer: ReturnType<typeof setTimeout> | null = null;
  private semanticGeneration = 0;
  private detachDiagListener: (() => void) | null = null;
  private openedLspPath: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: TinymistPlugin,
  ) {
    super(leaf);
    this.detachDiagListener = plugin.onDiagnostics((uri) =>
      this.applyDiagnostics(uri),
    );
  }

  getViewType(): string {
    return VIEW_TYPE_TYPST;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "Typst";
  }

  getIcon(): string {
    return "sigma";
  }

  getViewData(): string {
    return this.editor ? this.editor.state.doc.toString() : this.data;
  }

  setViewData(data: string, clear: boolean): void {
    this.data = data;
    if (!this.editor) {
      this.editor = new EditorView({
        state: this.freshState(data),
        parent: this.contentEl,
      });
      this.contentEl.addClass("tym-editor-content");
    } else if (clear) {
      this.editor.setState(this.freshState(data));
    } else if (data !== this.editor.state.doc.toString()) {
      this.editor.dispatch({
        changes: {
          from: 0,
          to: this.editor.state.doc.length,
          insert: data,
        },
      });
    }
    this.syncLspOpen(data);
  }

  clear(): void {
    this.flushTimers();
    if (this.openedLspPath) {
      this.plugin.lsp?.didClose(this.openedLspPath);
      this.openedLspPath = null;
    }
  }

  async onClose(): Promise<void> {
    this.flushTimers();
    if (this.openedLspPath) {
      this.plugin.lsp?.didClose(this.openedLspPath);
      this.openedLspPath = null;
    }
    this.detachDiagListener?.();
    this.detachDiagListener = null;
    this.editor?.destroy();
    this.editor = null;
    await super.onClose();
  }

  /** Absolute filesystem path of the open file, or null. */
  absolutePath(): string | null {
    const base = this.plugin.vaultBasePath();
    if (!base || !this.file) return null;
    return base + "/" + this.file.path;
  }

  /** Re-announce the open buffer, e.g. after a language-server restart. */
  reannounce(): void {
    this.openedLspPath = null;
    if (this.editor) this.syncLspOpen(this.editor.state.doc.toString());
  }

  private freshState(data: string): EditorState {
    return EditorState.create({
      doc: data,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        bracketMatching(),
        closeBrackets(),
        EditorView.lineWrapping,
        typstLanguage,
        typstHighlightPlugin,
        semanticTokensExtension,
        lintGutter(),
        autocompletion({
          override: [
            lspCompletionSource(
              () => this.plugin.lsp,
              () => this.absolutePath(),
            ),
          ],
        }),
        lspHoverTooltip(
          this.plugin.app,
          () => this.plugin.lsp,
          () => this.absolutePath(),
        ),
        keymap.of([
          {
            key: "F12",
            run: () => {
              void this.gotoDefinition();
              return true;
            },
          },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        EditorView.domEventHandlers({
          mousedown: (event, view) => {
            if (!(event.metaKey || event.ctrlKey)) return false;
            const pos = view.posAtCoords({
              x: event.clientX,
              y: event.clientY,
            });
            if (pos == null) return false;
            view.dispatch({ selection: { anchor: pos } });
            void this.gotoDefinition();
            return true;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) this.onEdited();
          if (update.selectionSet || update.docChanged) this.onCursorMoved();
        }),
      ],
    });
  }

  private onEdited(): void {
    // Sync the buffer immediately: completion/hover requests race a debounce.
    const path = this.absolutePath();
    if (path && this.editor && this.plugin.lsp?.status === "running") {
      this.plugin.lsp.didChange(path, this.editor.state.doc.toString());
    }
    this.scheduleSemanticTokens();

    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save().then(() => {
        const path = this.absolutePath();
        if (path) this.plugin.lsp?.didSave(path);
      });
    }, this.plugin.settings.saveDebounceMs);
  }

  private onCursorMoved(): void {
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null;
      const path = this.absolutePath();
      if (!path || !this.editor) return;
      const pos = offsetToPos(
        this.editor.state.doc,
        this.editor.state.selection.main.head,
      );
      this.plugin.preview.cursorMoved(path, pos.line, pos.character);
    }, 300);
  }

  /** Current cursor position in LSP line/character terms. */
  cursorPosition(): { line: number; character: number } | null {
    if (!this.editor) return null;
    return offsetToPos(
      this.editor.state.doc,
      this.editor.state.selection.main.head,
    );
  }

  /** Place the cursor, scroll it into view, and focus the editor. */
  setCursor(line: number, character: number): void {
    if (!this.editor) return;
    const pos = posToOffset(this.editor.state.doc, { line, character });
    this.editor.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    this.editor.focus();
  }

  /** Apply LSP text edits (offsets resolved against the current doc). */
  applyTextEdits(edits: LspTextEdit[]): void {
    if (!this.editor || !edits.length) return;
    const doc = this.editor.state.doc;
    this.editor.dispatch({
      changes: edits.map((e) => ({
        from: posToOffset(doc, e.range.start),
        to: posToOffset(doc, e.range.end),
        insert: e.newText,
      })),
    });
  }

  async gotoDefinition(): Promise<void> {
    const path = this.absolutePath();
    const lsp = this.plugin.lsp;
    if (!path || !this.editor || lsp?.status !== "running") return;
    const pos = offsetToPos(
      this.editor.state.doc,
      this.editor.state.selection.main.head,
    );
    let raw: unknown;
    try {
      raw = await lsp.definition(path, pos);
    } catch {
      return;
    }
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (!first) return;
    const loc = first as {
      uri?: string;
      range?: LspRangeLike;
      targetUri?: string;
      targetSelectionRange?: LspRangeLike;
      targetRange?: LspRangeLike;
    };
    const uri = loc.uri ?? loc.targetUri;
    const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
    if (!uri || !range) return;
    await this.plugin.openAndPlaceCursor(
      decodeURIComponent(uri.replace(/^file:\/\//, "")),
      range.start.line,
      range.start.character,
    );
  }

  async formatDocument(): Promise<void> {
    const path = this.absolutePath();
    const lsp = this.plugin.lsp;
    if (!path || !this.editor || lsp?.status !== "running") return;
    let edits: unknown;
    try {
      edits = await lsp.formatting(path);
    } catch {
      return;
    }
    if (Array.isArray(edits) && edits.length) {
      this.applyTextEdits(edits as LspTextEdit[]);
    }
  }

  private scheduleSemanticTokens(): void {
    if (this.semanticTimer) clearTimeout(this.semanticTimer);
    this.semanticTimer = setTimeout(() => {
      this.semanticTimer = null;
      void this.fetchSemanticTokens();
    }, 300);
  }

  private async fetchSemanticTokens(): Promise<void> {
    const path = this.absolutePath();
    const lsp = this.plugin.lsp;
    if (!path || !this.editor || lsp?.status !== "running") return;
    const provider = (
      lsp.serverCapabilities as {
        semanticTokensProvider?: { legend?: SemanticLegend };
      } | null
    )?.semanticTokensProvider;
    const legend = provider?.legend;
    if (!legend?.tokenTypes?.length) return;

    const generation = ++this.semanticGeneration;
    const requestDoc = this.editor.state.doc;
    let res: unknown;
    try {
      res = await lsp.semanticTokensFull(path);
    } catch {
      return;
    }
    const data = (res as { data?: number[] } | null)?.data;
    if (!data || !this.editor) return;
    // Drop stale responses: a newer edit already rescheduled a fetch.
    if (
      generation !== this.semanticGeneration ||
      this.editor.state.doc !== requestDoc
    ) {
      return;
    }
    this.editor.dispatch({
      effects: [
        setSemanticActive.of(true),
        setSemanticTokens.of(
          decodeSemanticTokens(this.editor.state.doc, data, legend),
        ),
      ],
    });
  }

  private flushTimers(): void {
    if (this.cursorTimer) {
      clearTimeout(this.cursorTimer);
      this.cursorTimer = null;
    }
    if (this.semanticTimer) {
      clearTimeout(this.semanticTimer);
      this.semanticTimer = null;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.save();
    }
  }

  private syncLspOpen(data: string): void {
    const path = this.absolutePath();
    if (!path || this.plugin.lsp?.status !== "running") return;
    if (this.openedLspPath === path) return;
    if (this.openedLspPath) this.plugin.lsp.didClose(this.openedLspPath);
    this.openedLspPath = path;
    this.plugin.lsp.didOpen(path, data);
    this.applyDiagnostics(pathToUri(path));
    this.scheduleSemanticTokens();
  }

  private applyDiagnostics(uri: string): void {
    const path = this.absolutePath();
    if (!path || !this.editor) return;
    if (uri !== pathToUri(path)) return;
    const diags = this.plugin.lsp?.diagnostics(uri) ?? [];
    this.editor.dispatch(
      setDiagnostics(this.editor.state, lspDiagnosticsToCm(this.editor.state, diags)),
    );
  }
}
