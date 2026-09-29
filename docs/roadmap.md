# obsidian-tinymist roadmap

The project goal is Tinymist-grade Typst editing inside Obsidian by being a
thin Obsidian frontend for the real Tinymist language server, exactly like the
VS Code / Neovim / Zed / Helix integrations. We do not reimplement the
compiler, the language service, or the preview pipeline; we write the glue.

## Architecture bet

- One `tinymist` binary provides LSP language intelligence and the preview
  server (incremental compilation, reflexo vector IR, WebSocket push,
  typst.ts WASM renderer in a static page).
- The plugin owns: a CodeMirror 6 editor in a custom `TextFileView` for
  `.typ` files, an LSP client over stdio, a preview `ItemView` embedding the
  preview page, process lifecycle, and settings.
- Desktop only until further notice. A typst.ts WASM preview fallback for
  mobile is a possible later phase, never a blocker for desktop milestones.

## v0.1 — basic end-to-end slice (current)

- [x] Repository scaffold, esbuild + TypeScript build, dev install script.
- [x] Register `.typ` extension to a custom CodeMirror 6 editor view
      (baseline syntax highlighting via a hand-written stream parser).
- [x] Spawn `tinymist lsp` (binary path setting, PATH auto-detection),
      LSP handshake, full-text document sync.
- [x] Diagnostics rendered in the editor (lint underlines + gutter).
- [x] Completion and hover backed by the LSP.
- [x] Preview: spawn `tinymist preview --root <vault>` for the active file,
      embed the served page in a side pane, updates on save (short save
      debounce so edits feel live).
- [x] Verified against the real qlblog QLNotes books (multi-file `#import`,
      registry bridge, cetz, Chinese system fonts).

## v0.2 — editor depth

- [x] Preview through the LSP session (`tinymist.doStartPreview`) instead of
      a separate process: unsaved-buffer preview and bidirectional
      cursor/click sync (jump to source via `customizedShowDocument`
      notifications, follow cursor via `tinymist.scrollPreview`; clickable
      pages require `--partial-rendering`).
- [x] Semantic-token highlighting from the LSP layered over the base grammar.
- [x] Go to definition (F12 / Cmd+click) and rename across vault files.
- [x] Formatting via the built-in typstyle formatter (format-on-command).
- [x] Dark-theme handling for the preview (`--invert-colors` setting).
- [x] Dynamic preview ports (`127.0.0.1:0`).
- [x] Project-owned `.tinymist-preview.typ` entries for styled chapter previews
      using Tinymist inputs and original-source includes.
- [x] Experimental YOLO bridge: drive the YOLO plugin's AI tab completion
      inside `.typ` editors (default-off setting; ghost text, Tab accept).
- [x] Completion that keeps up: every server item (no truncation), trigger
      characters and completion contexts, textEdit ranges (mid-word),
      additionalTextEdits (postfix), numbered snippets, symbol glyphs and
      docs; math-aware activation (2 letters in math) and ranking by the
      document's own symbols.
- [x] One key arbiter for Tab/Shift-Tab/Enter/Escape/arrows, shared with
      obsidian-latex-live: Tab accepts, smart Enter (an exact match is a
      newline), Tab typed ahead of the popup, list continuation on Enter.
- [x] YOLO bridge rebuilt on YOLO's own triggers: no keymap clash, no reopen
      after toggling, raw accept, file title with extension, contract check
      (`npm run test:yolo`).
- [x] Editor ergonomics: external changes merged as minimal diffs, per-file
      undo history, cursor/scroll/focus restore, IME-aware sync and saves,
      Obsidian hotkey scope (Mod-/, Mod-D, Mod-G, Mod-Enter, Mod-Alt-F,
      Mod-B/Mod-I, Mod-E preview, Mod-F search), `$` and quote pairing,
      comment toggling, themed caret, panels and tooltips.
- [x] Incremental document sync; semantic tokens mapped through edits made
      during a request, with the baseline tokenizer on edited lines.
- [x] Cross-chapter labels: a chapter compiles through the book `main.typ`
      that includes it (tinymist `pinMain`; setting, default on).
- [ ] Find references UI and optional format-on-save.
- [ ] Signature help, folding, document symbols/outline panel (the server
      already pushes outline notifications; needs a view).
- [ ] Multi-preview lifecycle (one preview task at a time today).

## v0.3 — product polish

- [ ] Binary management: auto-download a pinned tinymist release per platform
      with checksum verification and explicit user consent; keep the manual
      path setting as the escape hatch.
- [ ] Export commands (PDF/SVG/PNG) and open-exported-file affordances.
- [ ] Package UX: browse/download `@preview` packages, local package path
      settings.
- [ ] Obsidian ergonomics: file creation command and template, better icons,
      mobile-safe manifest gating, settings migration.
- [ ] Community plugin store submission readiness (guidelines, review).

## v0.4+ — exploration

- [ ] kgdistiller integration: recognize `#kn[...]` / `#ref[...]` authority
      markers, jump between marker and knowledge entry, surface graph
      neighbors in a side panel.
- [ ] Mobile story: typst.ts WASM preview-only fallback.
- [ ] Math-notes ergonomics: snippet library, symbol picker.

## Non-goals

- Reimplementing or forking the Typst compiler, Tinymist, or the preview
  frontend. Upstream evolves; we track releases.
- Replacing Obsidian's Markdown editor or parsing `.typ` content into
  Obsidian's link graph (until a concrete need appears).
- WASM compilation on desktop. The native binary is strictly better there
  (system fonts, speed, full LSP).
