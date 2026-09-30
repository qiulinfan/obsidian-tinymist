# LaTeX and Typst on iPad (Obsidian mobile): feasibility study

Research date 2026-09-29, covering both this plugin and LaTeX Live (qiulinfan/obsidian-latex-live). Measured on an Apple M5 Mac (32 GB, macOS 27). "WKWebView" means a minimal macOS WKWebView host (`exp/wk.swift` → `wkhost`): the same WebKit engine and page process as Obsidian on iOS, without iOS memory limits.

## Bottom line

- **Typst on iPad works on the device, with no server.**
  - **typst.ts** compiles and renders. 0.8.0-rc3 is Typst 0.15.1, matching the desktop plugin. On the synthetic typst-book in WKWebView (3 chapters, cetz, Chinese Fandol fonts):
    - cold compile 340–350 ms, recompile after an edit about 30 ms, PDF export about 50 ms;
    - one live-math formula (template preamble + formula → SVG) under 1 ms;
    - page-process peak about 410 MB.
  - **tinymist-web 0.15.8** (the tinymist language server in WASM, from the tinymist GitHub release) gives completion in 1–4 ms, hover about 1 ms, semantic tokens about 1.4 ms, peak about 300 MB. Two gaps:
    - export is compiled out (`tinymist.exportSvg` returns "export feature is not enabled");
    - it cannot load any fonts, so layout-dependent features such as `@label` completion fail.

    Rendering therefore comes from typst.ts.
- **LaTeX has a cheap part and an expensive part.**
  - Cheap: everything the plugin already does in plain JS works as is: the CM6 editor, highlighting, the built-in completion layer, and MathJax hover and live preview.
  - Expensive: a real TeX compile.
    - BusyTeX (TeX Live 2026 in WASM) builds a 14-page amsmath article in WKWebView as fast as native pdfLaTeX (0.20–0.27 s vs 0.25 s). XeLaTeX takes 0.48–0.60 s vs 0.32 s.
    - It peaks at about 860 MB with only the smallest (88 MB) bundle.
    - No prebuilt bundle has ctex, xeCJK or Fandol; elegantbook is only in the 326 MB bundle.
    - The ready-made builds are AGPL-3.0, while both plugins are Apache-2.0.
    - There is no texlab in WASM, and SyncTeX needs a JS parser.
  - Remote compile is the cheaper first step: the iPad sends buffers over HTTPS on Tailscale to a small Node service on the Mac that reuses `src/tex/` (already Obsidian-free). It gives full parity (ctex, elegantbook, biber, SyncTeX), but only while the Mac is on.
- **Order:**
  0. Make both plugins mobile-safe.
  1. Ship the plain-JS editor (MathJax live preview for `.tex`, the editor for `.typ`).
  2. Add typst.ts in a Worker, then tinymist-web.
  3. Add remote LaTeX compile.
  4. Consider offline WASM LaTeX last.

## 1. Obsidian iOS/iPadOS constraints

