# obsidian-tinymist agent guidance

- This plugin is a thin frontend for the Tinymist language server. Language
  intelligence, compilation, and preview rendering belong upstream; the
  plugin owns editor UI, LSP/preview process lifecycle, and Obsidian
  integration. Reject changes that reimplement upstream capabilities.
- Keep the runtime dependency footprint minimal. CodeMirror 6 and Lezer
  packages are provided by Obsidian at runtime and must stay in the esbuild
  `external` list; never bundle a second copy.
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
- Editor keys: Tab, Shift-Tab, Enter, Escape, ArrowUp and ArrowDown are owned
  by `keyArbiter` (`src/editor/shared/keyArbiter.ts`), which must stay the
  FIRST extension of the editor state. Never bind these keys anywhere else
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
- `src/editor/typstEditor.ts` builds the editor's extension list without
  runtime Obsidian imports so tests mount the real stack; Obsidian-only
  parts (hover, Markdown info, the YOLO bridge instance) come in through the
  host. Tests that need a view mount it on `tests/support/obsidian.ts`, the
  stand-in `scripts/run-tests.mjs` aliases `obsidian` to; extend it with the
  documented behaviour a test needs, never with Obsidian's own code.
- Spawned processes (`tinymist lsp`, `tinymist preview`) must always be
  killed in `onunload` and view close paths. No orphan processes.
- Desktop only (`isDesktopOnly: true`) while the binary is required. Do not
  add mobile code paths without a roadmap decision.
- Never commit build artifacts (`main.js`, sourcemaps) or `node_modules`.
- Update [docs/roadmap.md](docs/roadmap.md) checkboxes when a milestone item
  lands; do not rewrite history otherwise.
- Verify changes with `npm test` (the real-tinymist test runs when a binary
  is found; `TINYMIST_BIN` overrides), `npm run build` and a manual smoke
  test in a real vault (open a `.typ` file, check diagnostics/completion,
  open the preview) before reporting success. After a YOLO update run
  `YOLO_MAIN=<vault>/.obsidian/plugins/yolo/main.js npm run test:yolo`.
- Installed copies drift from the source: `node scripts/check-install.mjs
  <vault>...` compares a vault's plugin files with this checkout (run
  `npm run build` first).
