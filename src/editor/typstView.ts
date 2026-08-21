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
import { bracketMatching, syntaxHighlighting } from "@codemirror/language";
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
import {
  lspCompletionSource,
  lspDiagnosticsToCm,
  lspHoverTooltip,
} from "./lspExtensions";
import { typstHighlightStyle, typstLanguage } from "./typstLanguage";

export const VIEW_TYPE_TYPST = "tinymist-typst";

export class TypstView extends TextFileView {
  private editor: EditorView | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
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
        syntaxHighlighting(typstHighlightStyle),
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
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) this.onEdited();
        }),
      ],
    });
  }

  private onEdited(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      const path = this.absolutePath();
      if (path && this.editor && this.plugin.lsp?.status === "running") {
        this.plugin.lsp.didChange(path, this.editor.state.doc.toString());
      }
    }, 150);

    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save().then(() => {
        const path = this.absolutePath();
        if (path) this.plugin.lsp?.didSave(path);
      });
    }, this.plugin.settings.saveDebounceMs);
  }

  private flushTimers(): void {
    if (this.changeTimer) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
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
