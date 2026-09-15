import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const temporary = mkdtempSync(join(tmpdir(), "tinymist-tests-"));
try {
  const outfile = join(temporary, "preview.cjs");
  await build({
    entryPoints: ["tests/previewEntry.test.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
  });
  execFileSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
