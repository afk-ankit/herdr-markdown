// Markdown: in the panel, the project's markdown files; with props { file, on? }, that file
// as rich text in its own tab, mermaid diagrams included.

import { View } from "gpui-kit";
import { props, nextCommand, checking } from "herdr";
import { List } from "./list.js";
import { Reader } from "./reader.js";

export default class Markdown extends View {
  init(p, cx) {
    // The reader keeps this and focuses it when text is selected, so Cmd+C
    // is not delivered to the terminal behind the panel.
    this.handle = cx.focus_handle();
    this.view = props()?.file ? new Reader() : new List();
    this.view.focus = this.handle;
    this.view.init(p, cx);
    if (checking()) return;
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.handle.focus();
      }
    });
  }

  async close() {
    this.handle?.release();
    await this.view.close?.();
  }

  render(cx) {
    return this.view.render(cx);
  }
}
