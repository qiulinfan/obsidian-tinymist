// Compare the plugin installed in each vault with this checkout's build, so a stale
// copy (main.js copied once and never updated) is noticed:
//   npm run build && node scripts/check-install.mjs <vault> [<vault>...]
// A symlink to this checkout is always current. Exits 1 when a copy differs.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const FILES = ["main.js", "manifest.json", "styles.css"];
const repo = resolve(new URL("..", import.meta.url).pathname);
const vaults = process.argv.slice(2);
const pluginId = JSON.parse(readFileSync(join(repo, "manifest.json"), "utf8")).id;
if (!vaults.length) {
  console.error("usage: node scripts/check-install.mjs <vault> [<vault>...]");
  process.exit(2);
}
if (!existsSync(join(repo, "main.js"))) {
  console.error("main.js is missing: run `npm run build` first");
  process.exit(2);
}
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
let stale = false;
for (const vault of vaults) {
  const dir = join(vault, ".obsidian", "plugins", pluginId);
  if (!existsSync(dir)) {
    console.log(`${vault}: not installed`);
    continue;
  }
  if (lstatSync(dir).isSymbolicLink() && realpathSync(dir) === realpathSync(repo)) {
    console.log(`${vault}: linked to this checkout`);
    continue;
  }
  const differ = FILES.filter((f) => !existsSync(join(dir, f)) || hash(join(dir, f)) !== hash(join(repo, f)));
  stale ||= differ.length > 0;
  console.log(`${vault}: ${differ.length ? `STALE (${differ.join(", ")})` : "up to date"}`);
}
process.exitCode = stale ? 1 : 0;
