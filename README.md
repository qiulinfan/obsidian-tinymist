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

## Development

```sh
npm install
npm run build        # or: npm run dev (watch mode)
scripts/install-dev.sh /absolute/path/to/vault
```

`install-dev.sh` symlinks this checkout into the vault's
`.obsidian/plugins/obsidian-tinymist/`. Enable the plugin in Obsidian's
community-plugin settings, then open any `.typ` file. Use the command
"Tinymist: Open preview" for the live preview pane.

Development conventions live in [AGENTS.md](AGENTS.md).

## License

Apache-2.0. Tinymist, Typst, and typst.ts are Apache-2.0 upstream projects.
