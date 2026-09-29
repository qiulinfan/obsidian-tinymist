import { existsSync, readFileSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";

export const PREVIEW_TEMPLATE = ".tinymist-preview.typ";

export interface PreviewEntry {
  filePath: string;
  sourceInput?: string;
}

/** A project-owned Typst entry wraps the source without rewriting its buffer. */
export function previewEntry(filePath: string, vaultRoot: string): PreviewEntry {
  const root = resolve(vaultRoot);
  const source = resolve(filePath);
  const rel = relative(root, source);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error("preview source must be inside the vault");
  }
  if (basename(source) !== PREVIEW_TEMPLATE) {
    for (let dir = dirname(source); ; dir = dirname(dir)) {
      const template = join(dir, PREVIEW_TEMPLATE);
      if (existsSync(template)) {
        return { filePath: template, sourceInput: `/${rel.split(sep).join("/")}` };
      }
      if (dir === root) break;
    }
  }
  return { filePath: source };
}

/**
 * The book entry a chapter compiles in: the nearest `main.typ` between the file's
 * folder and the vault root that includes the file (e.g. `#include
 * "chapters/04-LLN.typ"`, relative to main.typ, or `"/..."` from the vault root; not in
 * a comment). Pinned as tinymist's main, it makes labels from other chapters complete
 * in `@` and compiles the chapter in context. A file main.typ does not include keeps
 * its own diagnostics.
 */
export function bookMain(filePath: string, vaultRoot: string): string | null {
  const root = resolve(vaultRoot);
  const source = resolve(filePath);
  const rel = relative(root, source);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
  for (let dir = dirname(source); ; dir = dirname(dir)) {
    const main = join(dir, "main.typ");
    if (main !== source && existsSync(main)) {
      let text = "";
      try {
        text = readFileSync(main, "utf8");
      } catch {
        // unreadable: not a book entry
      }
      const code = text.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, "");
      for (const [, path] of code.matchAll(/\binclude\s+"([^"\n]+)"/g)) {
        if (resolve(path.startsWith("/") ? root : dir, path.replace(/^\/+/, "")) === source) return main;
      }
    }
    if (dir === root || dirname(dir) === dir) return null;
  }
}
