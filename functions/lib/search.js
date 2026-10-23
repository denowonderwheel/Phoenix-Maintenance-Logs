/* Keyword search (BM25) over manual pages. Tokens keep part numbers, device
   tags, bolt sizes and section numbers intact ("20000-07-0703", "-55q1",
   "m16x50", "4.10.3", "ts-g01") and also index their pieces, so "M16" finds
   "M16x50" and "0703" finds the full drawing number. */

const STOP = new Set(("a an and are as at be by for from has have how i if in into is it its of on or " +
  "that the their there these this to was were what when where which who will with you your do does " +
  "need needed should can").split(" "));

const K1 = 1.2;
const B = 0.75;

export function tokenize(text) {
  const out = [];
  const lower = String(text).toLowerCase().replace(/m\s+(\d{1,2})\b/g, "m$1");  // "M 30" → "m30"
  const re = /-?[a-z0-9]+(?:[-./×x][a-z0-9]+)*/g;
  let m;
  while ((m = re.exec(lower))) {
    let tok = m[0];
    const tag = tok.startsWith("-") && /\d/.test(tok) && /[a-z]/.test(tok);  // device tag like -55Q1
    if (!tag) tok = tok.replace(/^-/, "");
    tok = tok.replace(/[.]$/, "");
    if (!tok || STOP.has(tok)) continue;
    out.push(tok);
    if (/[-./×]/.test(tok.slice(1)) || (/\d/.test(tok) && /x/.test(tok))) {
      for (const piece of tok.split(/[-./×]|(?<=\d)x(?=\d)|(?<=m\d{1,2})x/)) {
        if (piece && piece !== tok && !STOP.has(piece) && piece.length > 1) out.push(piece);
      }
    }
    if (tag) out.push(tok.slice(1));
  }
  return out;
}

export class ManualSearch {
  /** manuals: [{ id, title, short, path, pages: [{ p, text, imageHeavy, heading }] }] */
  constructor(manuals) {
    this.manuals = manuals;
    this.docs = [];
    this.df = new Map();
    let total = 0;
    for (const man of manuals) {
      for (const page of man.pages) {
        const toks = tokenize(page.text + "\n" + (page.heading || ""));
        const tf = new Map();
        for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
        for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
        const toc = (page.text.match(/\.{8,}/g) || []).length >= 5;
        this.docs.push({ man, page, tf, len: toks.length, toc });
        total += toks.length;
      }
    }
    this.avgLen = total / Math.max(1, this.docs.length);
    this.N = this.docs.length;
  }

  idf(t) {
    const n = this.df.get(t) || 0;
    return Math.log(1 + (this.N - n + 0.5) / (n + 0.5));
  }

  /** Returns top hits: [{ manual, page, score, snippet, imageHeavy, heading }] */
  search(query, { manual, limit = 8 } = {}) {
    const qToks = [...new Set(tokenize(query))];
    if (!qToks.length) return [];
    const want = manual ? String(manual).toUpperCase() : null;
    const scored = [];
    for (const d of this.docs) {
      if (want && d.man.id !== want) continue;
      let score = 0;
      let matched = 0;
      for (const t of qToks) {
        const f = d.tf.get(t);
        if (!f) continue;
        matched++;
        score += this.idf(t) * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / this.avgLen));
      }
      if (!score) continue;
      score *= 1 + 0.5 * (matched / qToks.length);  // prefer pages matching more of the question
      if (d.page.heading && qToks.some((t) => d.page.heading.toLowerCase().includes(t))) score *= 1.15;
      if (d.toc) score *= 0.4;  // contents pages match everything; real pages first
      scored.push({ d, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ d, score }) => ({
      manual: d.man.id,
      page: d.page.p,
      score: Math.round(score * 100) / 100,
      heading: d.page.heading || "",
      imageHeavy: !!d.page.imageHeavy,
      snippet: snippet(d.page.text, qToks),
    }));
  }

  getPage(manualId, p) {
    const man = this.manuals.find((m) => m.id === String(manualId).toUpperCase());
    if (!man) return null;
    const page = man.pages[p - 1];
    return page ? { man, page } : null;
  }
}

/** A few lines around the best-matching lines of a page. */
function snippet(text, qToks, maxChars = 700) {
  const lines = text.split("\n");
  const scores = lines.map((l) => {
    const lt = new Set(tokenize(l));
    return qToks.reduce((s, t) => s + (lt.has(t) ? 1 : 0), 0);
  });
  const order = scores.map((s, i) => [s, i]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]);
  const keep = new Set();
  for (const [, i] of order.slice(0, 4)) {
    for (let k = Math.max(0, i - 1); k <= Math.min(lines.length - 1, i + 1); k++) keep.add(k);
  }
  if (!keep.size) for (let k = 0; k < Math.min(6, lines.length); k++) keep.add(k);
  let out = "";
  let prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    out += (i !== prev + 1 && out ? "\n…\n" : (out ? "\n" : "")) + lines[i];
    prev = i;
    if (out.length > maxChars) break;
  }
  return out.slice(0, maxChars);
}
