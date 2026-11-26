// Mermaid -> SVG for the markdown mod.
//   node render.mjs <in.mmd | -> <out.svg> <colors json> [source, when the input is -]
// Prints {"w":…,"h":…} on success; an error on stderr and exit 1 otherwise.
// beautiful-mermaid colors through CSS variables and color-mix(), which Herdr's SVG renderer
// can't read, so every color is resolved here and written as a plain value.
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { execFileSync } from "child_process";

// SVG renderers without CSS support read only the attribute.
const FONTS = "Helvetica Neue, Helvetica, Arial, sans-serif";
import { renderMermaidSVG } from "beautiful-mermaid";

const [inPath, outPath, colorsJson, source] = process.argv.slice(2);
const colors = JSON.parse(colorsJson || "{}");

const hex = (c) => {
  let s = c.trim().replace("#", "");
  if (s.length === 3) s = [...s].map((x) => x + x).join("");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const toHex = (rgb) => "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

// Splits "a, b(c, d), e" at top-level commas.
function args(s) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function resolve(expr, vars, seen = 0) {
  expr = expr.trim();
  if (seen > 20) return expr;
  let m = expr.match(/^var\((.*)\)$/s);
  if (m) {
    const [name, ...fallback] = args(m[1]);
    if (vars[name] != null) return resolve(vars[name], vars, seen + 1);
    return fallback.length ? resolve(fallback.join(","), vars, seen + 1) : "none";
  }
  m = expr.match(/^color-mix\(in srgb,(.*)\)$/s);
  if (m) {
    const [a, b] = args(m[1]);
    const pa = a.match(/^(.*?)\s+([\d.]+)%$/), pb = b.match(/^(.*?)\s+([\d.]+)%$/);
    const ca = resolve(pa ? pa[1] : a, vars, seen + 1), cb = resolve(pb ? pb[1] : b, vars, seen + 1);
    const wa = pa ? Number(pa[2]) / 100 : pb ? 1 - Number(pb[2]) / 100 : 0.5;
    if (!ca.startsWith("#") || !cb.startsWith("#")) return ca;
    const x = hex(ca), y = hex(cb);
    return toHex(x.map((v, i) => v * wa + y[i] * (1 - wa)));
  }
  return expr;
}

// Arrowhead markers as plain shapes at the line ends: rasterizers like sips drop <marker>.
function inlineMarkers(svg) {
  const markers = {};
  for (const [, id, body] of svg.matchAll(/<marker id="([^"]+)"[^>]*>([\s\S]*?)<\/marker>/g)) {
    const fill = body.match(/fill="([^"]+)"/)?.[1] ?? "none", stroke = body.match(/stroke="([^"]+)"/)?.[1] ?? fill;
    markers[id] = { fill, stroke, open: fill === "none" || /<polyline/.test(body) };
  }
  const head = (tip, from, m) => {
    const dx = tip[0] - from[0], dy = tip[1] - from[1], len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, L = 8, W = 3;
    const bx = tip[0] - ux * L, by = tip[1] - uy * L;
    const a = [bx - uy * W, by + ux * W], b = [bx + uy * W, by - ux * W];
    const pts = [a, tip, b].map((p) => p.map((v) => v.toFixed(2)).join(",")).join(" ");
    return m.open
      ? `<polyline points="${pts}" fill="none" stroke="${m.stroke}" stroke-width="1" stroke-linejoin="round"/>`
      : `<polygon points="${pts}" fill="${m.fill}" stroke="${m.stroke}" stroke-width="0.75" stroke-linejoin="round"/>`;
  };
  return svg.replace(/<(polyline|line)\b([^>]*?)\/?>/g, (all, tag, attrs) => {
    const end = attrs.match(/marker-end="url\(#([^)]+)\)"/)?.[1], start = attrs.match(/marker-start="url\(#([^)]+)\)"/)?.[1];
    if (!end && !start) return all;
    const pts = tag === "line"
      ? [["x1", "y1"], ["x2", "y2"]].map(([x, y]) => [Number(attrs.match(new RegExp(`\\s${x}="([-\\d.]+)"`))?.[1]), Number(attrs.match(new RegExp(`\\s${y}="([-\\d.]+)"`))?.[1])])
      : (attrs.match(/points="([^"]+)"/)?.[1] ?? "").trim().split(/\s+/).map((p) => p.split(",").map(Number));
    if (pts.length < 2 || pts.some((p) => p.some(Number.isNaN))) return all;
    let extra = "";
    if (end && markers[end]) extra += head(pts.at(-1), pts.at(-2), markers[end]);
    if (start && markers[start]) extra += head(pts[0], pts[1], markers[start]);
    return `<${tag}${attrs.replace(/\s*marker-(end|start)="[^"]*"/g, "")}/>${extra}`;
  });
}

