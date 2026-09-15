import { existsSync } from "fs";
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
