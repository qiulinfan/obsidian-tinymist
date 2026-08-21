import { ItemView, WorkspaceLeaf } from "obsidian";
import type TinymistPlugin from "../main";

export const VIEW_TYPE_TYPST_PREVIEW = "tinymist-preview";

export class PreviewView extends ItemView {
  private iframe: HTMLIFrameElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: TinymistPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_TYPST_PREVIEW;
  }

  getDisplayText(): string {
    return "Typst preview";
  }

  getIcon(): string {
    return "eye";
  }

  setUrl(url: string): void {
    if (!this.iframe) {
      this.contentEl.addClass("tym-preview-content");
      this.iframe = this.contentEl.createEl("iframe", {
        cls: "tym-preview-frame",
      });
    }
    if (this.iframe.src !== url) this.iframe.src = url;
  }

  async onClose(): Promise<void> {
    this.plugin.preview.stop();
    this.iframe = null;
    await super.onClose();
  }
}
