/* Cut a few pages out of a manual PDF. Used for the in-app page viewer (so a
   phone downloads a small excerpt instead of a 70 MB manual) and for showing
   Claude a drawing or picture-only table as an actual page. */

import { PDFDocument } from "pdf-lib";

const MAX_EXCERPT_BYTES = 6 * 1024 * 1024;

// Parsed PDFs are kept per warm instance; the manuals are large and parsing
// costs seconds. Only the two most recently used stay in memory.
const cache = new Map();

async function loadPdf(path, loadBytes) {
  if (cache.has(path)) {
    const hit = cache.get(path);
    cache.delete(path);
    cache.set(path, hit);
    return hit;
  }
  const bytes = await loadBytes(path);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  cache.set(path, doc);
  while (cache.size > 2) cache.delete(cache.keys().next().value);
  return doc;
}

/**
 * Returns { bytes, first, last, total } — a PDF holding pages first..last
 * (1-based) of the manual at `path`. Shrinks the range if the excerpt would be
 * too large to send.
 */
export async function excerpt(path, page, count, loadBytes) {
  const src = await loadPdf(path, loadBytes);
  const total = src.getPageCount();
  const first = Math.min(Math.max(1, Math.floor(page)), total);
  let last = Math.min(total, first + Math.max(1, Math.floor(count)) - 1);
  for (;;) {
    const out = await PDFDocument.create();
    const idx = [];
    for (let i = first; i <= last; i++) idx.push(i - 1);
    const copied = await out.copyPages(src, idx);
    copied.forEach((pg) => out.addPage(pg));
    const bytes = await out.save({ useObjectStreams: true });
    if (bytes.length <= MAX_EXCERPT_BYTES || last === first) {
      return { bytes, first, last, total };
    }
    last = first + Math.max(0, Math.floor((last - first) / 2));
  }
}
