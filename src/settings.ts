import { App, PluginSettingTab, Setting } from "obsidian";
import type TinymistPlugin from "./main";

export interface TinymistSettings {
  /** Absolute path to the tinymist binary; empty means auto-detect. */
  binaryPath: string;
  /** Debounce for writing edits to disk; disk writes drive the preview. */
  saveDebounceMs: number;
  /** Passed to `tinymist preview --invert-colors` when not "never". */
  invertPreviewColors: "never" | "auto";
}

export const DEFAULT_SETTINGS: TinymistSettings = {
  binaryPath: "",
  saveDebounceMs: 500,
  invertPreviewColors: "never",
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
