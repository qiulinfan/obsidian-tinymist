# obsidian-tinymist

Tinymist-grade Typst editing inside Obsidian: a thin Obsidian frontend for
the [Tinymist](https://github.com/Myriad-Dreamin/tinymist) language server,
in the same spirit as its VS Code, Neovim, Zed, and Helix integrations.

The plugin registers a CodeMirror 6 editor for `.typ` files, drives a local
`tinymist` binary for language intelligence (diagnostics, completion, hover,
and more over time), and embeds Tinymist's incremental live preview in a side
pane. It does not reimplement the compiler, the language service, or the
preview pipeline. See [docs/roadmap.md](docs/roadmap.md).

Desktop only. Requires a `tinymist` binary (Homebrew: `brew install
tinymist`); the path is configurable in settings and auto-detected from PATH
and common locations.

## Status

v0.2 — used daily on a real multi-file math-notes vault:

- `.typ` files open in a CodeMirror 6 editor with semantic-token
  highlighting from the language server (baseline tokenizer as fallback).
- Diagnostics, completion (with snippet expansion), and hover documentation.
- Live preview inside the LSP session: unsaved edits render, and cursor
  sync is bidirectional — moving in the editor scrolls the preview, and
  clicking the preview jumps the editor to the source, across files.
- Go to definition (F12 / Cmd+click), rename symbol, and typstyle
  formatting, all vault-wide.
- Experimental: a bridge that drives the YOLO plugin's AI tab completion
  inside Typst files (off by default; see settings).

Not yet here: find-references UI, outline panel, signature help, binary
auto-download, and mobile. See the roadmap for the plan and ordering.

## Styled chapter previews

For chapters that import template functions but do not apply the document's
layout, put a `.tinymist-preview.typ` file in their directory or an ancestor
inside the vault. The nearest file becomes the preview entry. It receives
`sys.inputs.at("preview-source")`, the selected source's absolute Typst path
relative to the vault root (not an OS path). For example:

```typst
#import "template.typ": chapter-layout
#show: chapter-layout
#include sys.inputs.at("preview-source")
```

The project template owns all styling and can decide which files to wrap.
Place it in a chapters directory to limit its scope, or let it pass complete
documents through without another layout. Without this file, previews compile
the selected file directly. Opening the preview template itself also compiles
it directly; it must provide a default input if it supports that use.

The plugin sets `--root <vault>` and `--input preview-source=...` through
Tinymist's LSP compiler configuration for the preview session;
it does not rewrite chapter buffers. Tinymist includes the original source,
preserving live edits and source positions. Ordinary compilation/export is
unaffected. Reopen the preview after adding or removing a template.

## Development

```sh
npm install
npm run build        # or: npm run dev (watch mode)
npm test
TINYMIST_BIN=/absolute/path/to/tinymist npm test  # real LSP integration test
scripts/install-dev.sh /absolute/path/to/vault
```

`install-dev.sh` symlinks this checkout into the vault's
`.obsidian/plugins/obsidian-tinymist/`. Enable the plugin in Obsidian's
community-plugin settings, then open any `.typ` file. Use the command
"Tinymist: Open preview" for the live preview pane.

Development conventions live in [AGENTS.md](AGENTS.md).

## License

Apache-2.0. Tinymist, Typst, and typst.ts are Apache-2.0 upstream projects.
