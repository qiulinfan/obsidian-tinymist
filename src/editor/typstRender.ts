import { Extension, Text } from "@codemirror/state";
import { dirname, join, resolve } from "path";
import { FragmentError, vaultPath } from "../lsp/fragmentRenderer";
import type { FragmentRenderer, RenderRequest, RenderResult } from "./shared/livePreview";
import { hoverError, renderHover } from "./shared/renderHover";
import {
  FRAGMENT_PT,
  MathFragment,
  PreambleStatement,
  TopLevelStatement,
  chapterStatements,
  documentStatements,
  fragmentSource,
  hash,
  inChapterPreamble,
  needsEnclosingCode,
  preambleLine,
  projectStatements,
  readSvg,
  typFilesNamed,
  typFilesNamedIn,
  typstMathAt,
} from "./typstFragment";
import { PreambleFailure, isTypstMathRequest } from "./typstLive";

/** What compiles a fragment source in a folder (TypstFragmentRenderer). */
export interface FragmentBackend {
  render(dir: string, source: string): Promise<string>;
}

/** A rendered formula. */
export interface RenderedFragment {
  ok: true;
  /** Post-processed SVG (readSvg). */
  svg: string;
  display: boolean;
  /** Size and vertical-align in em (1em = FRAGMENT_PT), so font-size changes need no render. */
  wEm: number;
  hEm: number;
  vaEm: number;
}

export type FragmentResult =
  | RenderedFragment
  | {
      ok: false;
      message: string;
      /**
       * The preamble line Typst's error lies on (`book/chapters/ch1.typ:3: #let f(x) = x +`),
       * when it is not the formula's own.
       */
      at?: string;
      /**
       * With `at`: the formula's last rendering under the same statements of its own file,
       * from before a statement it imports broke (the book main's, a template's).
       */
      last?: RenderedFragment;
      /** The renderer itself failed (no binary, a timeout, a crash): not the formula's fault. */
      transient?: true;
    };

/** How a .typ file changed (Obsidian's vault events). */
export type FileEvent = "modify" | "create" | "delete" | "rename";

/** A render as cached: the result, or Typst's error with its line in the fragment document. */
type Outcome = RenderedFragment | { ok: false; message: string; line: number | null };

/** Renders kept, least recently used dropped first (an SVG is about 8 KiB). */
const CACHE_SIZE = 2000;
/**
 * Renders are dropped once .typ changes have been quiet this long: well past the
 * renderer's file watcher (under 50 ms), so a render after the drop sees the last write.
 */
const CHANGE_DEBOUNCE_MS = 300;

/**
 * Typst formula renders for one vault: the preamble for a formula (project part from
 * disk, chapter part from the editor buffer), the backend call, SVG post-processing and
 * an LRU cache. A key is the folder (relative imports), a hash of the preamble, the mode
 * and the formula, so buffer edits never need an invalidation. The files a preamble reads
 * are not in the key: when one of them is modified, the renders of the files whose
 * preambles read it (dependencies) are dropped and their epoch bumped. A file created,
 * deleted or renamed drops those of every other file. A file never reads itself, and a
 * book's chapters read neither each other nor the book main's includes, so a chapter's
 * autosave (at every typing pause) leaves the other open chapters alone.
 */
