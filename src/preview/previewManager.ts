import { ChildProcess, spawn } from "child_process";
import type TinymistPlugin from "../main";

/**
 * Runs one `tinymist preview` process for the file currently being
 * previewed. The process watches files on disk and pushes incremental
 * updates to its embedded page; the editor's save debounce makes that feel
 * live. Replaced by LSP-integrated preview in roadmap v0.2.
 */
export class PreviewManager {
  url: string | null = null;
  filePath: string | null = null;
  private proc: ChildProcess | null = null;

  constructor(private plugin: TinymistPlugin) {}

  async start(filePath: string): Promise<string> {
    if (this.proc && this.filePath === filePath && this.url) return this.url;
    this.stop();

    const bin = this.plugin.resolveBinary();
    if (!bin) throw new Error("tinymist binary not found; set it in settings");
    const root = this.plugin.vaultBasePath();
    if (!root) throw new Error("vault is not on the local filesystem");

    const args = ["preview", "--root", root, "--no-open", filePath];
    if (this.plugin.settings.invertPreviewColors !== "never") {
      args.splice(1, 0, `--invert-colors=${this.plugin.settings.invertPreviewColors}`);
    }

    this.filePath = filePath;
    const proc = spawn(bin, args, { cwd: root });
    this.proc = proc;

    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("preview server did not start within 20s"));
        this.stop();
      }, 20000);
      const scan = (chunk: Buffer) => {
        const m = /Static file server listening on: (\S+)/.exec(String(chunk));
        if (m) {
          clearTimeout(timer);
          resolve("http://" + m[1]);
        }
      };
      proc.stdout?.on("data", scan);
      proc.stderr?.on("data", (c: Buffer) => {
        scan(c);
        console.debug("[tinymist:preview]", String(c).trimEnd());
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        if (this.proc === proc) {
          this.proc = null;
          this.url = null;
        }
        reject(new Error(`tinymist preview exited with code ${code}`));
      });
    });
    this.url = url;
    return url;
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.url = null;
    this.filePath = null;
  }
}
