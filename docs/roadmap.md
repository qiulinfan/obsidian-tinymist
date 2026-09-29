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
  - [x] Shared core (2026-09-29, headless; `src/editor/shared/livePreview.ts`):
        one StateField (reveal while focused and a selection touches the
        construct, inclusively; frozen while the mouse is down and mapped
        during IME compositions; constructs with an error diagnostic or a
        failed render stay source; a selection move re-decorates only the
        constructs on its lines), a rendering kept below a revealed block
        (the last one while the new source renders or fails), the
        `enterBlocks` transaction filter for ArrowUp/Down (no key bound),
        a per-renderer cache (never evicting what an open view uses) with a
        viewport-first scheduler (sync renders in a microtask, one async
        render in flight, idle prefetch), block height remeasure,
        `renderStats`, the `.lsp-lp-*` styles, and no render hover over a
        live widget (`replacedAt`). Tests T-S1..T-S12 in
        `tests/livePreview.test.ts` (identical in both repositories; the
        golden key matrix unchanged with live preview on); browser smoke
        B1..B5 in `scripts/browser-smoke.mjs` (5,700 lines: mount 14 ms,
        typing p95 4-5 ms, cursor move p50 0.6 ms, scroll frame p90 16.7 ms;
        gutter drift 0 px, 136 px without the remeasure).
  - [x] Typst live math (2026-09-29, headless; `typstScan.ts`,
        `typstLive.ts`, `TypstLiveRenderer`): inline `$x$` and display
        `$ x $` formulas in markup render in place through the fragment
        renderer (a block over its lines when alone on them, its trailing
        `<label>` included in the reveal range; math in statements, call
        arguments and keyword expressions stays source); a formula Typst
        rejects keeps its source with a dotted underline, one that needs its
        enclosing code keeps it quietly. The file's statements above a formula
        are in its key, and a formula keeps its last rendering while a new
        one is pending or a statement above is broken. Test T-T5 in
        `tests/typstLivePreview.test.ts`, including live mode on the synthetic
        book against a real tinymist. Measured on the scratch typst-book
        (template aliases, cetz, Chinese): 93 formulas in three chapters, all
        rendered, none failed, each chapter complete within 0.4 s. On a
        generated 5,700-line chapter (4,987 formulas) all rendered by the idle
        prefetch in 18 s, and the Typst editor stack in headless Chrome gave
        mount 21 ms, typing p95 8.7 ms (source mode 0.3 ms), cursor move p50
        0.6 ms, scroll frame p90 16.7 ms; arrows through Typst blocks, IME,
        drag and gutter drift (0 px with tinymist's SVGs) as B1-B4.
  - [x] Mode toggle (2026-09-29, headless): the view state's `mode`
        (restored with the workspace), the header action (book-open/code),
        the command "Toggle live preview" (no default hotkey), the setting
        "Default editing mode" (source), the refusal over 10,000 lines, the
        compartment content in `HistoryCache.restore`, the command "Show
        render statistics". The GUI checks in a scratch vault (L1-L9 and L15
        of the design) are still open.
  - [x] Review fixes to the shared core (2026-09-29, headless; identical in
        both repositories): the scheduler no longer spins through microtasks
        (a frozen editor) when the mouse or a composition holds a refresh
        while the idle prefetch runs; `enterBlocks` corrects only line moves
        (a goal column, as many ranges as before), so Select All,
        Cmd-ArrowUp/Down, Shift-Cmd-ArrowDown and Escape are never pulled
        into a block, and ArrowDown/ArrowUp into a block at the document's
        end or start visit its lines; the search panel's current match
        reveals its formula; an error that only touches a formula's edge no
        longer keeps it source; a failed preview below a block never shows
        another block's rendering; a throwing scanner leaves the text as
        source; renders that land re-decorate only the constructs waiting for
        them; the replacements within one line are drawn near the viewport
        only; chips keep the text size on heading lines and a supplement
        shows without its `*`/`_`; `scripts/gen-perf-fixture.mjs` generates
        the long chapters. Ten new or rewritten cases in
        `tests/livePreview.test.ts` fail on the previous core; all 241 tests
        pass (1 skipped). Browser smoke 21/21 (B1's six new checks fail on
        the previous core; B5 on the generated 5,700-line chapter: mount
        14 ms, typing p95 4-5.5 ms, typing inside a revealed block settled
        p95 4-5 ms, cursor move p50 0.2 ms, scroll frame p90 16.7 ms; the
        page stays responsive with the mouse held during the prefetch, which
        hung it before). The Typst stack on the dense 5,700-line chapter
        (about 12,500 replaced ranges): cursor move p50 0.2-0.3 ms (1.1-1.3 ms
        before), typing p95 9.4-10.9 ms (7.5-9.9 ms before, within the
        noise between runs).
  - [x] Review fixes to Typst live math (2026-09-29, headless;
        `typstRender.ts`, `typstLive.ts`, `typstScan.ts`,
        `fragmentRenderer.ts`): a modified `.typ` file drops only the renders
        of the files whose preambles read it (imports followed through the
        files they name; every `main.typ` above counts), so a chapter's
        autosave no longer re-renders the other open chapters; a template
        saved half-typed is a preamble error at its import (Typst's trace),
        and each formula keeps its last rendering through it; the fallback
        while a statement above changes is each formula occurrence's own and
        per view (no other occurrence's rendering, none lost past 2000
        formulas); a render the renderer failed (a slow start, a restart) is
        tried again once when the renderer next answers, bumping only its
        file. Twelve new or changed tests fail on the previous code; all 251
        tests pass (1 skipped). On the scratch typst-book against a real
        tinymist: ch1's autosave left ch2 and ch3 untouched (0 re-renders;
        before, 22 and 27 re-renders after 155-170 ms of source); a
        background 3,000-line chapter re-rendered nothing (2,625 renders,
        8.1 s before); a half-typed `template.typ` kept all 93 renderings
        with no error mark (93 marks before), the hover naming
        `main.typ:3`'s import; a `#let` typed at the top of the 3,000-line
        chapter kept all 2,625 renderings while 1,392 renders were pending
        (the top 35 went to source before); a cold start past the render
        timeout (1.5 s against 1 s) left all three formulas rendered without
        a retry command. `TypstRender.math` costs
        40 µs per call (34 µs before). Open: a real template or book main
        edit still shows the chapters' source for 130-200 ms until their new
        renders land (the shared core drops the old epoch's cache; a
        stale-while-revalidate change is requested there).
