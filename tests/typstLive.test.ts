// The Typst editor's real extension stack (typstEditorExtensions) against a real
// tinymist in jsdom: completion, smart Enter, snippets, postfix edits, labels, the
// incremental document sync, the book-main pin (also across a preview configuration
// change) and the key arbiter with a fake YOLO.
// Skipped when no tinymist binary is found (TINYMIST_BIN overrides the lookup).
import "./support/dom";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  completionStatus,
  currentCompletions,
  selectedCompletionIndex,
} from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { App } from "obsidian";
import { YoloBridge, YoloEditorShim } from "../src/editor/shared/yoloBridge";
import {
  LspDocument,
  tinymistBackend,
  typstEditorExtensions,
} from "../src/editor/typstEditor";
import { LspClient } from "../src/lsp/client";
import { bookMain } from "../src/preview/previewEntry";
import { fakeYolo } from "./support/fakeYolo";
import { press, quietSettings, sleep, waitFor } from "./support/keyMatrix";

const BIN =
  process.env.TINYMIST_BIN ??
  ["/opt/homebrew/bin/tinymist", "/usr/local/bin/tinymist", join(homedir(), ".cargo", "bin", "tinymist")].find(
    existsSync,
  );

const BASE = [
  "#let theorem(title: none, body) = block[*Theorem* #title: #body]",
  "= Basics <basics>",
  "$ theta + sigma = sum_(i = 1)^n x_i $ <eq-sum>",
  "",
].join("\n");

interface Harness {
  view: EditorView;
  bridge: YoloBridge;
  yolo: ReturnType<typeof fakeYolo>;
  close(): void;
}

