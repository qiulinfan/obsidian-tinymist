import type TinymistPlugin from "../main";

interface PreviewResult {
  dataPlanePort?: string | number;
  staticServerPort?: string | number;
  isPrimary?: boolean;
}

export interface SourceJump {
  filepath: string;
  start: [number, number] | null;
  end: [number, number] | null;
}

/**
 * Drives one preview task inside the tinymist LSP session
 * (`tinymist.doStartPreview`). The LSP compiles from in-memory buffers, so
 * unsaved edits render; ports are dynamic; clicking the preview makes the
 * server push a `tinymist/preview/scrollSource` jump handled by the plugin.
 */
export class PreviewManager {
  url: string | null = null;
  filePath: string | null = null;
  private taskId: string | null = null;
  private handlersRegistered = false;

  constructor(private plugin: TinymistPlugin) {}

  private registerHandlers(): void {
    const lsp = this.plugin.lsp;
    if (!lsp) return;
    lsp.onNotification("tinymist/preview/dispose", (params) => {
      const { taskId } = (params as { taskId?: string }) ?? {};
      if (taskId && taskId === this.taskId) {
        this.taskId = null;
        this.url = null;
        this.filePath = null;
      }
    });
    lsp.onNotification("tinymist/preview/scrollSource", (params) => {
      this.plugin.jumpToSource(params as SourceJump);
    });
    this.handlersRegistered = true;
  }

  /** Called by the plugin after a language-server (re)start. */
  onLspRestart(): void {
    this.handlersRegistered = false;
    this.taskId = null;
    this.url = null;
    this.filePath = null;
  }

  async start(filePath: string): Promise<string> {
    const lsp = this.plugin.lsp;
    if (!lsp || lsp.status !== "running") {
      throw new Error("language server is not running");
    }
    if (this.taskId && this.filePath === filePath && this.url) {
      return this.url;
    }
    await this.stop();
    if (!this.handlersRegistered) this.registerHandlers();

    const taskId = Math.random().toString(36).slice(2, 9);
    const args = [
      "--task-id",
      taskId,
      "--data-plane-host",
      "127.0.0.1:0",
      // SVG in-window rendering keeps real page elements in the DOM, which
      // click-to-source jumping needs (canvas pages are not clickable).
      "--partial-rendering=true",
    ];
    if (this.plugin.settings.invertPreviewColors !== "never") {
      args.push(`--invert-colors=${this.plugin.settings.invertPreviewColors}`);
    }
    args.push(filePath);

    const result = await lsp.executeCommand<PreviewResult>(
      "tinymist.doStartPreview",
      [args],
      20000,
    );
    const port = result?.staticServerPort;
    if (!port) throw new Error("preview did not report a server port");

    this.taskId = taskId;
    this.filePath = filePath;
    this.url = `http://127.0.0.1:${port}`;
    return this.url;
  }

  /** Editor cursor moved: scroll the preview to the source position. */
  cursorMoved(filepath: string, line: number, character: number): void {
    const lsp = this.plugin.lsp;
    if (!lsp || lsp.status !== "running" || !this.taskId) return;
    void lsp
      .executeCommand("tinymist.scrollPreview", [
        this.taskId,
        { event: "panelScrollTo", filepath, line, character },
      ])
      .catch(() => {});
  }

  async stop(): Promise<void> {
    const taskId = this.taskId;
    this.taskId = null;
    this.url = null;
    this.filePath = null;
    if (!taskId) return;
    const lsp = this.plugin.lsp;
    if (lsp && lsp.status === "running") {
      await lsp
        .executeCommand("tinymist.doKillPreview", [taskId], 5000)
        .catch(() => {});
    }
  }
}
