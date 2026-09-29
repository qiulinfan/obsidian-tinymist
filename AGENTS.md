# obsidian-tinymist agent guidance

- This plugin is a thin frontend for the Tinymist language server. Language
  intelligence, compilation, and preview rendering belong upstream; the
  plugin owns editor UI, LSP/preview process lifecycle, and Obsidian
  integration. Reject changes that reimplement upstream capabilities.
- Keep the runtime dependency footprint minimal. CodeMirror 6 and Lezer
  packages are provided by Obsidian at runtime and must stay in the esbuild
  `external` list; never bundle a second copy. The dev pins of `@codemirror/*`
  (`overrides` and devDependencies) are the versions the `minAppVersion`
  Obsidian ships (1.13.7: view 6.43.8, state 6.7.0), so tests run on the
  runtime's CodeMirror; raise them only together with `minAppVersion`, in both
  repositories (the shared modules run on the same versions).
- Obsidian inlines its own copy of the CM6 language plumbing, so Lezer style
  props and `syntaxHighlighting` never decorate custom views. All highlighting
  (the baseline tokenizer in `src/editor/highlightPlugin.ts`, LSP semantic
  tokens in `src/editor/semanticTokens.ts`) goes through direct decorations.
- The LSP client is hand-rolled and minimal on purpose. Unknown server
  requests get a `null` response and a debug log; extend explicitly when a
  feature needs it. Edits reach the server incrementally through
  `LspDocument` (`src/editor/typstEditor.ts`), never during an IME
  composition; sync it before any request that depends on the text. Panes
  showing the same file share one server-side copy per `LspClient` (didOpen
  for the first pane, didClose for the last), so an edit reaches the server
  once. Saves never write while a composition is open (`TypstView.save`).
  `TypstView` keeps a CRLF file CRLF (CodeMirror and the server hold LF;
  `getViewData` converts back), so opening a file and switching away never
  rewrites it.
- Editor diagnostics go only through `setTypingDiagnostics` (editorKit;
  `TypstView.applyDiagnostics`), never `setDiagnostics` on the editor:
  `typingDiagnostics()` holds new ones on the line being typed until a pause
  or the cursor leaves it.
- Editor keys: Tab, Shift-Tab, Enter, Escape, ArrowUp and ArrowDown are owned
  by `keyArbiter` (`src/editor/shared/keyArbiter.ts`), which must stay the
  FIRST extension of the editor state. Enter accepts a completion only when
  that changes the text, never from a list a trigger character opened
  (`#calc.` + Enter is a newline) until something is typed or the selection
  moved, and never accepts AI text. Never bind these keys anywhere else
  (no `completionKeymap`, no YOLO keymap); add Enter behaviour as an arbiter
  `enter` hook. The Tab the arbiter declines is `typstTab` at the end of the
  view keymap (nest a list item, else `indentOrInsertTab`), also passed as
  the arbiter's `tabFallback`. Obsidian hotkeys that would swallow editor
  keys go through the view's `Scope` (`registerEditorScope`); Mod-S and
  Mod-F keep their Obsidian meaning.
- `src/editor/shared/` is shared with obsidian-latex-live and must stay
  byte-identical there; this repository holds the canonical copy. Shared
  modules may only `import type` from `obsidian` (tests bundle them without
  Obsidian). `styles.css` embeds `src/editor/shared/editor.css` verbatim
  between the `shared:editor.css` markers; update both together.
- Render hover (`renderHover`, `src/editor/shared/renderHover.ts`; its test
  `tests/renderHover.test.ts` is identical in both repositories) is
  `Prec.high`, so its section stays above the language server's and lint's
  wherever the view mounts it. An async `render` gets a spinner 400 ms after
  the pointer rests; CodeMirror restarts a pending hover on every view update,
  and those restarts reuse the pending render. A settled render is never
  reused by a later hover: caches (MathJax nodes, SVGs, crops) belong to the
  renderer and key on its epoch. Failures render as `hoverError`; positions a
  live widget renders are skipped through `replacedAt`. The section anchors at
  the start of the pointer's line within the target (`end` is the target's
  end), never at the target's start: CodeMirror hides a tooltip whose anchor is
  scrolled out and places the merged hover at its lowest section anchor, so a
  long display scrolled past its first line would hide tinymist's section too
  (`tests/renderHover.test.ts` checks the anchor). A render still pending when
  the pointer leaves the editor shows nothing.
