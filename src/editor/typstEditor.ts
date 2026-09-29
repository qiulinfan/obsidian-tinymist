import {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentMore } from "@codemirror/commands";
import { bracketMatching, getIndentUnit, indentService, indentUnit } from "@codemirror/language";
import { lintGutter } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  ChangeSet,
  EditorSelection,
  EditorState,
  Extension,
  Text,
} from "@codemirror/state";
import {
  Command,
  EditorView,
  ViewUpdate,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import type { LspClient, LspContentChange } from "../lsp/client";
import { typstHighlightPlugin } from "./highlightPlugin";
import { semanticTokensExtension } from "./semanticTokens";
import {
  darkThemeExtension,
  editNotifier,
  indentOrInsertTab,
  indentTabBinding,
  indentUnitFor,
  languageData,
  mathInput,
} from "./shared/editorKit";
import { InlineSuggestions, keyArbiter } from "./shared/keyArbiter";
import {
  ActivationInfo,
  CompletionEdit,
  InfoRenderer,
  LspCompletionBackend,
  LspCompletionItem,
  defaultGlyph,
  lspCompletionSource,
  lspGlyphColumn,
  offsetToLspPos,
} from "./shared/lspCompletion";
import { typstLanguage } from "./typstLanguage";

/** What the editor needs from its surroundings (TypstView, or a test). */
export interface TypstEditorHost {
  completion: LspCompletionBackend;
  /** Ghost-text provider for keyArbiter (the YOLO bridge's `inline`). */
  inline?: () => InlineSuggestions | null;
  /** This state's YOLO render extension (`YoloBridge.extension`). */
  yolo?: Extension;
  hover?: Extension;
  renderInfo?: InfoRenderer;
  /** Committed edits; never called while an IME composition is open. */
  onEdit?(view: EditorView, changes: ChangeSet, startDoc: Text): void;
  onUpdate?(update: ViewUpdate): void;
  gotoDefinition?(view: EditorView): void;
}

/**
 * The Typst editor's CodeMirror extensions, free of runtime Obsidian imports so
 * tests can mount the same stack in jsdom. TypstView supplies the Obsidian parts
 * (YOLO bridge, hover, Markdown info rendering) through the host. `text` is the
 * file's text, for the indent unit.
 */
export function typstEditorExtensions(
  host: TypstEditorHost,
  text: string,
): Extension[] {
  const gotoDefinition = (view: EditorView): boolean => {
    if (!host.gotoDefinition) return false;
    host.gotoDefinition(view);
    return true;
  };
  return [
    // Owns Tab/Enter/Escape/arrows; must come first (see its header).
    keyArbiter({ inline: host.inline, enter: typstListEnter, tabFallback: typstTab }),
    host.yolo ?? [],
    EditorState.allowMultipleSelections.of(true),
    darkThemeExtension(),
    languageData({
      brackets: ["(", "[", "{", '"', "$"],
      lineComment: "//",
      blockComment: { open: "/*", close: "*/" },
    }),
    indentUnitFor(text, "  "),
    typstIndent,
    lineNumbers(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    bracketMatching(),
    closeBrackets(),
    mathInput({ display: ["$ ", " $"] }),
    typstSurround,
    EditorView.lineWrapping,
    typstLanguage,
    typstHighlightPlugin,
    semanticTokensExtension,
    lintGutter(),
    // Its own keymap stays (Ctrl-Space, Alt-`, PageUp/Down); keyArbiter runs first.
    autocompletion({
      override: [typstCompletionSource(host.completion, host.renderInfo)],
      addToOptions: [lspGlyphColumn],
    }),
    host.hover ?? [],
    keymap.of([
      { key: "F12", run: gotoDefinition },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      { ...indentTabBinding, run: typstTab },
    ]),
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        if (!(event.metaKey || event.ctrlKey) || !host.gotoDefinition) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        view.dispatch({ selection: { anchor: pos } });
        return gotoDefinition(view);
      },
    }),
    host.onEdit ? editNotifier(host.onEdit) : [],
    host.onUpdate ? EditorView.updateListener.of(host.onUpdate) : [],
  ];
}

// ---- LSP transport ------------------------------------------------------------------

/**
 * Completion requests to tinymist. `sync` brings the server's copy of the file up to
 * the state being completed (edits are reported after IME compositions only).
 */