- **No Node or Electron APIs.** A top-level `require` of fs, child_process, path, os or crypto anywhere in main.js stops the plugin from loading. `isDesktopOnly: true` blocks installation. (docs.obsidian.md, Mobile development)
- **Files only through the async vault adapter** (`CapacitorAdapter`: read, readBinary, writeBinary, getResourcePath). There is no access outside the vault and no `$TMPDIR`. The scanners' `readFileSync` needs an in-memory project snapshot fed by `vault.cachedRead` and vault events.
- **Network:** `requestUrl` goes through native HTTP with no CORS. packages.typst.org and jsDelivr also send ACAO `*`.
- **Memory:**
  - The page process is limited to about 1.5 GB on iPhones; on 8 GB iPads it is "in the 4GB+ range".
  - WASM and typed arrays are capped at 2 GB.
  - A process over the limit is killed silently (WebKit bug 268816).
  - Typst Mate crashed on 4 GB phones and worked on an 8 GB iPad (issue #15). A one-piece WASM download ran out of memory on Android (PR #25).
- **Lockdown Mode** disables WASM and the JIT unless Obsidian is exempted, so keep the plain-JS MathJax fallback.
- **No SharedArrayBuffer, hence no WASM threads:** cross-origin isolation needs headers a plugin cannot set. typst.ts, tinymist-web and BusyTeX are all single-threaded, and every number here was measured without isolation.
- **Blob-URL Web Workers work on mobile.** Typst Mate uses Vite `?worker&inline` with comlink.
- **Distribution:**
  - Obsidian installs only main.js, manifest.json and styles.css, so WASM is downloaded at runtime and the network use must be disclosed. Typst Mate downloads 33.4 MB and Typst Renderer 25.7 MB.
  - Obsidian Sync (Standard) skips files over 5 MB.
  - Chinese needs a user-supplied font.
- **Input:** without a keyboard there is no Tab or Esc, and keyArbiter depends on both. Hover needs a trackpad or Pencil hover. Add a key toolbar and tap-to-render.

## 2. Portability of the two plugins

- **Already mobile-safe:**
  - shared: `src/editor/shared/*`, which only imports types from obsidian and takes CodeMirror from Obsidian;
  - LaTeX: latexHighlight, latexCommands, latexEnter, latexScan (via tex/texText), mathjaxProject;
  - Typst: typstLanguage, highlightPlugin, semanticTokens.
- **Pure logic that reaches Node through imports:**
  - LaTeX: latexCompletion → tex/macros (fs, path); latexLive → latexRefs → tex/bib (fs); texRender and texView use readFileSync and statSync directly.
  - Typst: typstScan → typstFragment (fs, path, previewEntry); typstView → lsp/client (child_process, only for pathToUri); typstRender → lsp/fragmentRenderer.
  - Fix: a `ProjectFiles` interface over an in-memory snapshot, POSIX path helpers (or path-browserify in the mobile build), a Node-free URI module, and a pluggable `LspClient` transport (stdio or Worker).
- **Node-only by design:**
  - LaTeX: tex/compiler, binaries, watchdog, synctex, lsp/texlab, session.
  - Typst: the stdio LSP client, fragmentRenderer, and preview/*.
  - These need a WASM or remote replacement. `src/tex/` is Obsidian-free, so it can serve unchanged as the Mac compile service.
- **PDF preview:** `pdfRenderer.ts` already renders PDF bytes with Obsidian's pdf.js. Still to check on a device: that `/lib/pdfjs/` cMaps load on mobile (without them, Chinese text in the PDF disappears).

## 3. Typst on iPad

- **typst.ts** (Apache-2.0).
  - Compiler WASM: 0.7.0 is 28.3 MB raw, 10.7 MB gzip, 7.1 MB Brotli; 0.8.0-rc3 is 30.2 MB. The renderer is 0.97 MB.
  - Features: compile to vector, PDF or HTML; SVG or canvas rendering; semantic tokens; diagnostics; incremental mode; lazy fonts.
  - File access and package lookup are synchronous callbacks, and the stock fetcher uses sync XHR. Prefetch packages asynchronously and serve them from memory.
- **tinymist-web 0.15.8**: 32.5 MB (9.8 MB Brotli).
  - Taken from the GitHub release (`tinymist-web.tar.gz` / `.vsix`); the npm package is a stale 0.12.18 stub.
  - API: `new TinymistLanguageServer({sendEvent, sendRequest, sendNotification, resolveFn})` plus on_request, on_notification, on_response and on_event (PR #1944; host code in editors/vscode/src/web/server.ts).
  - Files use an async exchange: the server sends a `tinymist/fs/watch` request and the client answers with a `tinymist/fsChange` request carrying base64 contents. `resolveFn` returns a package directory.
  - The browser font loader only adds embedded fonts, and the release build embeds none.
- **Prior art:** Typst Mate 2.3.2 (Typst 0.14.2, Worker with comlink, packages stored in the vault); Typst Renderer 0.10 (had iOS file-read errors, #38).

### typst.ts measurements

Setup: typst-book, 9 pages, cetz and oxifmt, images, bibliography; 24.3 MB of fonts, 20 MB of them CJK; main thread.

| | Chrome 0.7.0 | WKWebView 0.7.0 | WKWebView 0.8.0-rc3 |
|---|---|---|---|
| WASM compile | 15–18 ms | 32 ms | – |
| init | 12–15 ms | 16 ms | – |
| cold compile | 363 ms | 339 ms | 352 ms |
| recompile, unchanged | 15–18 ms | 13–15 ms | 16–17 ms |
| recompile after a chapter edit | 30 ms | 30 ms | 31 ms |
| PDF export | 48–53 ms | 50 ms | 49 ms |
| all pages → SVG | 21 ms | 21 ms | – |
| one formula (40 formulas) | median 0.3, p95 0.7 ms | ≤ 1 ms | 0–1 ms |
| memory | heap 108 MB; page 304 MB, peak 405 MB (252/350 without CJK) | peak ~408 MB | peak ~414 MB |

Desktop reference: `typst compile` takes about 0.2 s; the desktop formula renderer's median is 0.42 ms. Expect similar numbers on an M-series iPad and 1.5–2× slower on A-series.

### tinymist-web measurements

| | Chrome | WKWebView |
|---|---|---|
| initialize | 12 ms | 3 ms |
| first diagnostics | 22–128 ms | 99 ms |
| first template-name completion | 49–72 ms | 32 ms |
| math completion | 2.4–2.8 ms | 3–4 ms |
| completion while typing | 1.1–1.8 ms | 2–3 ms |
| hover | 1.4 ms | 1 ms |
| semantic tokens | 1.4 ms | 1 ms |
| memory | 111–175 MB | peak ~308 MB |

`@label` completion returned nothing ("no font could be found"), and `exportSvg` is unavailable.

### Plan for Typst

- typst.ts does all rendering: hover and live math, the SVG preview, click-to-source (via source spans) and PDF export.
- tinymist-web supplies the language features through the existing LspClient and completion mapping, over a Worker transport.
  - Fonts need a small upstream PR or a custom build.
- Together the two add about 0.6–0.7 GB at peak: fine on 8 GB iPads, risky on 4 GB. Load them lazily and stop idle Workers.
- Fonts: download NCM once per device; read CJK fonts lazily from a vault folder.
- Packages: fetch them with requestUrl and cache them; on a miss, return nothing, fetch, and recompile. typst.ts only accepted package folders under `/@memory/fetch/packages/…`.
- Use typst.ts 0.8 to match Typst 0.15.

## 4. LaTeX on iPad

- **A. Plain JS (exists).** The editor, built-in completion, and MathJax live preview and hover. It needs the file-access layer, plus labels scanned from source because there is no `.aux` on the device. **Ship first.**
- **B1. BusyTeX (TeX Live 2026)** (texlyre-busytex and texlyre-busytex-build; upstream busytex is TeX Live 2023; active 2026-08).
  - Engines and tools, all in a Worker: pdfTeX, XeTeX with xdvipdfmx, LuaHBTeX, bibtex8, makeindex, a WASM biber (9 MB plus 20 MB of data) and SyncTeX output.
  - Assets: busytex.wasm 31 MB; data bundles basic 88 MB, recommended 192 MB, extra 326 MB; full texmf-dist 1.38 GB compressed. An optional server can fetch missing packages on demand.
  - License: texlyre code and builds are AGPL-3.0; upstream busytex scripts are MIT, and the binaries fall under TeX Live licences.
- **B2. SwiftLaTeX: no.** Last release 2022-02 (TeX Live 2020), AGPL. The package servers are dead: texlive.swiftlatex.com did not resolve and texlive2 timed out on 2026-09-29.
- **B3. Tectonic and texlive.js:** no maintained browser build.
- **texlab in WASM does not exist.** TeXlyre uses a WebSocket to a local texlab.
- **C. Remote compile on the Mac.**
  - A Node service on `src/tex/`: POST the root plus unsaved buffers; get back the PDF, diagnostics, labels and SyncTeX. Optionally texlab over WebSocket.
  - Serve it over HTTPS with `tailscale serve`, bound to the tailnet, with a token.
  - **Best cost/benefit.**
- **D. Native iOS apps.** Texifier and VerbTeX have no API. a-Shell ships TeX Live 2025 plus a Shortcuts "Execute Command", so a plugin could trigger a Shortcut and pick up the PDF from the vault. Experimental fallback only, because the UX is poor.

### BusyTeX measurements

Setup: basic bundle, in a Worker; 14-page amsmath/amsthm article, 40 sections, SyncTeX on, one pass.

| | Chrome | WKWebView | native TL2026 |
|---|---|---|---|
| engine start | 606 ms | 669 ms | – |
| pdfLaTeX, first / next | 272 / 219–229 ms | 274 / 200–222 ms | 0.25 s |
| XeLaTeX, first / next | 707 / 555–567 ms | 596 / 484–493 ms | 0.32 s |
| SyncTeX | 55 KB | yes | – |
| peak memory | 790 MB | ~864 MB | – |

### Package coverage of the prebuilt bundles

| Package | In which bundles |
|---|---|
| amsmath, hyperref | all |
| fontspec, unicode-math, mathtools | recommended and up |
| tikz-cd, tcolorbox, biblatex, elegantbook | extra only |
| ctex, xeCJK, Fandol | none |

### A per-project bundle is much smaller

- The elegantbook fixture compiled natively with XeLaTeX `-recorder` read 278 files from the TeX tree, 14 MB in total (8 MB of TeX files plus the 5.9 MB xelatex.fmt).
- Fonts come on top; the whole Fandol family is 33 MB.
- So the plugin could export a 20–50 MB bundle per project from the dependencies it already tracks, 10–20× smaller than the prebuilt bundles. Rebuild the format file in WASM.
- Native time is 1.33–1.58 s per pass; expect about 1.8× that in WASM on an M-class iPad.
- Remaining gaps:
  - SyncTeX needs synctex-js;
  - texlab is missing;
  - the format cache, watchdog and latexmk logic would have to be redone on the WASM file system;
  - licensing: build from upstream busytex, or ship the engine as a separate user-installed download after an AGPL review.

## 5. Feasibility matrix

Effort: S ≤ 1 week, M 2–4 weeks, L 1–3 months. Risk: L, M, H.

### LaTeX

| Feature | A. Plain JS | B. WASM TeX | C. Remote Mac | D. Native app |
|---|---|---|---|---|
| Editing, highlighting, keys, snippets | yes, S/L (plus touch toolbar, S) | – | – | – |
| Completion | built-in layer, S/L (no texlab) | same as A | texlab over WebSocket, M/M | – |
| Math live preview and hover | MathJax, S/L | real-TeX fragments, L/H | server fragment compile, M/M | – |
| Full compile and PDF | – | pdfLaTeX 0.2–0.3 s, XeLaTeX 0.5–0.7 s, elegantbook ~2–3 s; L–XL/H | yes, M/L–M | a-Shell, M/H |
| SyncTeX | – | synctex-js, M/M | native, S/L | – |
| Compile diagnostics | none (scanners only) | log parser, S/L | existing, S/L | – |
| ref/cite chips, equation numbers | source scan | aux from WASM, S | server labels, S | – |

### Typst

| Feature | A. Plain JS | B. typst.ts | C. tinymist-web | D. Remote tinymist |
|---|---|---|---|---|
| Highlighting | baseline tokenizer, S/L | semantic tokens, S/L | LSP tokens, M/M | M/M |
| Completion, hover, definition, rename, formatting | – | – | yes (1–4 ms), M/M; `@label` after the font fix | M/M |
| Diagnostics | – | compile, S/L | code now, layout after the font fix, M/M | M/M |
| Math live preview and hover | – | < 1 ms, M/L | no (export disabled) | M/M |
| Full preview and PDF | – | ~30 ms edits, M/L–M | – | M/M |
| Click-to-source | – | source spans, M/M | – | M/M |

## 6. Staged plan

0. **Mobile-safe loading** (M, low risk).
   - Add ProjectFiles fed from the vault, POSIX path helpers and a Node-free URI module.
   - Give LspClient a stdio or Worker transport.
   - Keep all Node requires in one desktop module, loaded lazily.
   - Add a build test that main.js imports no Node builtins outside that module, and run the tests with the builtins stubbed to throw.
   - Then set `isDesktopOnly: false` and hide the binary settings on mobile.
1. **iPad editor on the plain layer** (M, low risk).
   - Open `.tex` and `.typ` in the existing views.
   - Make LaTeX live preview the default on touch.
   - Add a key toolbar (Tab, Shift-Tab, Esc, `\`, `$`, braces) and tap-to-render.
2. **Typst on device.**
   - 2a (M): typst.ts 0.8 in a Worker.
     - Download it per device in chunks, keyed by version and checksummed.
     - Add a typst.ts renderer for live math and hover; the shared core already allows swapping renderers.
     - Add the SVG preview and PDF export.
   - 2b (M): tinymist-web in a second Worker behind LspClient.
     - Serve the file exchange from the vault snapshot.
     - Get font loading fixed upstream first.
     - Keep both Workers lazy; warn or disable on 4 GB devices.
3. **Full LaTeX via the Mac** (M, low to medium risk).
   - `latex-live-server` around `src/tex/`, reached through `tailscale serve` HTTPS with a token.
   - The mobile preview reuses pdfRenderer and the problem list; texlab can be proxied optionally.
   - Fall back to stage 1 when the Mac is unreachable.
4. **Optional offline LaTeX** (L–XL, high risk).
   - BusyTeX with the per-project bundle, a self-hosted package server for misses, and synctex-js.
   - pdfLaTeX first, then XeLaTeX with Fandol.
   - Restrict to 8 GB iPads, and settle the AGPL question first.

## 7. Developing and testing for iPad

- **Desktop emulation:** `app.emulateMobile(true)` switches the UI and platform flags, but Node stays available, so it cannot catch a stray `require("fs")`. The stage-0 build test has to catch that.
- **Engine harness on the Mac:** `wkhost` (a real WKWebView that reports the page process's memory) and `run-chrome.sh`. Good for timing and regressions; they do not reproduce iOS memory kills.
- **iOS Simulator:**
  - Xcode 27.0 is installed and lists iPad Pro M4/M5 and Air M4, but no iOS runtime is installed (`xcodebuild -downloadPlatform iOS`, several GB, would add one).
  - Obsidian cannot be installed in the Simulator: App Store builds are device-only.
  - The Simulator is useful only for a custom WKWebView test app (checking WASM, Blob Workers and the absence of SharedArrayBuffer).
  - It could not be confirmed that Obsidian runs as "Designed for iPad" on Apple silicon: the App Store entry (id 1557175442, 1.13.7) lists no Mac device.
- **A real iPad is required for memory and UX.**
  - Install Obsidian 1.13.7 from the App Store.
  - Deploy dev builds by syncing `.obsidian/plugins/<id>/` through iCloud or Obsidian Sync (5 MB limit, so the WASM downloads on each device).
  - Debug with Safari Web Inspector (iOS 16.4+) and use its Timelines for memory.
  - Test on an 8 GB iPad, a 4 GB device, and with Lockdown Mode on.

## 8. Open risks

- **Device checks:**
  - that `loadPdfJs` with its cMaps, and `loadMathJax` with the `MathJax._` classes that ProjectMath uses, behave as on desktop;
  - Chinese IME in custom editor views on iPadOS.
- **tinymist-web is young:**
  - events and responses must run after each call returns, as server.ts does;
  - it has no font API;
  - export is disabled.
- **typst.ts 0.8** is still a release candidate.
- **Downloads:** each engine is about 30 MB, and GitHub release assets are not served compressed; download in chunks.
- **Offline LaTeX** carries most of the risk: Chinese support, elegantbook, biber, iPad memory and AGPL. The remote path avoids all of them.

## Experiments

The measurements above came from throwaway harnesses on the development Mac:
- a static server for TeX Live fonts and the Typst package cache;
- typst.ts, tinymist-web and BusyTeX benchmark pages;
- runners for headless Chrome and a minimal WKWebView host (`WKWebView` + `loadFileURL`, reporting the page process's memory);
- a native `-recorder` run of the elegantbook fixture to size a per-project TeX bundle.

They are not kept in this repository. Rebuild them from the numbers' descriptions when the mobile work starts.
