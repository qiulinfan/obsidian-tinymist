import { Extension, Text } from "@codemirror/state";
import { dirname } from "path";
import { FragmentError, vaultPath } from "../lsp/fragmentRenderer";
import { hoverError, renderHover } from "./shared/renderHover";
import {
  FRAGMENT_PT,
  MathFragment,
  PreambleStatement,
  chapterStatements,
  documentStatements,
  fragmentSource,
  needsEnclosingCode,
  preambleLine,
  projectStatements,
  readSvg,
  typstMathAt,
} from "./typstFragment";

/** What compiles a fragment source in a folder (TypstFragmentRenderer). */
export interface FragmentBackend {
  render(dir: string, source: string): Promise<string>;
}

export type FragmentResult =
  | {
      ok: true;
      /** Post-processed SVG (readSvg). */
      svg: string;
      display: boolean;
      /** Size and vertical-align in em (1em = FRAGMENT_PT), so font-size changes need no render. */
      wEm: number;
      hEm: number;
      vaEm: number;
    }
  | {
      ok: false;
      message: string;
      /**
       * The preamble line Typst's error lies on (`book/chapters/ch1.typ:3: #let f(x) = x +`),
       * when it is not the formula's own.
       */
      at?: string;
    };

/** A render as cached: the result, or Typst's error with its line in the fragment document. */
type Outcome = Extract<FragmentResult, { ok: true }> | { ok: false; message: string; line: number | null };

/** Renders kept, least recently used dropped first (an SVG is about 8 KiB). */
const CACHE_SIZE = 2000;
/**
 * Renders are dropped once .typ changes have been quiet this long: well past the
 * renderer's file watcher (under 50 ms), so a render after the drop sees the last write.
 */
const CHANGE_DEBOUNCE_MS = 300;

/** cyrb53: a fast 53-bit string hash, in base 36. */
function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Typst formula renders for one vault: the preamble for a formula (project part from
 * disk, chapter part from the editor buffer), the backend call, SVG post-processing and
 * an LRU cache. A key is the folder (relative imports), a hash of the preamble, the mode
 * and the formula, so buffer edits never need an invalidation. Files the preamble
 * imports are not in the key: a changed .typ file drops the renders of every other file
 * (a file never imports itself, and its own statements are keyed) and bumps their epoch.
 */
export class TypstRender {
  /** Batches of .typ changes so far. */
  private batches = 0;
  /** Per file, the batches that changed only that file (they kept its renders). */
  private selfOnly = new Map<string, number>();
  private cache = new Map<string, { file: string; outcome: Outcome }>();
  private changed = new Set<string>();
  private changeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private backend: FragmentBackend,
    private root: string,
  ) {}

  /**
   * Bumped when the renders of `file` were dropped (another .typ file changed; its own
   * saves are keyed through the buffer); results computed across a bump are not cached.
   */
  epoch(file: string): number {
    return this.batches - (this.selfOnly.get(file) ?? 0);
  }

  /** The render of formula `m` of `file`, whose editor text is `doc`. */
  async math(file: string, doc: Text, m: MathFragment): Promise<FragmentResult> {
    const epoch = this.epoch(file);
    const statements: PreambleStatement[] = [
      ...projectStatements(file, this.root),
      ...chapterStatements(documentStatements(doc), m.from).map((s) => ({
        text: s.text,
        file,
        line: doc.lineAt(s.from).number,
      })),
    ];
    const preamble = statements.map((s) => s.text).join("\n");
    const dir = dirname(file);
    const key = `${dir}\n${hash(preamble)}\n${m.display ? "display" : "inline"}\n${m.body}`;
    const hit = this.cache.get(key);
    let outcome: Outcome;
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      outcome = hit.outcome;
    } else {
      try {
        const svg = readSvg(await this.backend.render(dir, fragmentSource(preamble, m)), `f${hash(key)}-`);
        outcome = svg
          ? {
              ok: true,
              svg: svg.svg,
              display: m.display,
              wEm: svg.width / FRAGMENT_PT,
              hEm: svg.height / FRAGMENT_PT,
              vaEm: svg.baseline === null ? 0 : -(svg.height - svg.baseline) / FRAGMENT_PT,
            }
          : { ok: false, message: "tinymist returned an unreadable SVG", line: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // No binary, a timeout or a crash says nothing about the formula: not cached.
        if (!(err instanceof FragmentError)) return { ok: false, message };
        outcome = { ok: false, message, line: err.line };
      }
      if (epoch === this.epoch(file)) {
        this.cache.set(key, { file, outcome });
        if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
      }
    }
    if (outcome.ok) return outcome;
    // Located now, not when cached: lines above a statement may have moved since.
    const at = outcome.line === null ? null : preambleLine(statements, outcome.line);
    const where = at && `${vaultPath(at.file, this.root)}:${at.line}: ${at.text}`;
    return where ? { ok: false, message: outcome.message, at: where } : { ok: false, message: outcome.message };
  }

  /** A .typ file (absolute path) was modified, created, deleted or renamed. */
  fileChanged(path: string): void {
    this.changed.add(path);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      const changed = [...this.changed];
      this.changed.clear();
      this.batches++;
      if (changed.length === 1) this.selfOnly.set(changed[0], (this.selfOnly.get(changed[0]) ?? 0) + 1);
      for (const [key, entry] of this.cache) {
        if (changed.some((p) => p !== entry.file)) this.cache.delete(key);
      }
    }, CHANGE_DEBOUNCE_MS);
  }

  dispose(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = null;
    this.cache.clear();
  }
}

/**
 * A rendered fragment as an element of `doc`: an inline span sitting on the text
 * baseline, or a centred block for display math.
 */
export function fragmentElement(r: Extract<FragmentResult, { ok: true }>, doc: Document): HTMLElement | null {
  const Parser = doc.defaultView?.DOMParser ?? DOMParser;
  const parsed = new Parser().parseFromString(r.svg, "image/svg+xml").documentElement;
  if (parsed.nodeName !== "svg") return null;
  const svg = doc.importNode(parsed, true) as unknown as SVGSVGElement;
  svg.querySelectorAll("script").forEach((el) => el.remove());
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.width = `${r.wEm}em`;
  svg.style.height = `${r.hEm}em`;
  if (!r.display) svg.style.verticalAlign = `${r.vaEm}em`;
  const box = doc.createElement(r.display ? "div" : "span");
  box.className = r.display ? "tym-fragment is-display" : "tym-fragment";
  box.append(svg);
  return box;
}

/**
 * The render hover for Typst math (a section above tinymist's text hover): the formula
 * under the pointer rendered from the current buffer, or Typst's error with the formula
 * or the preamble line it lies on. A formula that needs the code around it (a loop's or
 * closure's variable) gets no section: the document compiles, only the fragment cannot.
 */
export function typstRenderHover(host: {
  renderer(): TypstRender | null;
  path(): string | null;
  enabled(): boolean;
}): Extension {
  return renderHover<MathFragment>({
    enabled: host.enabled,
    target: (state, pos) => typstMathAt(state.doc, pos),
    render: (m, view) => {
      const renderer = host.renderer();
      const path = host.path();
      if (!renderer || !path) return null;
      const doc = view.dom.ownerDocument;
      const text = view.state.doc;
      return renderer.math(path, text, m).then((r) => {
        if (!r.ok) {
          if (!r.at && needsEnclosingCode(text, m, r.message)) return null;
          return hoverError(r.message, r.at ?? m.body, doc);
        }
        return fragmentElement(r, doc) ?? hoverError("tinymist returned an unreadable SVG", m.body, doc);
      });
    },
  });
}