export function tinymistBackend(
  getLsp: () => LspClient | null,
  getPath: () => string | null,
  sync: (state: EditorState) => void,
): LspCompletionBackend {
  return {
    triggerCharacters: () => getLsp()?.completionTriggerCharacters() ?? [],
    async request(pos, context, state) {
      const lsp = getLsp();
      const path = getPath();
      if (!lsp || lsp.status !== "running" || !path) return null;
      sync(state);
      return lsp.completion(path, pos, context);
    },
  };
}

/** What one server holds for a path, shared by every pane that shows the file. */
interface ServerDoc {
  /** Panes attached to it: didOpen for the first, didClose for the last. */
  refs: number;
  /** The text the server has. */
  synced: Text;
}

/** Each server's open files (a restarted server is a new client, so it starts empty). */
const serverDocs = new WeakMap<LspClient, Map<string, ServerDoc>>();

/**
 * One view's handle on the language server's copy of an open file. Panes showing the
 * same file share that copy, so an edit reaches the server once even though the other
 * pane replays it when it reloads the saved file. `sync` sends an edit's ranges when the
 * server holds the text the edit started from, else the full text. The server always
 * gets CodeMirror's text (LF line breaks), so positions agree whatever the file uses.
 */
export class LspDocument {
  path: string | null = null;
  private lsp: LspClient | null = null;

  constructor(private getLsp: () => LspClient | null) {}

  /** Attach to `path`, releasing the previous file; false when nothing was attached. */
  open(path: string, doc: Text): boolean {
    const lsp = this.getLsp();
    if (lsp?.status !== "running") return false;
    if (this.path === path && this.lsp === lsp) {
      this.sync(doc);
      return false;
    }
    this.close();
    let docs = serverDocs.get(lsp);
    if (!docs) serverDocs.set(lsp, (docs = new Map()));
    const shared = docs.get(path);
    this.path = path;
    this.lsp = lsp;
    if (shared) {
      shared.refs++;
      this.sync(doc);
    } else {
      docs.set(path, { refs: 1, synced: doc });
      lsp.didOpen(path, doc.toString());
    }
    return true;
  }

  sync(doc: Text, edit?: { changes: ChangeSet; startDoc: Text }): void {
    const lsp = this.getLsp();
    if (!lsp || lsp !== this.lsp || !this.path || lsp.status !== "running") return;
    const shared = serverDocs.get(lsp)?.get(this.path);
    if (!shared || shared.synced === doc) return;
    if (edit && (shared.synced === edit.startDoc || shared.synced.eq(edit.startDoc))) {
      lsp.didChangeRanges(this.path, lspContentChanges(edit.changes, edit.startDoc));
    } else if (shared.synced.eq(doc)) {
      // Another pane already sent this text (its save reloaded here). Keep that pane's
      // document, so its next edit still goes out as ranges.
      return;
    } else {
      lsp.didChange(this.path, doc.toString());
    }
    shared.synced = doc;
  }

  close(): void {
    const docs = this.lsp && serverDocs.get(this.lsp);
    const shared = this.path ? docs?.get(this.path) : undefined;
    if (docs && shared && --shared.refs === 0) {
      docs.delete(this.path!);
      this.lsp!.didClose(this.path!);
    }
    this.path = null;
    this.lsp = null;
  }

  /** Forget the file without didClose (the server restarted). */
  reset(): void {
    this.path = null;
    this.lsp = null;
  }
}

/**
 * Incremental didChange entries for `changes` applied to `startDoc`. They are listed
 * from the end of the document backwards, so each range is still valid in `startDoc`
 * coordinates when the server applies them in order.
 */
export function lspContentChanges(changes: ChangeSet, startDoc: Text): LspContentChange[] {
  const out: LspContentChange[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    out.push({
      range: { start: offsetToLspPos(startDoc, fromA), end: offsetToLspPos(startDoc, toA) },
      text: inserted.toString(),
    });
  });
  return out.reverse();
}

// ---- Math spans -----------------------------------------------------------------------

const spanCache = new WeakMap<Text, number[]>();

/** A `"` that opens a code string (not a markup quote): after `( , : = { +` or import/include. */
function codeQuote(s: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (s[j] === " " || s[j] === "\t")) j--;
  if (j >= 0 && "(,:={+".includes(s[j])) return true;
  return /(?:^|[^\w-])(?:import|include)$/.test(s.slice(Math.max(0, j - 8), j + 1));
}