- [ ] P3 text constructs: headings, strong/emph, lists, `@label` chips.
  - [x] Typst text constructs (2026-09-29, headless; `typstScan.ts`,
        `typstLive.ts`): headings (size by level, the `=` marker hidden off
        the cursor's line), `*strong*` and `_emph_` with Typst's word-boundary
        rule, `- `/`+ `/`/ term:` items (bullets •, ‣, – by list depth,
        numbers per run as Typst groups items, bold terms; a marker shows only
        while touched), `@key` chips with an optional plain supplement, faint
        `<key>` chips, nothing inside links; code, raw text, comments and math
        stay untouched. The rules were checked against `typst compile
        --format html` and `typst query`. Test T-T6 in
        `tests/typstLivePreview.test.ts`: scanner table, reveal rules, error
        diagnostics, selection moves equal to a full build, Tab/Shift-Tab/
        Enter/Escape/Backspace identical to source mode at every position.
        Measured on the scratch typst-book (three chapters, template, cetz,
        Chinese) against a real tinymist: every construct decorated once, all
        93 formulas rendered, every reveal correct, no file written, the
        renderer exited. In headless Chrome on 5,700 lines: the book's chapter
        mix repeated gave mount 23 ms, typing p95 6.2 ms, cursor move p50
        0.6 ms and scroll frame p90 16.7 ms. A synthetic chapter with a
        construct on nearly every line (about 12,500 replaced ranges) gave
        typing p95 8 ms, but its cursor move p50 was 1.2 ms, over the 1 ms
        budget: CodeMirror compares every replaced range of the document on
        each update (0.2 ms with formulas only). The GUI check L10 is still
        open.
  - [x] Review fixes to the Typst scanner and highlighter (2026-09-29,
        headless): a content block may open with a heading (`#block[= T]`),
        and list items are one run when siblings whatever their indentation
        (`  + a` then `+ b` numbers 1, 2), as `typst compile --format html`
        parses them; the baseline tokenizer skips escapes, so `\$5` no longer
        tints the rest of the file as math.
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
