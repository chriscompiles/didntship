const path = require("node:path");
const fs = require("node:fs");
const opentype = require("opentype.js");
const { renderAsync } = require("@resvg/resvg-js");

const FONT_DIR = path.join(__dirname, "fonts");
function loadFont(filename) {
  const bytes = fs.readFileSync(path.join(FONT_DIR, filename));
  return opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
const fonts = [loadFont("DejaVuSerif.ttf"), loadFont("DejaVuSans.ttf"), loadFont("NotoEmoji.ttf")];
const FONT_FILES = ["DejaVuSerif.ttf", "DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "NotoEmoji.ttf"].map((file) => path.join(FONT_DIR, file));
const WIDTH = 1200;
const HEIGHT = 630;

function xml(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const segments = new Intl.Segmenter("en", { granularity: "grapheme" });
const isEmoji = (value) => /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(value);
function textWidth(text, size) {
  // Use cmap/advance metrics directly; no shaping substitutions are needed for line fitting.
  let width = 0;
  let previous;
  let previousFont;
  for (const { segment } of segments.segment(text)) {
    if (isEmoji(segment)) {
      // Joined emoji and flags form one monospaced glyph in Noto Emoji.
      width += Math.max(...Array.from(segment, (character) => fonts[2].charToGlyph(character).advanceWidth || 0)) * size / fonts[2].unitsPerEm;
      previous = null;
      continue;
    }
    for (const character of segment) {
      if (/[\u200D\uFE0E\uFE0F]/u.test(character)) continue;
      const font = fonts.find((font) => font.charToGlyphIndex(character)) || fonts[0];
      const glyph = font.charToGlyph(character);
      width += (glyph.advanceWidth ?? font.unitsPerEm) * size / font.unitsPerEm;
      if (previous && font === previousFont) width += font.getKerningValue(previous, glyph) * size / font.unitsPerEm;
      previous = glyph;
      previousFont = font;
    }
  }
  return width;
}

function svgLine(line, size, y) {
  let x = 100;
  let plain = "";
  const runs = [];
  function flush() {
    if (!plain) return;
    runs.push(`<text x="${x}" y="${y}" font-family="DejaVu Serif" font-size="${size}" fill="#171713">${xml(plain)}</text>`);
    x += textWidth(plain, size);
    plain = "";
  }
  for (const { segment } of segments.segment(line)) {
    if (!isEmoji(segment)) { plain += segment; continue; }
    flush();
    runs.push(`<text x="${x}" y="${y}" font-family="Noto Emoji" font-size="${size}" fill="#171713">${xml(segment)}</text>`);
    x += textWidth(segment, size);
  }
  flush();
  return runs.join("");
}
function wrapText(text, size, maxWidth) {
  const lines = [];
  let line = "";
  const fits = (value) => textWidth(value, size) <= maxWidth;
  for (const word of String(text).trim().split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) { line = candidate; continue; }
    if (line) { lines.push(line); line = ""; }
    for (const { segment } of segments.segment(word)) {
      if (line && !fits(line + segment)) { lines.push(line); line = ""; }
      line += segment;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function layoutText(body) {
  // Measure the bundled font, so long words and 140 wide characters stay inside the card.
  for (let size = 68; size >= 28; size -= 2) {
    const lines = wrapText(body, size, 1000);
    if (lines.length * size * 1.24 <= 290) return { size, lines };
  }
  return { size: 28, lines: wrapText(body, 28, 1000) };
}

function cardSvg(row) {
  const isHome = !row;
  const body = isHome ? "Your side project made $0. At least make it famous." : row.body;
  const { size, lines } = layoutText(body);
  const firstBaseline = 195 + (290 - lines.length * size * 1.24) / 2 + size;
  const author = isHome ? "A $1 confession. A little closure." : row.handle ? `@${row.handle}` : "Anonymous builder";
  const label = isHome ? "THE HOME OF UNFINISHED SIDE PROJECTS" : row.is_demo ? "EXAMPLE CONFESSION" : `CONFESSION #${String(row.id).padStart(4, "0")}`;
  // No user-provided markup, images or URLs are passed to the renderer.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <rect width="1200" height="630" fill="#f2eddf"/>
    <rect x="22" y="22" width="1156" height="586" fill="none" stroke="#171713" stroke-width="2"/>
    <rect x="22" y="22" width="8" height="586" fill="#c93622"/>
    <text x="72" y="86" font-family="DejaVu Sans" font-size="18" font-weight="bold" letter-spacing="2" fill="#c93622">${xml(label)}</text>
    <text x="1126" y="86" text-anchor="end" font-family="DejaVu Sans" font-size="16" fill="#625f56">DIDN’T SHIP.</text>
    <line x1="72" y1="115" x2="1128" y2="115" stroke="#171713" stroke-width="1"/>
    <text x="64" y="203" font-family="DejaVu Serif" font-size="86" fill="#c93622">“</text>
    ${lines.map((line, index) => svgLine(line, size, firstBaseline + index * size * 1.24)).join("")}
    <line x1="72" y1="515" x2="1128" y2="515" stroke="#171713" stroke-width="1"/>
    <text x="72" y="558" font-family="DejaVu Sans" font-size="20" fill="#171713">${xml(author)}</text>
    <text x="72" y="585" font-family="DejaVu Sans" font-size="12" letter-spacing="1.2" fill="#625f56">AT LEAST IT’S FAMOUS NOW.</text>
    <text x="1128" y="568" text-anchor="end" font-family="DejaVu Sans" font-weight="bold" font-size="32" letter-spacing="-1.4" fill="#171713">didntship<tspan fill="#c93622">.lol</tspan></text>
  </svg>`;
}

// Bound both completed and in-flight renders; never cache a database visibility decision.
const cache = new Map();
let active = 0;
async function cardPng(row) {
  const svg = cardSvg(row);
  if (cache.has(svg)) return cache.get(svg);
  if (active >= 4) {
    const error = new Error("Card renderer is busy");
    error.status = 503;
    throw error;
  }
  active++;
  const rendering = renderAsync(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "DejaVu Sans" } })
    .then((rendered) => rendered.asPng());
  if (cache.size >= 100) cache.delete(cache.keys().next().value);
  cache.set(svg, rendering);
  try { return await rendering; }
  catch (error) { cache.delete(svg); throw error; }
  finally { active--; }
}

module.exports = { cardPng, cardSvg, layoutText, wrapText, textWidth, WIDTH, HEIGHT };