/**
 * Math spans of a Typst document as [from0, to0, from1, to1, ...]: `from` is just after
 * the opening `$`, `to` the closing `$` (the document end when unclosed). A lexical
 * approximation in the spirit of the baseline highlighter: escapes, comments, raw text
 * and code strings are skipped; content nested inside math is not tracked.
 */
export function typstMathSpans(doc: Text): number[] {
  const cached = spanCache.get(doc);
  if (cached) return cached;
  const spans: number[] = [];
  const s = doc.toString();
  const n = s.length;
  let math = false;
  let i = 0;
  const skipTo = (needle: string, from: number) => {
    const at = s.indexOf(needle, from);
    return at < 0 ? n : at + needle.length;
  };
  while (i < n) {
    const ch = s[i];
    if (ch === "\\") {
      i += 2;
    } else if (ch === "/" && s[i + 1] === "/" && s[i - 1] !== ":") {
      i = skipTo("\n", i);
    } else if (ch === "/" && s[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (s.startsWith("/*", i)) (depth++, (i += 2));
        else if (s.startsWith("*/", i)) (depth--, (i += 2));
        else i++;
      }
    } else if (ch === "`" && !math) {
      let k = 1;
      while (s[i + k] === "`") k++;
      // `` is an empty raw; ``` opens a block closed by the same run.
      i = k === 2 ? i + 2 : skipTo(k >= 3 ? "`".repeat(k) : "`", i + k);
    } else if (ch === '"' && (math || codeQuote(s, i))) {
      i++;
      while (i < n && s[i] !== '"' && s[i] !== "\n") i += s[i] === "\\" ? 2 : 1;
      i++;
    } else if (ch === "$") {
      spans.push(math ? i : i + 1);
      math = !math;
      i++;
    } else {
      i++;
    }
  }
  if (math) spans.push(n);
  spanCache.set(doc, spans);
  return spans;
}

/** Whether `pos` lies inside `$...$` (both ends count as inside). */
export function inTypstMath(doc: Text, pos: number): boolean {
  const spans = typstMathSpans(doc);
  let lo = 0;
  let hi = spans.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[2 * mid] > pos) hi = mid - 1;
    else if (spans[2 * mid + 1] < pos) lo = mid + 1;
    else return true;
  }
  return false;
}

const usageCache = new WeakMap<Text, Map<string, number>>();

/** How often each multi-letter identifier occurs inside math. */
export function mathUsage(doc: Text): Map<string, number> {
  const cached = usageCache.get(doc);
  if (cached) return cached;
  const usage = new Map<string, number>();
  const spans = typstMathSpans(doc);
  for (let i = 0; i < spans.length; i += 2) {
    for (const [w] of doc.sliceString(spans[i], spans[i + 1]).matchAll(/[A-Za-z]{2,}/g)) {
      usage.set(w, (usage.get(w) ?? 0) + 1);
    }
  }
  usageCache.set(doc, usage);
  return usage;
}

// ---- Completion policy ----------------------------------------------------------------

/**
 * When typing (not an explicit request) queries tinymist:
 *   - after a trigger character (`#` `.` `@` `<` `"` ...), except `.` after a digit
 *     (a decimal point, where tinymist would offer postfix functions);
 *   - in math after 2 letters: `_`, `^`, digits and single letters are variables, not
 *     identifiers, so `a_i` or `x2` never pops up a list;
 *   - elsewhere after 2 identifier characters, or 1 right after `(` `,` `:` `=` `{`
 *     (arguments, let bodies). Prose gets no items from tinymist, so it stays quiet.
 */
export function typstActivate(ctx: CompletionContext, info: ActivationInfo): boolean {
  const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 2), ctx.pos);
  if (info.trigger) return !(info.trigger === "." && /\d\.$/.test(before));
  if (inTypstMath(ctx.state.doc, ctx.pos)) {
    return (ctx.matchBefore(/[A-Za-z]+$/)?.text.length ?? 0) >= 2;
  }
  if (info.word.length >= 2) return true;
  if (info.word.length !== 1) return false;
  const line = ctx.state.doc.lineAt(ctx.pos);
  return /[(,:={]\s*$/.test(ctx.state.sliceDoc(line.from, ctx.pos - 1));
}

/**
 * In math `_` and `-` are operators, so they end a completion word. A string-value list
 * anchored at its opening quote (anchorAtQuote) holds every value, so it stays valid while
 * typing inside the string.
 */
function typstValidFor(ctx: CompletionContext, from: number): CompletionResult["validFor"] {
  if (quoteAnchored.has(ctx) && ctx.state.sliceDoc(from, from + 1) === '"') return /^"[^"\n]*$/;
  return inTypstMath(ctx.state.doc, ctx.pos) ? /^[A-Za-z0-9]*$/ : /^[A-Za-z0-9_-]*$/;
}

