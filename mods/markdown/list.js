// Markdown files in the focused pane's project. A click opens the file in its own tab;
// clicking it again returns to that tab.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, run, theme } from "herdr";

const LIMIT = 2000;

// Where the focused terminal is; null while a mod pane (a reader tab) has focus, which has no
// folder of its own: the list keeps the last terminal's.
function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  if (pane?.mod) return null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

// Relative paths from the repo root (honouring .gitignore), else from cwd via find.
async function listMarkdown(cwd, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
  if (top?.code === 0) {
    const root = top.stdout.trim();
    const r = await exec("git", ["--no-optional-locks", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate", "--", "*.md", "*.markdown", "*.mdx"], { cwd: root, on });
    if (r.code === 0) return { root, files: r.stdout.split("\0").filter(Boolean) };
  }
  const r = await exec("find", [".", "(", "-name", "node_modules", "-o", "-name", ".*", "-not", "-name", ".", ")", "-prune", "-o", "-type", "f", "(", "-iname", "*.md", "-o", "-iname", "*.markdown", "-o", "-iname", "*.mdx", ")", "-print"], { cwd, on, timeout: 15000 });
  if (r.code !== 0 && !r.stdout) throw new Error(r.stderr || "Cannot list this folder");
  return { root: cwd, files: r.stdout.split("\n").filter(Boolean).map(p => p.replace(/^\.\//, "")) };
}

// Tabs holding a markdown reader pane, by id, with their space.
function readerTabs() {
  const ids = new Set(panes().filter(p => p.mod === "markdown").map(p => p.tab));
  const out = new Map();
  for (const s of spaces()) for (const tab of s.tabs) if (ids.has(tab.id)) out.set(tab.id, { space: s, tab });
  return out;
}

export class List {
  init(_props, cx) {
    this.files = []; this.filter = "";
    this.opened = new Map(); // full path -> tab id
    this.pending = null;
    this.input = InputState.new({ placeholder: "Filter markdown files…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  refresh(cx) {
    let here = location();
    if (!here && this.key) here = JSON.parse(this.key);
    const { cwd, on } = here ?? {}, key = JSON.stringify({ cwd, on });
    if (key !== this.key) { this.key = key; this.cwd = cwd; this.on = on; this.root = null; this.files = []; this.error = null; }
    if (!cwd || this.loading) return;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const { root, files } = await listMarkdown(cwd, on);
        if (key !== this.key) return;
        this.limited = files.length > LIMIT;
        this.root = root; this.files = files.slice(0, LIMIT).sort((a, b) => a.localeCompare(b)); this.error = null;
      } catch (e) { if (key === this.key) this.error = String(e?.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  open(path) {
    const full = `${this.root}/${path}`;
    const found = readerTabs().get(this.opened.get(full));
    if (found) {
      run("space.select", { id: found.space.id });
      run("tab.select", { id: found.tab.id });
      return;
    }
    this.pending = { full, known: new Set(readerTabs().keys()) };
    run("tab.new", { name: path.slice(path.lastIndexOf("/") + 1), mod: "markdown", props: { file: full, on: this.on } });
  }

  // The tab a click just made: the first reader tab that wasn't there before.
  adopt() {
    if (!this.pending) return;
    for (const id of readerTabs().keys()) {
      if (this.pending.known.has(id)) continue;
      this.opened.set(this.pending.full, id);
      this.pending = null;
      return;
    }
  }

  rows(t) {
    const f = this.filter.toLowerCase(), live = readerTabs(), shown = focused()?.tab;
    return this.files.filter(p => !f || p.toLowerCase().includes(f)).map(path => {
      const slash = path.lastIndexOf("/"), name = path.slice(slash + 1), folder = slash < 0 ? "" : path.slice(0, slash);
      const tab = this.opened.get(`${this.root}/${path}`), open = live.has(tab);
      return h_flex().id(`md-${path}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(open && tab === shown, s => s.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click(() => this.open(path))
        .child(svg("mods/markdown/markdown.svg").size(14).flex_none().text_color(open ? t.accent : t.muted))
        .child(div().flex_none().max_w(200).truncate().child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(folder));
    });
  }

  render(cx) {
    const here = location();
    if (here && JSON.stringify(here) !== this.key) this.refresh(cx);
    this.adopt();
    const t = theme();
    return v_flex().id("markdown").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Markdown"))
        .child(div().id("md-root").flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim)
          .tooltip(this.root ? `Files in ${this.root}, where the last focused terminal is` : "Focus a terminal to list its markdown files")
          .child(this.root ? `in ${this.root.split(/[\\/]/).pop()}` : "")))
      .child(div().flex_none().px(8).pt(8).pb(4)
        .child(Input.new(this.input).h(30).px(10).rounded(8).border_1().border_color(t.border).bg(t.background).text_size(12).text_color(t.foreground)))
      .child(v_flex().id("md-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows(t))
        .when(Boolean(this.error) || !this.files.length, el => el.child(div().p(8).text_size(12).text_color(t.dim)
          .child(this.error || (this.loading ? "Finding markdown files…" : this.cwd ? "No markdown files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child(`Showing the first ${LIMIT} files`))));
  }
}