// Subgraphs: the whole box in a muted tint (stronger per nesting level), rounded, with the
// label on that tint instead of a separate header strip.
function tintGroups(svg, fg, bg) {
  const mix = (p) => resolve(`color-mix(in srgb, ${fg} ${p}%, ${bg})`, {});
  const stack = [];
  return svg.replace(/<g\b[^>]*>|<\/g>|<rect\b[^>]*\/>/g, (tag) => {
    if (tag === "</g>") { stack.pop(); return tag; }
    if (tag.startsWith("<g")) { stack.push(/class="subgraph"/.test(tag) ? { rects: 0 } : null); return tag; }
    const group = stack.at(-1);
    if (!group) return tag;
    const depth = stack.filter(Boolean).length;
    group.rects++;
    if (group.rects === 1)
      return tag.replace(/fill="[^"]*"/, `fill="${mix(3 + depth * 3)}"`).replace(/stroke="[^"]*"/, `stroke="${mix(8 + depth * 4)}"`).replace(/rx="[^"]*"\s*ry="[^"]*"/, 'rx="8" ry="8"');
    if (group.rects === 2) return tag.replace(/fill="[^"]*"/, 'fill="none"').replace(/stroke="[^"]*"/, 'stroke="none"');
    return tag;
  });
}

// Nodes a clear step above the group tints.
if (colors.fg?.startsWith("#") && colors.bg?.startsWith("#")) {
  const mix = (p) => resolve(`color-mix(in srgb, ${colors.fg.slice(0, 7)} ${p}%, ${colors.bg.slice(0, 7)})`, {});
  colors.surface = mix(13);
  colors.border = mix(26);
}

try {
  let svg = renderMermaidSVG(inPath === "-" ? source : readFileSync(inPath, "utf8"), { ...colors, font: "Helvetica", transparent: true });
  const vars = {};
  for (const [, k, v] of svg.matchAll(/(--[\w-]+)\s*:\s*([^;"]+?)\s*(?=;|"|\n)/g)) vars[k] = v;
  svg = svg
    .replace(/@import[^;]*;/g, "")
    .replace(/\bsvg\s*\{[^}]*\}/g, "")
    .replace(/\sstyle="--[^"]*"/, "")
    .replace(/var\((--[\w-]+)(?:,[^)]*\))?\)/g, (all) => resolve(all, vars))
    .replace(/color-mix\(in srgb,[^;"]*?\)\)?/g, (all) => resolve(all, vars))
    .replace(/font-family:[^;}]*/g, `font-family: ${FONTS}`)
    .replace(/font-family="[^"]*"/g, `font-family="${FONTS}"`);
  svg = inlineMarkers(svg.replace(/<text /g, `<text font-family="${FONTS}" `));
  if (colors.fg?.startsWith("#") && colors.bg?.startsWith("#")) svg = tintGroups(svg, colors.fg.slice(0, 7), colors.bg.slice(0, 7));
  writeFileSync(outPath, svg);
  const w = Number(svg.match(/<svg[^>]*\swidth="([\d.]+)"/)?.[1]), h = Number(svg.match(/<svg[^>]*\sheight="([\d.]+)"/)?.[1]);
  // On macOS, a 2x PNG through sips, which draws text in the system's fonts (Herdr's SVG
  // renderer falls back to a serif).
  let png = false;
  if (process.platform === "darwin" && w && h) {
    const big = outPath.replace(/\.svg$/, ".2x.svg"), pngPath = outPath.replace(/\.svg$/, ".png");
    writeFileSync(big, svg.replace(/(<svg[^>]*\s)width="[\d.]+"/, `$1width="${w * 2}"`).replace(/(<svg[^>]*\s)height="[\d.]+"/, `$1height="${h * 2}"`));
    try { execFileSync("sips", ["-s", "format", "png", big, "--out", pngPath], { stdio: "ignore" }); png = true; } catch {}
    try { unlinkSync(big); } catch {}
  }
  console.log(JSON.stringify({ w, h, png }));
} catch (e) {
  console.error(String(e?.message ?? e).split("\n")[0]);
  process.exit(1);
}