/** Requests whose string-value items anchorAtQuote re-anchored. */
const quoteAnchored = new WeakSet<CompletionContext>();
/** Options that are symbols (tinymist shows their glyph), for typstRank. */
const symbols = new WeakSet<Completion>();

/**
 * tinymist labels string values (fonts, paper sizes) with their quotes but edits them at
 * the cursor: the bare value right after the opening quote, or, once something is typed,
 * the value with its opening quote. Anchor both at the opening quote, the shape tinymist
 * uses for import paths, so `"Ti` filters against `"Times New Roman"` and accepting
 * replaces what was typed. False when `edit` is not such an edit.
 */
function anchorAtQuote(item: LspCompletionItem, edit: CompletionEdit, ctx: CompletionContext): boolean {
  if (!item.label.startsWith('"') || edit.from !== ctx.pos || edit.to !== ctx.pos) return false;
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = ctx.state.sliceDoc(line.from, ctx.pos);
  const at = before.lastIndexOf('"');
  // Inside a code string: an odd number of quotes before the cursor, the last one opening.
  if (at < 0 || before.split('"').length % 2 === 1 || !codeQuote(before, at)) return false;
  const quote = line.from + at;
  if (edit.text.startsWith('"')) {
    edit.from = quote;
  } else if (quote === ctx.pos - 1) {
    edit.from = quote;
    edit.text = '"' + edit.text;
  } else {
    return false;
  }
  return true;
}

function typstAugment(item: LspCompletionItem, option: Completion, edit: CompletionEdit, ctx: CompletionContext): void {
  if (defaultGlyph(item)) symbols.add(option);
  if (anchorAtQuote(item, edit, ctx)) quoteAnchored.add(ctx);
}

const GREEK = new Set(
  "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega"
    .split(" ")
    .flatMap((g) => [g, g[0].toUpperCase() + g.slice(1)]),
);

/**
 * Ties between equally good matches (CodeMirror's match-quality steps are 100 apart, the
 * boosts stay below them, so a better match always wins):
 *   - tinymist sends no sortText after `.` (modifiers first, postfix rewrites last): keep
 *     its order instead of CodeMirror's alphabetical fallback, and boost nothing while no
 *     word is typed;
 *   - in math, symbols the document already uses come first, then Greek letters, then
 *     other symbols, then functions (tinymist sorts alphabetically: `the` would otherwise
 *     pick `theorem` from a template before `theta`).
 */
function typstRank(options: Completion[], ctx: CompletionContext, from: number): Completion[] {
  if (!options.some((o) => o.sortText != null)) {
    options.forEach((o, i) => (o.sortText = String(i).padStart(5, "0")));
  }
  if (from === ctx.pos || !inTypstMath(ctx.state.doc, ctx.pos)) return options;
  const usage = mathUsage(ctx.state.doc);
  for (const option of options) {
    const n = usage.get(option.label) ?? 0;
    let boost = n > 0 ? Math.min(12, 4 + 2 * Math.floor(Math.log2(n))) : 0;
    if (symbols.has(option)) boost += GREEK.has(option.label) ? 2 : 1;
    if (boost) option.boost = (option.boost ?? 0) + boost;
  }
  return options;
}

export function typstCompletionSource(
  backend: LspCompletionBackend,
  renderInfo?: InfoRenderer,
): CompletionSource {
  return lspCompletionSource(backend, {
    activate: typstActivate,
    validFor: typstValidFor,
    augment: typstAugment,
    rank: typstRank,
    renderInfo,
  });
}

// ---- Editing details ------------------------------------------------------------------------

/**
 * `*` or `_` typed over a selection wraps it (strong / emphasis) instead of replacing
 * it; without a selection they stay plain characters. Not in math, where `_` is a
 * subscript.
 */
const typstSurround = EditorView.inputHandler.of((view, _from, _to, text) => {
  const { state } = view;
  if ((text !== "*" && text !== "_") || state.readOnly || view.compositionStarted) return false;
  if (state.selection.ranges.some((r) => r.empty) || inTypstMath(state.doc, state.selection.main.from)) {
    return false;
  }
  view.dispatch(
    state.changeByRange((r) => ({
      changes: [
        { from: r.from, insert: text },
        { from: r.to, insert: text },
      ],
      range: EditorSelection.range(r.anchor + 1, r.head + 1),
    })),
    { userEvent: "input.type", scrollIntoView: true },
  );
  return true;
});

