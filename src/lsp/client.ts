import { spawn, ChildProcess } from "child_process";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  message: string;
  source?: string;
}

export type LspStatus = "starting" | "running" | "stopped" | "failed";

export function pathToUri(p: string): string {
  return "file://" + p.split("/").map(encodeURIComponent).join("/");
}

export function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Minimal LSP client over stdio. Full-text document sync only. Unknown
 * server->client requests are answered with a null result on purpose; extend
 * explicitly when a feature needs more.
 */
export class LspClient {
  status: LspStatus = "stopped";
  onStatusChange: ((s: LspStatus) => void) | null = null;

  private proc: ChildProcess | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private versions = new Map<string, number>();
  private diagnosticsByUri = new Map<string, LspDiagnostic[]>();

  constructor(
    private binPath: string,
    private rootPath: string,
    private onDiagnostics: (uri: string) => void,
  ) {}

  diagnostics(uri: string): LspDiagnostic[] {
    return this.diagnosticsByUri.get(uri) ?? [];
  }

  async start(): Promise<void> {
    this.setStatus("starting");
    this.proc = spawn(this.binPath, ["lsp"], {
      cwd: this.rootPath,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.on("error", (err) => {
      console.error("[tinymist] spawn failed:", err);
      this.setStatus("failed");
    });
    this.proc.on("exit", (code) => {
      if (this.status !== "stopped") {
        console.error(`[tinymist] lsp exited with code ${code}`);
        this.setStatus("failed");
      }
      this.rejectAll(new Error("language server exited"));
    });
    this.proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      console.debug("[tinymist:lsp]", String(chunk).trimEnd());
    });

    await this.request(
      "initialize",
      {
        processId: process.pid,
        rootUri: pathToUri(this.rootPath),
        workspaceFolders: [
          { uri: pathToUri(this.rootPath), name: "vault" },
        ],
        capabilities: {
          textDocument: {
            synchronization: { didSave: true },
            publishDiagnostics: { relatedInformation: false },
            completion: {
              completionItem: {
                snippetSupport: true,
                documentationFormat: ["markdown", "plaintext"],
              },
            },
            hover: { contentFormat: ["markdown", "plaintext"] },
          },
          workspace: { configuration: true },
        },
        initializationOptions: {
          exportPdf: "never",
          formatterMode: "typstyle",
        },
      },
      20000,
    );
    this.notify("initialized", {});
    this.setStatus("running");
  }

  stop(): void {
    const proc = this.proc;
    this.setStatus("stopped");
    this.rejectAll(new Error("client stopped"));
    if (!proc) return;
    this.proc = null;
    try {
      this.sendRaw({ jsonrpc: "2.0", id: this.nextId++, method: "shutdown" }, proc);
      this.sendRaw({ jsonrpc: "2.0", method: "exit" }, proc);
    } catch {
      // ignore; we kill below anyway
    }
    setTimeout(() => {
      if (!proc.killed) proc.kill();
    }, 500);
  }

  didOpen(path: string, text: string): void {
    const uri = pathToUri(path);
    this.versions.set(uri, 1);
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "typst", version: 1, text },
    });
  }

  didChange(path: string, text: string): void {
    const uri = pathToUri(path);
    const version = (this.versions.get(uri) ?? 1) + 1;
    this.versions.set(uri, version);
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  didSave(path: string): void {
    this.notify("textDocument/didSave", {
      textDocument: { uri: pathToUri(path) },
    });
  }

  didClose(path: string): void {
    const uri = pathToUri(path);
    this.versions.delete(uri);
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  completion(path: string, pos: LspPosition): Promise<unknown> {
    return this.request(
      "textDocument/completion",
      { textDocument: { uri: pathToUri(path) }, position: pos },
      5000,
    );
  }

  hover(path: string, pos: LspPosition): Promise<unknown> {
    return this.request(
      "textDocument/hover",
      { textDocument: { uri: pathToUri(path) }, position: pos },
      5000,
    );
  }

  private setStatus(s: LspStatus): void {
    this.status = s;
    this.onStatusChange?.(s);
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buf.subarray(0, headerEnd).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) return;
      const body = this.buf.subarray(start, start + len).toString("utf8");
      this.buf = this.buf.subarray(start + len);
      try {
        this.handleMessage(JSON.parse(body));
      } catch (err) {
        console.error("[tinymist] bad message:", err);
      }
    }
  }

  private handleMessage(msg: {
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { message?: string };
  }): void {
    if (msg.method !== undefined && msg.id !== undefined) {
      // Server -> client request. workspace/configuration gets one null per
      // item (tinymist falls back to initializationOptions/defaults); every
      // other request is acknowledged with null.
      let result: unknown = null;
      if (msg.method === "workspace/configuration") {
        const items =
          (msg.params as { items?: unknown[] } | undefined)?.items ?? [];
        result = items.map(() => null);
      }
      this.send({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    if (msg.method !== undefined) {
      if (msg.method === "textDocument/publishDiagnostics") {
        const params = msg.params as {
          uri: string;
          diagnostics?: LspDiagnostic[];
        };
        this.diagnosticsByUri.set(params.uri, params.diagnostics ?? []);
        this.onDiagnostics(params.uri);
      }
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? "LSP error"));
      else p.resolve(msg.result);
    }
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!this.proc) return Promise.reject(new Error("not started"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(msg: object): void {
    if (!this.proc) return;
    this.sendRaw(msg, this.proc);
  }

  private sendRaw(msg: object, proc: ChildProcess): void {
    const json = JSON.stringify(msg);
    proc.stdin?.write(
      `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`,
    );
  }
}
