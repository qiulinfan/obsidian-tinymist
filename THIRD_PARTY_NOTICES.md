# Third-party notices

The author-owned plugin source and documentation use [MIT](LICENSE). This
license change does not relicense upstream projects, their binaries, libraries,
or any copyrightable upstream material in recorded protocol responses.

| Component or material | Original license | How it is used |
| --- | --- | --- |
| [Tinymist](https://github.com/Myriad-Dreamin/tinymist) | [Apache-2.0](licenses/Apache-2.0.txt) | A separately installed executable; no Tinymist implementation or binary is bundled. `tests/fixtures/tinymist-completion.json` records responses to synthetic documents. |
| [Typst](https://github.com/typst/typst) and [typst.ts](https://github.com/Myriad-Dreamin/typst.ts) | [Apache-2.0](licenses/Apache-2.0.txt) | Compiler and preview components supplied by Tinymist; their original terms remain unchanged. |
| [Texlab](https://github.com/latex-lsp/texlab) | [GPL-3.0](licenses/GPL-3.0.txt) | `tests/fixtures/texlab-completion.json` records responses for shared completion tests. No Texlab implementation or binary is bundled. Any upstream-derived copyrightable text retains its upstream terms. |
| [CodeMirror](https://codemirror.net/) and [Lezer](https://lezer.codemirror.net/) | MIT | Provided by Obsidian at runtime and kept external to the plugin bundle. |
| [Obsidian](https://obsidian.md/) | Obsidian's own terms | The host application and API are not relicensed by this plugin. |

Synthetic test documents and the plugin's own adapter code are author-owned.
Development packages retain their individual licenses in `package-lock.json`
and their upstream distributions. Typst packages imported by a document have
their own licenses, separate from this plugin.

The Apache-2.0 text is retained verbatim from the repository's original license;
the GPL-3.0 text is retained verbatim from Texlab's upstream LICENSE. Existing
copyright notices in third-party distributions remain in force.