- Typst formula renders (`typstRenderHover`, above `lspHoverTooltip`, setting
  `hoverRender`) come from a second `tinymist lsp` owned by the plugin
  (`TypstFragmentRenderer`, `src/lsp/fragmentRenderer.ts`), never from the
  editor's server: it never pins a main or touches the preview, and its
  diagnostics are dropped. tinymist's own hover closes on an edit or a
  selection change like the render's, and inside a rendered formula drops a
  symbol's bare "Sampled Values" answer (alias signatures stay). The renderer
  starts on the first render and stops after 5 min idle, when a compile passes
  the render timeout (5 s), on every settings save (a new binary path; a
  render the save interrupted runs once more on the new process) and in
  `onunload`. The 5 s include the start: a slower start goes on for the next
  render, and a binary that cannot be spawned fails at once (`LspClient`
  rejects its pending requests on the spawn `error`, which comes without an
  `exit`); `stop()` during `LspClient.start` leaves it `stopped`, not
  `failed`. A fragment compiles as the in-memory document
  `<folder>/.obsidian-tinymist-fragment.typ` (didOpen, then didChange with the
  same text: some server states refuse the export otherwise; one change+export
  pair at a time per document), never written. `LspClient.exportSvg` always
  sends `{write: false}` as the THIRD argument (as the second it is ignored
  and tinymist writes `<name>.svg` into the vault); `tests/fragmentRenderer.test.ts`
  checks that no `.svg` or fragment file appears. Never batch fragments into
  one document: one bad formula fails them all.
- A fragment's preamble (`src/editor/typstFragment.ts`) is the book main's
  top-level statements before its include of the chapter (relative import
  paths and the leading path of file-reading calls, `image`/`read`/`yaml`/
  `json`/…, made root-absolute: the fragment sits in the chapter's folder; no
  `#include`, no bare `#show:` template rule), or the statements of the
  nearest `.tinymist-fragment.typ` instead, then the buffer's own top-level
  statements that end before the formula. Math inside a top-level statement is
  never a fragment. A fragment failing with `unknown variable: x`, where `x`
  occurs before the formula in the enclosing top-level `#` expression (a
  closure parameter, a `for`/`let` binding), or with a context error inside
  `context`, shows no hover section (`needsEnclosingCode`): the document
  compiles, the fragment cannot. An error Typst locates on a preamble line
  shows that line (`book/main.typ:4: #set …`, located at every render, not
  cached) in place of the formula. SVGs: the sentinel ink becomes
  `currentColor`, the marker gives the baseline, ids are prefixed per render,
  and sizes are in em (1em = 16pt). `TypstRender` caches by folder, preamble
  hash, mode and formula. `.typ` changes, 300 ms after the last one (well past
  the renderer's file watcher), drop the renders of every other file and bump
  those files' `epoch(file)`; a file's own saves (an autosave at every typing
  pause) keep its renders and its epoch, since its statements are keyed through
  the buffer. Live mode keys a view's renders on `epoch(viewFile)`. Obsidian
  sends no events for dotfiles, so `.tinymist-fragment.typ` is re-read on
  every render (its text is in the key).
- `src/editor/typstEditor.ts` builds the editor's extension list without
  runtime Obsidian imports so tests mount the real stack; Obsidian-only
  parts (hover, Markdown info, the YOLO bridge instance) come in through the
  host. Tests that need a view mount it on `tests/support/obsidian.ts`, the
  stand-in `scripts/run-tests.mjs` aliases `obsidian` to; extend it with the
  documented behaviour a test needs, never with Obsidian's own code.
- Spawned processes (`tinymist lsp`, `tinymist preview`, the fragment
  renderer's `tinymist lsp`) must always be killed in `onunload` and view close
  paths. No orphan processes.
- Desktop only (`isDesktopOnly: true`) while the binary is required. Do not
  add mobile code paths without a roadmap decision.
- Never commit build artifacts (`main.js`, sourcemaps) or `node_modules`.
- Update [docs/roadmap.md](docs/roadmap.md) checkboxes when a milestone item
  lands; do not rewrite history otherwise.
- Verify changes with `npm test` (the real-tinymist test runs when a binary
  is found; `TINYMIST_BIN` overrides), `npm run build` and a manual smoke
  test in a real vault (open a `.typ` file, check diagnostics/completion,
  hover a formula that uses a template alias: rendered above tinymist's
  hover, and `pgrep -fl "tinymist lsp"` shows exactly one more process, gone
  after disabling the plugin; open the preview) before reporting success.
  After a YOLO update run
  `YOLO_MAIN=<vault>/.obsidian/plugins/yolo/main.js npm run test:yolo`.
- Installed copies drift from the source: `node scripts/check-install.mjs
  <vault>...` compares a vault's plugin files with this checkout (run
  `npm run build` first).
