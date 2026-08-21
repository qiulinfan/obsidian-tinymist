# YOLO AI tab-completion bridge

The plugin can drive the [YOLO](https://github.com/Lapis0x0) Obsidian
plugin's AI tab completion inside `.typ` editors. YOLO's own trigger is
gated on the active Markdown view, so the bridge mounts YOLO's
inline-suggestion rendering into our editor and drives the request path
itself (see `src/editor/yoloBridge.ts`). It fails soft when YOLO is absent
and may need updating when YOLO's internals change.

## Setup on a new machine

1. Install and configure YOLO (providers, model, and its own
   "tab completion" toggle). YOLO's config, including API keys, lives in
   the vault's `.obsidian/plugins/yolo/data.json` and is deliberately not
   tracked by Git — configure it per machine.
2. Enable "YOLO tab completion (experimental)" in this plugin's settings,
   then reopen `.typ` files.
3. Paste the prompt below into YOLO's settings under tab completion
   constraints (`continuationOptions.tabCompletionConstraints`), so
   completions use Typst syntax in `.typ` files while Markdown notes keep
   LaTeX-style math. The instruction is format-detecting, so one global
   constraint serves both file types.

## Constraint prompt

```text
First detect the document format from the context. If it is Typst source
(signals: #import, #let, #show, #theorem, #definition, math like
subset.eq, bR, bN, epsilon): write ALL math in Typst syntax inside $...$,
e.g. $epsilon > 0$, $n >= N$, $abs(x_m - x_n) < epsilon$; reuse aliases
seen in the context (bR, bN, bQ, cal(P)); NEVER use backslash LaTeX
commands (\varepsilon, \ge, \frac, \mathbb) or LaTeX delimiters.
Otherwise it is Markdown: write normal Markdown with LaTeX math as usual.
```

Alternatively, apply it from the developer console with YOLO enabled:

```js
const y = app.plugins.plugins.yolo;
const s = JSON.parse(JSON.stringify(y.settings));
(s.continuationOptions ??= {}).tabCompletionConstraints = `<paste the prompt above>`;
await y.setSettings(s);
```
