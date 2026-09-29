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

## Render preview and live editing

A hover render of the formula under the pointer and a live-preview editing
mode (constructs render in place and show their source when the cursor enters
them), with the shared core in `src/editor/shared/` used by obsidian-latex-live
too. Built in phases that each end runnable and tested.

- [x] P0 prerequisites (2026-09-29): dev CodeMirror pinned to Obsidian
      1.13.7's runtime (view 6.43.8, state 6.7.0), which brings the
      `BlockWrapper` types and runs the tests on the runtime's CodeMirror.
- [ ] P1 hover render in source mode through a dedicated renderer
      `tinymist lsp` (virtual documents, `tinymist.exportSvg` without writing).
      Headless parts landed and tested; the phase ends with the GUI checks
      H7–H10 in a scratch vault and `node scripts/check-install.mjs`, both
      still pending.
  - [x] Shared `renderHover` (2026-09-29, `src/editor/shared/renderHover.ts`):
        the render section above the language server's (`Prec.high`), 300 ms
        hover, a spinner for a render still pending 400 ms after the pointer
        rests, one render per hover across CodeMirror's restarts, `hoverError`,
        `.lsp-render-hover` styles in `editor.css`. The section anchors at the
        start of the pointer's line within the formula: anchored at the
        formula's start, a display scrolled past its first line hid the whole
        hover, tinymist's section included (checked in headless Chrome). A render
        still pending when the pointer leaves the editor shows nothing.
  - [ ] Typst render hover (2026-09-29, headless; GUI checks pending):
        `LspClient.exportSvg` (`{write: false}` third),
        `TypstFragmentRenderer` (second `tinymist lsp`, lazy, 5 min idle
        stop, 5 s timeout, killed on unload and settings save),
        `typstFragment.ts` (top-level statements, book-main
        and chapter preamble, `.tinymist-fragment.typ` override, frame, SVG
        baseline/currentColor/ids), `TypstRender` (LRU 2000, invalidation on
        `.typ` changes), the hover section above tinymist's, setting "Render
        formulas on hover" (default on). Tests T-T1..T-T4 on the synthetic book
        in `tests/fixtures/book`. Measured on the synthetic typst-book (three
        chapters, template aliases, cetz, Chinese): 108 of 109 formulas render
        (the other, `$#r$`, uses a closure parameter a fragment cannot see; its
        hover shows no section instead of a false error), cold 35 ms, median
        0.42 ms, a cached hover 0.07 ms (preamble included); no file written.
    - [x] Review fixes (2026-09-29): math that needs the code around it (a
          closure's, loop's or block's variable, `context`) shows no section,
          typos keep their error (`needsEnclosingCode`; `#(…).map(…)` chains
          count as one expression); a book main's relative file paths
          (`image`, `read`, `yaml`, `json`, …) made root-absolute like its
          imports, so a main reading data before its includes no longer
          fails every chapter formula; renders dropped 300 ms after the last
          `.typ` change (a late template write rendered stale for good); a
          per-file `epoch(file)`, so a file's own autosaves keep its renders
          and epoch; the 5 s timeout covers the renderer's start, and a
          binary that cannot be spawned fails at once (it waited 20 s); a
          render a settings save interrupts runs again, and the stopped
          client stays `stopped`; an error on a preamble line shows that
          line (`file:line: statement`) in place of the formula;
          tinymist's section closes on typing and drops a symbol's bare
          sampled values inside a rendered formula. Checked on the scratch
          typst-book: 108 rendered, 1 without a section, 0 errors; a late
          template write 30 of 30 fresh.
- [ ] P2 shared live-preview core, live math, mode toggle.
- [ ] P3 text constructs: headings, strong/emph, lists, `@label` chips.
- [ ] P6 paper-mode hover of `#call[...]`, `#figure`, `#image`; cursor preview.
- [ ] P7 verification on multi-file books with templates; measured numbers.

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
