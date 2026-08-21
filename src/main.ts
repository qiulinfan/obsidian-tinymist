import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { FileSystemAdapter, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { TypstView, VIEW_TYPE_TYPST } from "./editor/typstView";
import { LspClient, LspStatus } from "./lsp/client";
import { PreviewManager } from "./preview/previewManager";
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
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TYPST)) {
      if (leaf.view instanceof TypstView) leaf.view.reannounce();
    }
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
