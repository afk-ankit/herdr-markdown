// One markdown file as rich text, in its own tab, with ```mermaid blocks drawn as diagrams
// by ./mermaid/render.mjs (node + beautiful-mermaid) into data/markdown/.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextView, ScrollHandle } from "gpui-base";
import { props, theme, exec, readTextFile, watchFolder, appHome, checking, shared, setShared, settings } from "herdr";

const MAX_BYTES = 400000;
const CACHE = "data/markdown";
const PAD = 32;
// Bump when render.mjs draws differently: Herdr caches images by path.
const RENDERER = "4";

const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); };

// Markdown text and ```mermaid / ~~~mermaid blocks, in order.
function segments(text) {
  const out = [];
  let md = [], diagram = null, fence = null;
  for (const line of text.split("\n")) {
    if (diagram) {
      if (line.trim().startsWith(fence) && !line.trim().replace(/[`~]/g, "")) { out.push({ type: "mermaid", src: diagram.join("\n") }); diagram = null; }
      else diagram.push(line);
      continue;
    }
    const m = line.match(/^\s*(`{3,}|~{3,})\s*mermaid\s*$/i);
    if (m) {
      if (md.length) out.push({ type: "md", text: md.join("\n") });
      md = []; diagram = []; fence = m[1];
      continue;
    }
    md.push(line);
  }
  if (diagram) md.push("```mermaid", ...diagram);
  if (md.length) out.push({ type: "md", text: md.join("\n") });
  return out;
}

const svgSize = (text) => {
  const w = Number(text.match(/<svg[^>]*\swidth="([\d.]+)"/)?.[1]), h = Number(text.match(/<svg[^>]*\sheight="([\d.]+)"/)?.[1]);
  return w && h ? { w, h } : null;
};

export class Reader {
  init(_props, cx) {
    const p = props() ?? {};
    this.file = p.file;
    this.on = p.on ?? null;
    this.text = null;
    this.parts = [];
    this.error = null;
    this.diagrams = new Map(); // key -> { state, path, w, h, error }
    this.width = 800;
    this.heights = [];
    // The scroll area is built again when the tab is shown. The handle keeps the
    // pixel offset while this copy stays alive; the saved block covers a new copy.
    this.scroll = ScrollHandle.new();
    const raw = localStorage.getItem(this.scrollKey());
    const saved = raw == null ? NaN : Number(raw);
    this.restore = Number.isInteger(saved) && saved >= 0 ? saved : null;
    this.hold = this.restore != null;
    this.load(cx);
    if (!this.on && !checking()) this.follow(cx);
  }

  scrollKey() {
    return "md-scroll:" + this.file;
  }

  // Which block starts at the current scroll, once every block has been measured.
  remember() {
    if (checking() || !this.parts.length) return;
    if (!(this.scroll.content_size().height > 0)) return;
    if (this.parts.some((_, i) => !(this.heights[i] > 0))) return;
    const y = this.scroll.offset().y;
    // Right after a restore the area can still report the top. Don't replace the saved block with that.
    if (this.hold) {
      if (y < 1 && this.restore > 0) return;
      this.hold = false;
    }
    let acc = 24, index = 0;
    for (let i = 0; i < this.parts.length; i++) {
      if (acc + this.heights[i] > y + 1) { index = i; break; }
      acc += this.heights[i] + 14;
      index = i;
    }
    if (index === this.saved) return;
    this.saved = index;
    localStorage.setItem(this.scrollKey(), String(index));
  }

  close() {
    this.remember();
    this.watch?.cancel();
    this.scroll?.release();
  }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.file, { on: this.on });
        if (text === null) this.error = "This file is no longer available.";
        else {
          this.text = text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) + "\n\n*… file truncated*" : text;
          this.parts = segments(this.text);
          this.error = null;
        }
      } catch {
        this.error = "Can't read this file.";
      }
      cx.notify();
    });
  }

  follow(cx) {
    const dir = this.file.slice(0, this.file.lastIndexOf("/"));
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          this.watch = watchFolder(dir);
          const changed = await this.watch;
          if (!changed.length) return;
          if (changed.some((p) => p === this.file || p === dir)) this.load(cx);
        }
      } catch {}
    });
  }

  colors(t) {
    return { bg: t.background, fg: t.foreground, line: t.muted, accent: t.accent, muted: t.muted, surface: t.raised, border: t.input };
  }

  diagram(src, t, cx) {
    const colors = this.colors(t);
    const key = hash(RENDERER + src + JSON.stringify(colors));
    let d = this.diagrams.get(key);
    if (d || checking()) return d ?? { state: "loading" };
    d = { state: "loading", path: `${CACHE}/${key}.svg` };
    this.diagrams.set(key, d);
    const out = `${appHome()}/${d.path}`;
    cx.spawn(async (cx) => {
      const cached = await readTextFile(out).catch(() => null);
      let size = cached && svgSize(cached);
      if (size) size.png = (await exec("test", ["-f", out.replace(/\.svg$/, ".png")]).catch(() => null))?.code === 0;
      if (!size) {
        try {
          await exec("mkdir", ["-p", `${appHome()}/${CACHE}`]);
          const r = await exec("node", [`${appHome()}/mods/markdown/mermaid/render.mjs`, "-", out, JSON.stringify(colors), src], { timeout: 20000 });
          if (r.code === 0) size = JSON.parse(r.stdout.trim().split("\n").pop());
          else d.error = /not found|No such file|ERR_MODULE_NOT_FOUND|Cannot find package/i.test(r.stderr) && r.code !== 1
            ? "Needs Node.js to draw diagrams." : (r.stderr.trim() || "Couldn't draw this diagram.");
        } catch {
          d.error = "Needs Node.js to draw diagrams.";
        }
      }
      if (size) Object.assign(d, { state: "ok", w: size.w, h: size.h, path: size.png ? d.path.replace(/\.svg$/, ".png") : d.path });
      else d.state = "bad";
      cx.notify();
    });
    return d;
  }

  copy(s, cx) {
    if (!s?.text) return;
    this.selection = s.text;
    cx.write_to_clipboard(s.text);
    this.focus?.focus();
  }

  markdown(id, source) {
    return TextView.markdown(id, source).selectable(true)
      .on_selection_change((s, cx) => this.copy(s, cx));
  }

  block(part, i, t, cx) {
    if (part.type === "md") return this.markdown(`md-${i}`, part.text);
    const d = this.diagram(part.src, t, cx);
    if (d.state === "ok") {
      const max = Math.max(120, this.width - PAD * 2 - 34);
      const scale = Math.min(1, max / d.w);
      return h_flex().id(`dia-${i}`).w_full().justify_center().py(16).rounded(10).bg(t.background).border_1().border_color(t.border)
        .child(image(d.path).w(d.w * scale).h(d.h * scale));
    }
    if (d.state === "loading")
      return h_flex().id(`dia-${i}`).h(64).w_full().justify_center().items_center().gap(8).rounded(10).border_1().border_color(t.border).text_size(12).text_color(t.dim)
        .child(svg("mods/workspace-chrome/spinner.svg").size(14).spin(900)).child("Drawing diagram…");
    return v_flex().gap(6)
      .child(this.markdown(`dia-src-${i}`, "```mermaid\n" + part.src + "\n```"))
      .child(div().text_size(11.5).text_color(t.blocked).child(`Diagram not drawn: ${d.error}`));
  }

  render(cx) {
    const t = theme();
    const slash = this.file?.lastIndexOf("/") ?? -1;
    const name = this.file?.slice(slash + 1) ?? "", folder = this.file?.slice(0, slash).replace(/^\/Users\/[^/]+/, "~") ?? "";
    const centered = shared("markdown.centered") === true;
    if (this.restore != null && this.parts.length && !this.restored) {
      this.scroll.scroll_to_item(Math.min(this.restore, this.parts.length - 1));
      this.restored = true;
    }
    this.remember();
    const zoom = settings().zoom || 1;
    const page = v_flex().id("md-scroll").flex_1().min_h(0).max_w(900).w_full().overflow_y_scrollbar().track_scroll(this.scroll)
      .px(PAD).py(24).gap(14)
      .when(this.text === null, (el) => el.child(div().text_color(t.dim).child(this.error ?? "Loading…")))
      .children(this.parts.map((part, i) => div().id(`part-${i}`).w_full()
        .on_size_change((size) => { this.heights[i] = size.height / zoom; })
        .child(this.block(part, i, t, cx))));
    return v_flex().id("reader").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(14)
      .track_focus(this.focus)
      .on_key_down((e, cx) => {
        if (e.keystroke !== "cmd-c" || !this.selection) return;
        cx.write_to_clipboard(this.selection);
        cx.stop_propagation();
      })
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } })
      .child(h_flex().h(40).flex_none().px(16).gap(8).items_center().border_b_1().border_color(t.border).bg(t.chrome)
        .child(svg("mods/markdown/markdown.svg").size(14).flex_none().text_color(t.accent))
        .child(div().flex_none().font_semibold().text_size(13).child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(folder))
        .child(div().id("align").p(4).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip(centered ? "Align left" : "Center")
          .on_click(() => setShared("markdown.centered", !centered))
          .child(svg(`mods/markdown/${centered ? "align-left" : "align-center"}.svg`).size(13).text_color(t.dim)))
        .child(div().id("reload").p(4).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Reload")
          .on_click((_e, cx) => { this.diagrams.clear(); this.load(cx); })
          .child(svg("mods/workspace-chrome/clock.svg").size(13).text_color(t.dim))))
      .child(centered
        ? h_flex().flex_1().min_h(0).w_full().justify_center().child(page)
        : page);
  }
}