test("the Typst editor stack against a real tinymist", { skip: !BIN && "tinymist not found", timeout: 120000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tinymist-live-"));
  const file = join(root, "main.typ");
  writeFileSync(file, BASE);
  const debug = console.debug;
  console.debug = () => {}; // the client forwards tinymist's stderr log here
  const lsp = new LspClient(BIN!, root, () => {});
  let full = 0;
  let ranges = 0;
  const didChange = lsp.didChange.bind(lsp);
  const didChangeRanges = lsp.didChangeRanges.bind(lsp);
  lsp.didChange = (p, text) => (full++, didChange(p, text));
  lsp.didChangeRanges = (p, changes) => (ranges++, didChangeRanges(p, changes));
  await lsp.start();

  /** An editor on `path` whose text is `docWithCursor` (`|` = cursor), opened on the server. */
  async function open(docWithCursor: string, path = file): Promise<Harness> {
    const cursor = docWithCursor.indexOf("|");
    const doc = docWithCursor.replace("|", "");
    const yolo = fakeYolo({ settings: quietSettings() });
    const app = { plugins: { plugins: { yolo: yolo.plugin } } } as unknown as App;
    const bridge = new YoloBridge(app, { name: "test", enabled: () => true });
    const lspFile = new LspDocument(() => lsp);
    const view: EditorView = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: cursor },
        extensions: typstEditorExtensions(
          {
            completion: tinymistBackend(() => lsp, () => path, (state) => lspFile.sync(state.doc)),
            inline: () => bridge.inline,
            yolo: bridge.extension(() => "main.typ"),
            onEdit: (_v, changes, startDoc) => lspFile.sync(view.state.doc, { changes, startDoc }),
          },
          doc,
        ),
      }),
      parent: document.body,
    });
    view.focus();
    lspFile.open(path, view.state.doc);
    await sleep(1000); // first compile (labels come from the compiled document)
    return {
      view,
      bridge,
      yolo,
      close() {
        view.destroy();
        bridge.destroy();
        lspFile.close();
      },
    };
  }

  /** Type through the input handlers, pausing like a person (past the 100 ms delay). */
  async function type(view: EditorView, text: string, gap = 150) {
    for (const ch of text) {
      const { from, to } = view.state.selection.main;
      const insert = () =>
        view.state.update({ changes: { from, to, insert: ch }, selection: { anchor: from + 1 }, userEvent: "input.type" });
      if (!view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, ch, insert))) view.dispatch(insert());
      await sleep(gap);
    }
  }
  const usable = async (view: EditorView) => {
    await waitFor(() => selectedCompletionIndex(view.state) !== null, 5000);
    await sleep(90); // interactionDelay
  };
  const labels = (view: EditorView) => currentCompletions(view.state).map((c) => c.label);
  const line = (view: EditorView) => {
    const head = view.state.selection.main.head;
    const l = view.state.doc.lineAt(head);
    return l.text.slice(0, head - l.from) + "|" + l.text.slice(head - l.from);
  };

  try {
    await t.test("$ x = the + Tab gives theta (a symbol the document uses)", async () => {
      const h = await open(BASE + "$ x = |$\n");
      try {
        await type(h.view, "the");
        await usable(h.view);
        assert.equal(labels(h.view)[0], "theta");
        assert.equal(press(h.view, "Tab").handled, true);
        assert.equal(line(h.view), "$ x = theta|$");
      } finally {
        h.close();
      }
    });

    await t.test("theta typed with 150 ms gaps, then Enter: a newline, still lowercase", async () => {
      const h = await open(BASE + "$ x = |$\n");
      try {
        await type(h.view, "theta");
        await usable(h.view);
        press(h.view, "Enter");
        await sleep(0);
        assert.match(h.view.state.doc.toString(), /\$ x = theta\n\$\n$/);
        assert.equal(completionStatus(h.view.state), null);
      } finally {
        h.close();
      }
    });

    await t.test("#fi, pick figure.paren, Tab: the cursor lands inside the parentheses", async () => {
      const h = await open(BASE + "|\n");
      try {
        await type(h.view, "#fi");
        await usable(h.view);
        const at = labels(h.view).indexOf("figure.paren");
        assert.ok(at > 0, labels(h.view).slice(0, 8).join(", "));
        for (let i = 0; i < at; i++) press(h.view, "ArrowDown");
        press(h.view, "Tab");
        assert.equal(line(h.view), "#figure(|)");
      } finally {
        h.close();
      }
    });

    await t.test("postfix: $arrow. then bb + Tab rewrites to bb(arrow)", async () => {
      const h = await open(BASE + "$arrow|$\n");
      try {
        await type(h.view, ".bb");
        await usable(h.view);
        assert.equal(labels(h.view)[0], "bb");
        press(h.view, "Tab");
        assert.equal(line(h.view), "$bb(arrow)|$");
      } finally {
        h.close();
      }
    });

    await t.test("$ a arrow. keeps tinymist's order: modifiers before postfix rewrites", async () => {
      const h = await open(BASE + "$ a arrow|$\n");
      try {
        await type(h.view, ".", 250);
        await usable(h.view);
        assert.deepEqual(labels(h.view).slice(0, 2), ["b", "bar"]);
        press(h.view, "Tab");
        assert.equal(line(h.view), "$ a arrow.b|$");
      } finally {
        h.close();
      }
    });

    await t.test("a list `.` opened is not accepted by Enter until the user types or navigates", async () => {
      // TS-1: Enter used to take tinymist's first member or postfix item and rewrite the text.
      for (const [doc, after] of [
        ["as proved in #cite(<basics>)|\n", "as proved in #cite(<basics>).\n|"],
        ["$\n  forall x in A|\n$\n", "  forall x in A.\n  |"],
        ["We have #calc|\n", "We have #calc.\n|"],
        ["$ a arrow|$\n", "$ a arrow.\n|"], // not rewritten by a modifier or postfix item
      ]) {
        const h = await open(BASE + doc);
        try {
          await type(h.view, ".", 250);
          await usable(h.view);
          press(h.view, "Enter");
          const d = h.view.state.doc.toString();
          const head = h.view.state.selection.main.head;
          const around = d.slice(d.lastIndexOf("\n", d.lastIndexOf("\n", head - 1) - 1) + 1, head) + "|";
          assert.equal(around, after, doc);
          assert.equal(completionStatus(h.view.state), null);
        } finally {
          h.close();
        }
      }
      // Typed on, or navigated: Enter accepts.
      const h = await open(BASE + "#calc|\n");
      try {
        await type(h.view, ".ab", 250);
        await usable(h.view);
        press(h.view, "Enter");
        assert.equal(line(h.view), "#calc.abs(|)");
        const l4 = h.view.state.doc.line(4);
        h.view.dispatch({ changes: { from: l4.from, to: l4.to, insert: "#calc" }, selection: { anchor: l4.from + 5 } });
        await type(h.view, ".", 250);
        await usable(h.view);
        const second = labels(h.view)[1];
        press(h.view, "ArrowDown");
        press(h.view, "Enter");
        assert.ok(line(h.view).startsWith(`#calc.${second}`), `${second}: ${line(h.view)}`);
      } finally {
        h.close();
      }
      // In math too. (A fresh file: with the erroring `#calc.pow()` above in the document,
      // tinymist 0.15.2 answers nothing after `$ a arrow.`)
      const m = await open(BASE + "$ a arrow|$\n");
      try {
        await type(m.view, ".ba", 250);
        await usable(m.view);
        press(m.view, "Enter");
        assert.equal(line(m.view), "$ a arrow.bar|$");
      } finally {
        m.close();
      }
    });

    await t.test('string values: "us-le filters one list, Enter inserts the whole value', async () => {
      const h = await open(BASE + "#set page(paper: |)\n");
      try {
        await type(h.view, '"us-le');
        await usable(h.view);
        assert.ok(labels(h.view).slice(0, 3).every((l) => l.startsWith('"us-le')), labels(h.view).slice(0, 5).join(", "));
        press(h.view, "Enter");
        assert.match(line(h.view), /^#set page\(paper: "us-le[a-z]+\|"\)$/);
      } finally {
        h.close();
      }
    });

    await t.test("@ completes the document's labels", async () => {
      const h = await open(BASE + "See |\n");
      try {
        await type(h.view, "@");
        await usable(h.view);
        assert.ok(labels(h.view).includes("eq-sum"), labels(h.view).join(", "));
        await type(h.view, "ba");
        await usable(h.view);
        press(h.view, "Tab");
        assert.equal(line(h.view), "See @basics|");
      } finally {
        h.close();
      }
    });

    await t.test("edits reach the server incrementally", () => {
      assert.ok(ranges > 10, `incremental: ${ranges}`);
      assert.equal(full, 0);
    });

    await t.test("a chapter pinned through its book main completes other chapters' labels", async () => {
      const book = join(root, "book");
      mkdirSync(join(book, "chapters"), { recursive: true });
      const main = join(book, "main.typ");
      writeFileSync(main, '#include "chapters/a.typ"\n#include "chapters/b.typ"\n');
      const a = join(book, "chapters", "a.typ");
      writeFileSync(a, "= Chapter A <ch-a>\n");
      writeFileSync(join(book, "chapters", "b.typ"), "= Chapter B <ch-b>\n");
      assert.equal(bookMain(a, root), main);
      const h = await open("= Chapter A <ch-a>\nSee |\n", a);
      try {
        lsp.pinMain(main);
        await sleep(1000);
        // A preview configuration change resets tinymist's entry; the client re-pins.
        lsp.setPreviewSource("/book/chapters/a.typ");
        await sleep(300);
        await type(h.view, "@");
        await usable(h.view);
        assert.deepEqual(labels(h.view).sort(), ["ch-a", "ch-b"]);
      } finally {
        lsp.setPreviewSource();
        lsp.pinMain(null);
        h.close();
      }
    });

    await t.test("key arbiter with a (fake) YOLO: raw accept, popup wins, Enter never accepts AI", async () => {
      const h = await open(BASE + "Intro |\n");
      const ghost = async (text: string) => {
        assert.ok(h.bridge.triggerNow(h.view));
        h.yolo.respond(text);
        await sleep(0);
      };
      try {
        await ghost("<intro>");
        assert.equal(h.view.contentDOM.querySelector(".yolo-ghost-text")?.textContent, "<intro>");
        press(h.view, "Tab");
        assert.equal(line(h.view), "Intro <intro>|"); // not YOLO's Markdown-escaped \<intro\>
        await ghost("more");
        press(h.view, "Enter");
        await sleep(0);
        assert.equal(line(h.view), "|");
        assert.ok(!h.view.state.doc.toString().includes("more"));
        // The completion popup wins over a ghost that arrives while it is open.
        await type(h.view, "#fi");
        await usable(h.view);
        void h.yolo.tab.run(new YoloEditorShim(h.view), h.view.state.selection.main.head);
        h.yolo.respond("gure(x)");
        await sleep(10);
        assert.equal(h.view.contentDOM.querySelector(".yolo-ghost-text"), null);
        press(h.view, "Tab");
        assert.equal(line(h.view), "#figure|");
        assert.deepEqual(h.yolo.hijacked, []); // YOLO's own keymap is never mounted
      } finally {
        h.close();
      }
    });
  } finally {
    lsp.stop();
    await sleep(600); // stop() kills the process after its shutdown grace period
    console.debug = debug;
    rmSync(root, { recursive: true, force: true });
  }
});
