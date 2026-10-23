/* PDF → per-page text, using pdf.js. Lines are rebuilt from text positions so
   parts tables stay on one row ("5  6  Bolt M16x50 8.8 ... 3030164"). */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Pages with fewer words than this are mostly drawing/picture — flagged so the
// assistant knows to look at the page image before quoting numbers.
const IMAGE_HEAVY_WORDS = 40;

// Drawings often print title blocks and parts tables rotated 90°. Each run of
// text is grouped by its writing direction and rebuilt in that direction's own
// coordinates, so a sideways table still comes out one row per line.
function pageItemsToText(items) {
  const groups = new Map();
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, c, d] = it.transform;
    const angle = Math.round(Math.atan2(b, a) / (Math.PI / 2)) * 90;  // 0, 90, 180, -90
    if (!groups.has(angle)) groups.set(angle, []);
    groups.get(angle).push(it);
  }
  // Main reading direction first (most text), then the rest.
  return [...groups.entries()]
    .sort((g1, g2) => g2[1].length - g1[1].length)
    .map(([angle, list]) => rowsToText(list, angle))
    .filter(Boolean)
    .join("\n");
}

function rowsToText(items, angle) {
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const rows = [];
  for (const it of items) {
    const [, , c, d, e, f] = it.transform;
    // Rotate into the text's own frame: x runs along the line, y across lines.
    const x = e * cos + f * sin;
    const y = -e * sin + f * cos;
    const h = Math.hypot(c, d) || it.height || 8;
    let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(2, h * 0.4));
    if (!row) { row = { y, h, parts: [] }; rows.push(row); }
    row.parts.push({ x, w: it.width || 0, s: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.parts.sort((a, b) => a.x - b.x);
    let line = "";
    let end = null;
    for (const p of r.parts) {
      if (end !== null) {
        const gap = p.x - end;
        line += gap > r.h * 1.5 ? "   " : (gap > r.h * 0.15 ? " " : "");
      }
      line += p.s;
      end = p.x + p.w;
    }
    return line.replace(/\s+$/, "");
  }).filter(Boolean).join("\n");
}

/** Extract text from a PDF (Uint8Array). Returns [{ p, text, words, imageHeavy, heading }]. */
export async function extractPages(data, { onProgress } = {}) {
  const task = getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  });
  const pdf = await task.promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const tc = await page.getTextContent();
    const text = pageItemsToText(tc.items);
    const words = (text.match(/\S+/g) || []).length;
    pages.push({
      p: n,
      text,
      words,
      imageHeavy: words < IMAGE_HEAVY_WORDS ||
        (/\bTable \d+:/.test(text) && !/\d{2,}\s+\d{2,}\s+\d{2,}/.test(text)),
      heading: findHeading(text),
    });
    page.cleanup();
    if (onProgress && n % 50 === 0) onProgress(n, pdf.numPages);
  }
  await task.destroy();
  return pages;
}

/** Best-effort section heading for a page, e.g. "4.10 Fixed EC brakes" or "TS-G01". */
function findHeading(text) {
  const lines = text.split("\n").slice(0, 12);
  for (const l of lines) {
    const m = l.trim().match(/^(\d{1,2}(?:\.\d{1,2}){1,3})\s+([A-Z][^.]{2,70})$/);
    if (m) return `${m[1]} ${m[2].trim()}`;
  }
  const ts = text.match(/TS No\.?:?\s*(TS-[A-Z]\d{2})/);
  if (ts) return ts[1];
  return "";
}
