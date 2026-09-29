import { App, PluginSettingTab, Setting } from "obsidian";
import type TinymistPlugin from "./main";

export interface TinymistSettings {
  /** Absolute path to the tinymist binary; empty means auto-detect. */
  binaryPath: string;
  /** Debounce for writing edits to disk; disk writes drive the preview. */
  saveDebounceMs: number;
  /** Passed to `tinymist preview --invert-colors` when not "never". */
  invertPreviewColors: "never" | "auto";
  /** Experimental: drive the YOLO plugin's AI tab completion in .typ files. */
  yoloTabCompletion: boolean;
  /** Compile a chapter through the book main.typ that includes it. */
  pinBookMain: boolean;
}

export const DEFAULT_SETTINGS: TinymistSettings = {
  binaryPath: "",
  saveDebounceMs: 500,
  invertPreviewColors: "never",
  yoloTabCompletion: false,
  pinBookMain: true,
};

export class TinymistSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TinymistPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Tinymist binary path")
      .setDesc(
        "Absolute path to the tinymist executable. Leave empty to " +
          "auto-detect from common install locations and the login shell PATH.",
      )
      .addText((text) =>
        text
          .setPlaceholder("/opt/homebrew/bin/tinymist")
          .setValue(this.plugin.settings.binaryPath)
          .onChange(async (value) => {
            this.plugin.settings.binaryPath = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Save debounce (ms)")
      .setDesc(
        "How long to wait after an edit before writing the file to disk. " +
          "Disk writes trigger the live preview refresh.",
      )
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.saveDebounceMs))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 100 && n <= 10000) {
              this.plugin.settings.saveDebounceMs = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Compile chapters through their book")
      .setDesc(
        "When a chapter is included by a main.typ above it, compile it through " +
          "that file, so @ completes labels from every chapter and diagnostics " +
          "see the book's imports.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.pinBookMain)
          .onChange(async (value) => {
            this.plugin.settings.pinBookMain = value;
            await this.plugin.saveSettings();
            this.plugin.syncPinnedMain();
          }),
      );

    const yoloDesc = () =>
      "Show the YOLO plugin's AI completion (ghost text) in Typst files: Tab " +
      "accepts, Shift-Tab or Escape dismisses, and the completion popup always " +
      "wins. Uses YOLO's own triggers and its tab-completion toggle. May break " +
      "when YOLO updates. Status: " +
      (this.plugin.settings.yoloTabCompletion
        ? this.plugin.yolo.describe()
        : "off") +
      ".";
    const yolo = new Setting(containerEl)
      .setName("YOLO tab completion (experimental)")
      .setDesc(yoloDesc())
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.yoloTabCompletion)
          .onChange(async (value) => {
            this.plugin.settings.yoloTabCompletion = value;
            await this.plugin.saveSettings();
            this.plugin.yolo.refresh();
            yolo.setDesc(yoloDesc());
          }),
      );

    new Setting(containerEl)
      .setName("Invert preview colors")
      .setDesc("Useful for dark themes; 'auto' follows the system scheme.")
      .addDropdown((dd) =>
        dd
          .addOptions({ never: "never", auto: "auto" })
          .setValue(this.plugin.settings.invertPreviewColors)
          .onChange(async (value) => {
            this.plugin.settings.invertPreviewColors =
              value === "auto" ? "auto" : "never";
            await this.plugin.saveSettings();
            this.plugin.preview.stop();
          }),
      );
  }
}