export class TypstRender {
  /** Per file, the times its renders were dropped or its failures retried. */
  private epochs = new Map<string, number>();
  /** Per file rendered, the .typ files its preambles may read (dependencies). */
  private reads = new Map<string, ReadonlySet<string>>();
  /** Per .typ file read for `reads`, the .typ files it names (until it changes). */
  private named = new Map<string, readonly string[]>();
  /**
   * Renders that failed for want of the renderer (not cached), by file and key, and whether
   * they were already tried again when the renderer answered another render.
   */
  private failed = new Map<string, { file: string; retried: boolean }>();
  /** Per formula of a file under its own statements above it, its last rendering. */
  private last = new Map<string, RenderedFragment>();
  private listeners = new Set<() => void>();
  private cache = new Map<string, { file: string; outcome: Outcome }>();
  /** The paths changed since the last batch, and whether one came, went or moved. */
  private changed = new Map<string, boolean>();
  private changeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private backend: FragmentBackend,
    private root: string,
  ) {}

  /**
   * Bumped when the renders of `file` were dropped (a file its preambles read changed; its
   * own saves are keyed through the buffer) or its renderer failures are tried again;
   * results computed across a bump are not cached.
   */
  epoch(file: string): number {
    return this.epochs.get(file) ?? 0;
  }

  /** Called after epochs may have changed (a batch of .typ changes, a retry). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * After the renderer may have been fixed (a settings save, live mode switched on): the
   * files with renders that failed for want of it get a new epoch, so live views that keep
   * those failures render them again.
   */
  retryFailed(): void {
    this.retry(() => true);
    this.failed.clear();
  }

  /**
   * Bump the epochs of the files with a renderer failure `which` selects (marked retried).
   * When the renderer answers a render, each failure not retried yet is tried once more (it
   * came back from a slow start or a restart); one that fails again (its own compile passes
   * the timeout) waits for retryFailed, so retries never loop.
   */
  private retry(which: (f: { retried: boolean }) => boolean): void {
    const files = new Set<string>();
    for (const f of this.failed.values()) {
      if (!which(f)) continue;
      f.retried = true;
      files.add(f.file);
    }
    if (!files.size) return;
    for (const file of files) this.epochs.set(file, this.epoch(file) + 1);
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** The render of formula `m` of `file`, whose editor text is `doc`. */
  async math(file: string, doc: Text, m: MathFragment): Promise<FragmentResult> {
    const epoch = this.epoch(file);
    const project = projectStatements(file, this.root);
    const own = documentStatements(doc);
    this.reads.set(file, this.dependencies(file, project, own));
    const chapter = chapterStatements(own, m.from);
    const statements: PreambleStatement[] = [
      ...project,
      ...chapter.map((s) => ({ text: s.text, file, line: doc.lineAt(s.from).number })),
    ];
    const preamble = statements.map((s) => s.text).join("\n");
    const dir = dirname(file);
    const mode = m.display ? "display" : "inline";
    const key = `${dir}\n${hash(preamble)}\n${mode}\n${m.body}`;
    // The formula under its file's own statements: the book main and templates aside.
    const formula = `${file}\n${hash(chapter.map((s) => s.text).join("\n"))}\n${mode}\n${m.body}`;
    const hit = this.cache.get(key);
    let outcome: Outcome;
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      outcome = hit.outcome;
    } else {
      const id = `${file}\n${key}`;
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
        if (!(err instanceof FragmentError)) {
          if (!this.failed.has(id)) this.failed.set(id, { file, retried: false });
          return { ok: false, message, transient: true };
        }
        outcome = { ok: false, message, line: err.line };
      }
      if (epoch === this.epoch(file)) {
        this.cache.set(key, { file, outcome });
        if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
      }
      // The renderer answered: its failures not retried yet go again (this one too, when a
      // hover rendered what a live view keeps as failed).
      this.retry((f) => !f.retried);
      this.failed.delete(id);
    }
    if (outcome.ok) {
      this.last.delete(formula);
      this.last.set(formula, outcome);
      if (this.last.size > CACHE_SIZE) this.last.delete(this.last.keys().next().value!);
      return outcome;
    }
    // Located now, not when cached: lines above a statement may have moved since.
    const at = outcome.line === null ? null : preambleLine(statements, outcome.line);
    if (!at) return { ok: false, message: outcome.message };
    const where = `${vaultPath(at.file, this.root)}:${at.line}: ${at.text}`;
    const last = this.last.get(formula);
    const failure = { ok: false as const, message: outcome.message, at: where };
    return last ? { ...failure, last } : failure;
  }

  /**
   * The .typ files the preambles of `file`'s formulas may read: the book mains bookMain may
   * find (a `main.typ` in its folder and each one above: one may start including it), the
   * files the project statements come from, and the .typ files those statements and the
   * file's own preamble statements name, followed through the text of each file named.
   */
  private dependencies(
    file: string,
    project: readonly PreambleStatement[],
    own: readonly TopLevelStatement[],
  ): Set<string> {
    const out = new Set<string>();
    const queue: string[] = [];
    const add = (path: string, follow: boolean) => {
      if (path === file || out.has(path)) return;
      out.add(path);
      if (follow) queue.push(path);
    };
    const top = resolve(this.root);
    for (let dir = dirname(file); ; dir = dirname(dir)) {
      add(join(dir, "main.typ"), false);
      if (dir === top || dirname(dir) === dir) break;
    }
    for (const s of project) {
      add(s.file, false);
      for (const path of typFilesNamed(s.text, dirname(s.file), this.root)) add(path, true);
    }
    for (const s of own) {
      if (!inChapterPreamble(s)) continue;
      for (const path of typFilesNamed(s.text, dirname(file), this.root)) add(path, true);
    }
    for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
      let named = this.named.get(path);
      if (!named) this.named.set(path, (named = typFilesNamedIn(path, this.root)));
      for (const next of named) add(next, true);
    }
    return out;
  }

  /**
   * A .typ file (absolute path) changed, or a folder moved or went. Batched: 300 ms after
   * the last change, a modified file drops the renders of the files whose preambles read
   * it; any other change drops those of every other file.
   */
  fileChanged(path: string, event: FileEvent): void {
    this.named.delete(path);
    this.changed.set(path, this.changed.get(path) === true || event !== "modify");
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      const changed = [...this.changed];
      this.changed.clear();
      if (changed.some(([, moved]) => moved)) this.named.clear();
      const dropped = new Set<string>();
      for (const [file, reads] of this.reads) {
        if (changed.some(([p, moved]) => p !== file && (moved || reads.has(p)))) dropped.add(file);
      }
      if (!dropped.size) return;
      for (const file of dropped) this.epochs.set(file, this.epoch(file) + 1);
      for (const [key, entry] of this.cache) {
        if (dropped.has(entry.file)) this.cache.delete(key);
      }
      this.notify();
    }, CHANGE_DEBOUNCE_MS);
  }

  dispose(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = null;
    this.cache.clear();
    this.last.clear();
    this.failed.clear();
    this.reads.clear();
    this.named.clear();
    this.listeners.clear();
  }
}