/**
 * Whether a line (the text before a break) leaves a block open: its last character outside
 * strings, raw text and comments is `(`, `[` or `{`.
 */
function opensBlock(text: string): boolean {
  let last = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++; // an escaped character is text
      last = ch;
    } else if (ch === "/" && text[i + 1] === "/" && text[i - 1] !== ":") {
      break;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 1;
    } else if (ch === '"' || ch === "`") {
      const end = text.indexOf(ch, i + 1);
      if (end < 0) return false; // the line ends inside a string or raw text
      i = end;
      last = ch;
    } else if (ch !== " " && ch !== "\t") {
      last = ch;
    }
  }
  return last !== "" && "([{".includes(last);
}

/**
 * Enter after a line that ends by opening `(`, `[` or `{` indents the new line one unit
 * deeper; between `{|}` the closer keeps the opener's indentation (insertNewlineAndIndent
 * splits the pair). Everywhere else CodeMirror keeps the current indentation.
 */
const typstIndent = indentService.of((cx, pos) => {
  if (pos === 0) return undefined;
  let prev = cx.lineAt(pos - 1, -1); // the text before a simulated break, or the line above
  while (!prev.text.trim() && prev.from > 0) prev = cx.lineAt(prev.from - 1, -1);
  if (!opensBlock(prev.text) || /^\s*[)\]}]/.test(cx.textAfterPos(pos))) return undefined;
  return cx.lineIndent(prev.from, -1) + cx.unit;
});

// ---- Tab / Enter: lists ------------------------------------------------------------------

const LIST_ITEM = /^([ \t]*)([-+]|\d+\.)([ \t]+)/;

/**
 * Tab with the cursor on a `- `, `+ ` or `1. ` list item, at or after its marker, nests
 * the item one level (Shift-Tab's indentLess un-nests it from anywhere on the line). Not
 * in math.
 */
export const typstListTab: Command = (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (state.selection.ranges.length > 1 || !range.empty || state.readOnly) return false;
  const line = state.doc.lineAt(range.head);
  const m = LIST_ITEM.exec(line.text);
  if (!m || range.head < line.from + m[0].length || inTypstMath(state.doc, range.head)) return false;
  return indentMore(view);
};

/**
 * The Tab the key arbiter leaves to the view (no popup, ghost text or snippet field):
 * nest a list item, else editorKit's indentOrInsertTab. Also the arbiter's tabFallback,
 * so a Tab typed ahead of an empty completion does the same.
 */
export const typstTab: Command = (view) => typstListTab(view) || indentOrInsertTab(view);

/**
 * Enter in a `- `, `+ ` or `1. ` list item continues the list (the text after the
 * cursor moves into the new item). Enter on an empty item ends the list, or outdents
 * it by one level when nested. Not in math.
 */
export const typstListEnter: Command = (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (state.selection.ranges.length > 1 || !range.empty || state.readOnly) return false;
  const pos = range.head;
  const line = state.doc.lineAt(pos);
  const m = LIST_ITEM.exec(line.text);
  if (!m || pos < line.from + m[0].length || inTypstMath(state.doc, pos)) return false;
  const [marker, indent, bullet] = m;
  if (!line.text.slice(marker.length).trim()) {
    if (!indent) {
      view.dispatch({
        changes: { from: line.from, to: line.to },
        selection: { anchor: line.from },
        userEvent: "delete",
      });
      return true;
    }
    const unit = state.facet(indentUnit);
    const width = indent.endsWith(unit) ? unit.length : Math.min(indent.length, getIndentUnit(state));
    view.dispatch({
      changes: { from: line.from + indent.length - width, to: line.from + indent.length },
      userEvent: "delete",
    });
    return true;
  }
  const next = bullet.endsWith(".") ? `${parseInt(bullet, 10) + 1}.` : bullet;
  const insert = `\n${indent}${next} `;
  const rest = /^[ \t]*/.exec(state.sliceDoc(pos, line.to))![0].length;
  view.dispatch({
    changes: { from: pos, to: pos + rest, insert },
    selection: { anchor: pos + insert.length },
    userEvent: "input",
    scrollIntoView: true,
  });
  return true;
};
