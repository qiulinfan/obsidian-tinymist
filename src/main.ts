import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import {
  App,
  FileSystemAdapter,
  Modal,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { LspTextEdit, TypstView, VIEW_TYPE_TYPST } from "./editor/typstView";
import { LspClient, LspStatus, uriToPath } from "./lsp/client";
import { PreviewManager, SourceJump } from "./preview/previewManager";
import { PreviewView, VIEW_TYPE_TYPST_PREVIEW } from "./preview/previewView";
import {
  DEFAULT_SETTINGS,
  TinymistSettings,
  TinymistSettingTab,
} from "./settings";

export default class TinymistPlugin extends Plugin {
  settings: TinymistSettings = DEFAULT_SETTINGS;
  lsp: LspClient | null = null;
  preview: PreviewManager = new PreviewManager(this);

  private diagListeners = new Set<(uri: string) => void>();
  private statusBarEl: HTMLElement | null = null;
  private resolvedBinary: string | null | undefined;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_TYPST, (leaf) => new TypstView(leaf, this));
    this.registerView(
      VIEW_TYPE_TYPST_PREVIEW,
      (leaf) => new PreviewView(leaf, this),
    );
    this.registerExtensions(["typ"], VIEW_TYPE_TYPST);

    this.statusBarEl = this.addStatusBarItem();
    this.setStatusBar("stopped");

    this.addCommand({
      id: "open-preview",
      name: "Open preview",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(TypstView);
        if (!view?.absolutePath()) return false;
        if (!checking) void this.openPreview(view);
        return true;
      },
    });

    this.addCommand({
      id: "restart-language-server",
      name: "Restart language server",
      callback: () => void this.startLsp(true),
    });

    this.addCommand({
      id: "goto-definition",
      name: "Go to definition",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(TypstView);
        if (!view) return false;
        if (!checking) void view.gotoDefinition();
        return true;
      },
    });

    this.addCommand({
      id: "format-document",
      name: "Format document",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(TypstView);
        if (!view) return false;
        if (!checking) void view.formatDocument();
        return true;
      },
    });

    this.addCommand({
      id: "rename-symbol",
      name: "Rename symbol at cursor",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(TypstView);
        if (!view || this.lsp?.status !== "running") return false;
        if (!checking) new RenameModal(this.app, this, view).open();
        return true;
      },
    });

    this.addSettingTab(new TinymistSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => void this.startLsp(false));

  }

  onunload(): void {
    this.lsp?.stop();
    this.lsp = null;
    this.preview.stop();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    this.resolvedBinary = undefined;
    await this.saveData(this.settings);
  }

  vaultBasePath(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  resolveBinary(): string | null {
    if (this.resolvedBinary !== undefined) return this.resolvedBinary;
    const candidates: string[] = [];
    if (this.settings.binaryPath.trim()) {
      candidates.push(this.settings.binaryPath.trim());
    }
    candidates.push(
      "/opt/homebrew/bin/tinymist",
      "/usr/local/bin/tinymist",
      homedir() + "/.cargo/bin/tinymist",
    );
    for (const c of candidates) {
      if (existsSync(c)) {
        this.resolvedBinary = c;
        return c;
      }
    }
    // GUI apps get a minimal PATH; ask a login shell where tinymist lives.
    const probe = spawnSync("/bin/sh", ["-lc", "command -v tinymist"], {
      encoding: "utf8",
      timeout: 4000,
    });
    const found = probe.status === 0 ? probe.stdout.trim() : "";
    this.resolvedBinary = found || null;
    return this.resolvedBinary;
  }

  onDiagnostics(cb: (uri: string) => void): () => void {
    this.diagListeners.add(cb);
    return () => this.diagListeners.delete(cb);
  }

  async startLsp(restart: boolean): Promise<void> {
    if (this.lsp) {
      if (!restart && this.lsp.status === "running") return;
      this.lsp.stop();
      this.lsp = null;
    }
    const bin = this.resolveBinary();
    const root = this.vaultBasePath();
    if (!root) return;
    if (!bin) {
      this.setStatusBar("failed");
      new Notice(
        "Tinymist: binary not found. Install tinymist (brew install " +
          "tinymist) or set its path in the plugin settings.",
        10000,
      );
      return;
    }
    const lsp = new LspClient(bin, root, (uri) => {
      for (const cb of this.diagListeners) cb(uri);
    });
    lsp.onStatusChange = (s) => this.setStatusBar(s);
    this.lsp = lsp;
    try {
      await lsp.start();
    } catch (err) {
      console.error("[tinymist] failed to start language server:", err);
      new Notice("Tinymist: failed to start language server. See console.");
      return;
    }
    this.preview.onLspRestart();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TYPST)) {
      if (leaf.view instanceof TypstView) leaf.view.reannounce();
    }
  }

  /** Handle a preview-click jump pushed by the language server. */
  jumpToSource(jump: SourceJump): void {
    if (!jump?.filepath || !jump.start) return;
    void this.openAndPlaceCursor(jump.filepath, jump.start[0], jump.start[1]);
  }

  /** Open an absolute vault file path and place the cursor. */
  async openAndPlaceCursor(
    absPath: string,
    line: number,
    character: number,
  ): Promise<void> {
    const base = this.vaultBasePath();
    if (!base || !absPath.startsWith(base + "/")) return;
    const rel = absPath.slice(base.length + 1);
    const file = this.app.vault.getAbstractFileByPath(rel);
    if (!(file instanceof TFile)) return;

    let leaf =
      this.app.workspace
        .getLeavesOfType(VIEW_TYPE_TYPST)
        .find(
          (l) => l.view instanceof TypstView && l.view.file?.path === rel,
        ) ?? null;
    if (leaf) {
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    } else {
      leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
    }
    if (leaf.view instanceof TypstView) leaf.view.setCursor(line, character);
  }

  /** Apply an LSP WorkspaceEdit across open views and on-disk files. */
  async applyWorkspaceEdit(edit: unknown): Promise<number> {
    const perFile = new Map<string, LspTextEdit[]>();
    const e = edit as {
      changes?: Record<string, LspTextEdit[]>;
      documentChanges?: Array<{
        textDocument?: { uri?: string };
        edits?: LspTextEdit[];
      }>;
    } | null;
    if (e?.changes) {
      for (const [uri, edits] of Object.entries(e.changes)) {
        perFile.set(uriToPath(uri), edits);
      }
    } else if (e?.documentChanges) {
      for (const dc of e.documentChanges) {
        if (dc.textDocument?.uri && dc.edits) {
          perFile.set(uriToPath(dc.textDocument.uri), dc.edits);
        }
      }
    }
    let count = 0;
    for (const [absPath, edits] of perFile) {
      if (!edits.length) continue;
      count += edits.length;
      const view = this.app.workspace
        .getLeavesOfType(VIEW_TYPE_TYPST)
        .map((l) => l.view)
        .find(
          (v): v is TypstView =>
            v instanceof TypstView && v.absolutePath() === absPath,
        );
      if (view) {
        view.applyTextEdits(edits);
      } else {
        await this.applyEditsToFile(absPath, edits);
      }
    }
    return count;
  }

  private async applyEditsToFile(
    absPath: string,
    edits: LspTextEdit[],
  ): Promise<void> {
    const base = this.vaultBasePath();
    if (!base || !absPath.startsWith(base + "/")) return;
    const rel = absPath.slice(base.length + 1);
    const adapter = this.app.vault.adapter;
    let text: string;
    try {
      text = await adapter.read(rel);
    } catch {
      return;
    }
    // Line-start offsets for position -> offset conversion.
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") starts.push(i + 1);
    }
    const toOffset = (p: { line: number; character: number }): number => {
      const lineStart = starts[Math.min(p.line, starts.length - 1)];
      const lineEnd =
        p.line + 1 < starts.length ? starts[p.line + 1] - 1 : text.length;
      return Math.min(lineStart + p.character, lineEnd);
    };
    const resolved = edits
      .map((e2) => ({
        from: toOffset(e2.range.start),
        to: toOffset(e2.range.end),
        insert: e2.newText,
      }))
      .sort((a, b) => b.from - a.from);
    for (const r of resolved) {
      text = text.slice(0, r.from) + r.insert + text.slice(r.to);
    }
    await adapter.write(rel, text);
  }

  private async openPreview(view: TypstView): Promise<void> {
    const path = view.absolutePath();
    if (!path) return;
    let url: string;
    try {
      url = await this.preview.start(path);
    } catch (err) {
      console.error("[tinymist] preview failed:", err);
      new Notice(`Tinymist preview failed: ${String(err)}`, 8000);
      return;
    }
    let leaf: WorkspaceLeaf | null =
      this.app.workspace.getLeavesOfType(VIEW_TYPE_TYPST_PREVIEW)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("split", "vertical");
      await leaf.setViewState({ type: VIEW_TYPE_TYPST_PREVIEW, active: false });
    }
    if (leaf.view instanceof PreviewView) leaf.view.setUrl(url);
    void this.app.workspace.revealLeaf(leaf);
  }

  private setStatusBar(status: LspStatus | "stopped"): void {
    this.statusBarEl?.setText(`Tinymist: ${status}`);
  }
}

class RenameModal extends Modal {
  private input: HTMLInputElement | null = null;

  constructor(
    app: App,
    private plugin: TinymistPlugin,
    private view: TypstView,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Rename symbol");
    this.input = this.contentEl.createEl("input", {
      type: "text",
      cls: "tym-rename-input",
      attr: { placeholder: "New name" },
    });
    this.input.focus();
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.submit();
      }
    });
  }

  private async submit(): Promise<void> {
    const newName = this.input?.value.trim();
    const pos = this.view.cursorPosition();
    const path = this.view.absolutePath();
    this.close();
    if (!newName || !pos || !path) return;
    const lsp = this.plugin.lsp;
    if (lsp?.status !== "running") return;
    try {
      const edit = await lsp.rename(path, pos, newName);
      if (!edit) {
        new Notice("Tinymist: nothing to rename here.");
        return;
      }
      const count = await this.plugin.applyWorkspaceEdit(edit);
      new Notice(`Tinymist: renamed ${count} occurrence(s).`);
    } catch (err) {
      new Notice(`Tinymist rename failed: ${String(err)}`, 6000);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
