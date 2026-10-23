/* Local check of the manual assistant against PDFs on disk — no Firebase needed.

   node scripts/local-test.mjs <folder-with-manual-pdfs> ["question" ...]

   Builds the same search index the function builds, runs a few searches, then:
   - with ANTHROPIC_API_KEY set, asks Claude each question for real (costs API credit);
   - without it, runs one scripted conversation to check the tool plumbing. */

import { readFile, readdir } from "node:fs/promises";
import { extractPages } from "../lib/extract.js";
import { describeManual } from "../lib/catalog.js";
import { ManualSearch } from "../lib/search.js";
import { answerQuestion } from "../lib/assistant.js";

const [dir, ...questions] = process.argv.slice(2);
if (!dir) { console.error("usage: node scripts/local-test.mjs <pdf-folder> [questions…]"); process.exit(1); }

const files = (await readdir(dir)).filter((f) => /\.pdf$/i.test(f));
const paths = new Map();
const manuals = [];
for (const f of files) {
  const info = describeManual(`manuals/${f}`);
  paths.set(info.path, `${dir}/${f}`);
  const pages = await extractPages(new Uint8Array(await readFile(`${dir}/${f}`)));
  manuals.push({ ...info, pageCount: pages.length, pages });
  console.log(`indexed ${info.id.padEnd(4)} ${f} (${pages.length} pages)`);
}
const search = new ManualSearch(manuals);
const loadBytes = (p) => readFile(paths.get(p));

for (const q of ["torque M16 8.8", "anchor nut torque", "-X34F"]) {
  const top = search.search(q, { limit: 3 }).map((h) => `${h.manual} p${h.page}`).join(", ");
  console.log(`search "${q}" → ${top}`);
}

if (process.env.ANTHROPIC_API_KEY) {
  for (const question of questions.length ? questions : ["What torque for the M16 bolts on the fixed EC brake?"]) {
    const t = Date.now();
    const r = await answerQuestion({ apiKey: process.env.ANTHROPIC_API_KEY, search, question, loadBytes });
    console.log(`\nQ: ${question}\n[${r.found}] ${r.answer}\nSPOKEN: ${r.spoken}`);
    console.log("CITES:", r.citations.map((c) => `${c.manual} p${c.page} (${c.what})`).join("; "));
    console.log(`turns ${r.turns}, ${((Date.now() - t) / 1000).toFixed(1)}s, tokens`, r.usage);
  }
} else {
  // Scripted stand-in for Claude: search → read → view a page → answer.
  const script = [
    [{ name: "search_manuals", input: { query: "fixed EC brake M16 bolt", manual: "PRT" } }],
    [{ name: "read_pages", input: { manual: "PRT", pages: [9] } }, { name: "view_page", input: { manual: "TS", page: 36 } }],
    [{ name: "give_answer", input: { found: "yes", answer: "170 Nm (test)", spoken: "170 newton metres.",
      citations: [{ manual: "PRT", page: 9, what: "drawing torque" }, { manual: "TS", page: 36, what: "table 1" }, { manual: "PRT", page: 9999, what: "bogus" }] } }],
  ];
  let step = 0;
  const seen = [];
  const client = { beta: { messages: { create: async (req) => {
    seen.push(structuredClone(req));
    const calls = script[step++].map((c, i) => ({ type: "tool_use", id: `t${step}_${i}`, ...c }));
    return { stop_reason: "tool_use", content: calls, usage: { input_tokens: 100, output_tokens: 10 } };
  } } } };
  const r = await answerQuestion({ search, question: "test", loadBytes, client });
  const last = seen[2].messages.at(-1).content;
  console.log("\nscripted run:", JSON.stringify({ found: r.found, answer: r.answer, citations: r.citations, turns: r.turns }));
  console.log("turn-2 search result starts:", seen[1].messages.at(-1).content[0].content.slice(0, 120));
  console.log("turn-3 user blocks:", last.map((b) => b.type + (b.type === "document" ? `(${Math.round(b.source.data.length / 1024)}KB b64)` : "")).join(", "));
  console.log("read_pages has torque row:", last[0].content.includes("3030164"));
  console.log("system prompt chars:", seen[0].system.length, "tools:", seen[0].tools.map((t) => t.name).join(","));
}