/**
 * Live preview's renderer for one file (a FragmentRenderer for livePreview.ts) over the
 * plugin's TypstRender. A formula's request (typstLive.ts) carries its document, so its
 * preamble is the one the hover uses; the epoch is the file's (renders go when a file its
 * preamble reads changes). A failed render keeps the formula's source: Typst's error
 * underlines it, while math that needs the code around it and failures of the renderer
 * itself (no binary, a timeout) keep it quietly. An error on a preamble line is not the
 * formula's: its last rendering under the same statements of its file stays (a template or
 * the book main broken since, the store's cache gone with the epoch), else it is a
 * PreambleFailure (typstLive keeps the last rendering of a statement edit then).
 */
export class TypstLiveRenderer implements FragmentRenderer {
  constructor(
    private readonly typst: TypstRender,
    /** The file's absolute path. */
    readonly file: string,
    /** The document widgets are drawn in. */
    private readonly doc: () => Document,
  ) {}

  get epoch(): number {
    return this.typst.epoch(this.file);
  }

  async render(req: RenderRequest): Promise<RenderResult> {
    if (!isTypstMathRequest(req)) return { ok: false, message: `no Typst renderer for ${req.kind}` };
    const r = await this.typst.math(this.file, req.doc, req.math);
    if (r.ok) {
      const node = fragmentElement(r, this.doc());
      return node ? { ok: true, node } : { ok: false, message: "tinymist returned an unreadable SVG" };
    }
    if (r.at) {
      const last = r.last && fragmentElement(r.last, this.doc());
      if (last) return { ok: true, node: last };
      const failure: PreambleFailure = { ok: false, message: `${r.message}\n${r.at}`, preamble: true };
      return failure;
    }
    if (r.transient || needsEnclosingCode(req.doc, req.math, r.message)) {
      return { ok: false, message: r.message, quiet: true };
    }
    return { ok: false, message: r.message };
  }

  subscribe(onChange: () => void): () => void {
    let epoch = this.epoch;
    return this.typst.onChange(() => {
      // The file's own saves leave its epoch alone: nothing to redraw.
      if (this.epoch === epoch) return;
      epoch = this.epoch;
      onChange();
    });
  }
}

/**
 * A rendered fragment as an element of `doc`: an inline span sitting on the text
 * baseline, or a centred block for display math.
 */
export function fragmentElement(r: RenderedFragment, doc: Document): HTMLElement | null {
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
