// TypstView on the test stand-in for Obsidian's TextFileView (tests/support/obsidian.ts).
import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorView } from "@codemirror/view";
import { HistoryCache } from "../src/editor/shared/editorKit";
import { YoloBridge } from "../src/editor/shared/yoloBridge";
import { TypstView } from "../src/editor/typstView";
import type TinymistPlugin from "../src/main";
import { TFile, TextFileView, WorkspaceLeaf, testApp } from "./support/obsidian";
import { sleep } from "./support/keyMatrix";

function typstView(saveDebounceMs: number) {
  const app = testApp();
  const didSave: (string | undefined)[] = [];
  const plugin = {
    app,
    lsp: {
      status: "stopped",
      completionTriggerCharacters: () => [],
      didSave: () => didSave.push(app.vault.files.get("a.typ")),
    },
    settings: { saveDebounceMs },
    history: new HistoryCache(),
    yolo: new YoloBridge(app as never, { name: "test", enabled: () => false }),
    onDiagnostics: () => () => {},
    openPreview: async () => {},
    togglePreview: async () => {},
    syncPinnedMain: () => {},
    vaultBasePath: () => "/vault",
    preview: { cursorMoved: () => {} },
  };
  const view = new TypstView(new WorkspaceLeaf(app) as never, plugin as unknown as TinymistPlugin);
  return { view, vault: app.vault, didSave };
}

function insert(cm: EditorView, from: number, to: number, text: string, compose: boolean) {
  cm.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    userEvent: compose ? "input.type.compose" : "input.type",
  });
}

/** Real DOM composition events: CodeMirror's own observers track the composition. */
const composition = (cm: EditorView, type: "compositionstart" | "compositionend") =>
  cm.contentDOM.dispatchEvent(new CompositionEvent(type, { bubbles: true, data: "" }));

test("uncommitted IME text (Pinyin) is never written; the committed text is saved after compositionend", async () => {
  const requestSaveMs = TextFileView.requestSaveMs;
  // [the plugin's save debounce, Obsidian's requestSave debounce, the committed text]
  const cases: [number, number, string | null][] = [
    [50, 100000, "你好"], // the plugin's debounce fires mid-composition
    [100000, 50, "你好"], // Obsidian's own requestSave fires mid-composition
    [50, 100000, null], // a composition that changes nothing: the earlier edit is still saved
  ];
  try {
    for (const [saveDebounceMs, obsidianMs, committed] of cases) {
      TextFileView.requestSaveMs = obsidianMs;
      const { view, vault, didSave } = typstView(saveDebounceMs);
      vault.files.set("a.typ", "Hello ");
      await view.loadFile(new TFile("a.typ") as never);
      const cm = view.cm!;
      const label = JSON.stringify({ saveDebounceMs, obsidianMs, committed });
      try {
        insert(cm, 6, 6, "world, ", false); // a committed edit starts both debounces
        await sleep(10);
        composition(cm, "compositionstart");
        assert.equal(cm.compositionStarted, true);
        if (committed) insert(cm, 13, 13, "ni'hao", true); // the marked text is in the document
        await sleep(150);
        assert.deepEqual(vault.writes, [], label);
        assert.deepEqual(didSave, [], label);
        if (committed) insert(cm, 13, 19, committed, true); // picking a candidate replaces it
        composition(cm, "compositionend");
        await sleep(150);
        const saved = `Hello world, ${committed ?? ""}`;
        assert.deepEqual(vault.writes.map((w) => w.data), [saved], label);
        if (saveDebounceMs < 1000) assert.deepEqual(didSave, [saved], label);
      } finally {
        await view.onClose();
      }
    }
  } finally {
    TextFileView.requestSaveMs = requestSaveMs;
  }
});
