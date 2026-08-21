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
  (baseline tokenizer today, LSP semantic tokens later) must go through the
  direct decoration pipeline in `src/editor/highlightPlugin.ts`.
- The LSP client is hand-rolled and minimal on purpose. Unknown server
  requests get a `null` response and a debug log; extend explicitly when a
  feature needs it.
- Spawned processes (`tinymist lsp`, `tinymist preview`) must always be
  killed in `onunload` and view close paths. No orphan processes.
- Desktop only (`isDesktopOnly: true`) while the binary is required. Do not
  add mobile code paths without a roadmap decision.
- Never commit build artifacts (`main.js`, sourcemaps) or `node_modules`.
- Update [docs/roadmap.md](docs/roadmap.md) checkboxes when a milestone item
  lands; do not rewrite history otherwise.
- Verify changes with `npm run build` and a manual smoke test in a real
  vault (open a `.typ` file, check diagnostics/completion, open the preview)
  before reporting success.
