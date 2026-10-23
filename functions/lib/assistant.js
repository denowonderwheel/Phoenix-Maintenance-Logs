/* The manual assistant: Claude answers maintenance questions using only the
   Phoenix manuals, through four tools — search, read pages, look at a page,
   and give the final answer with page citations. */

import Anthropic from "@anthropic-ai/sdk";
import { excerpt } from "./pages.js";

export const MODEL = "claude-opus-5-5";
const EFFORT = "medium";
const MAX_TURNS = 10;          // tool round-trips per question
const MAX_PAGE_VIEWS = 4;      // page images per question (each is a few thousand tokens)
const MAX_READ_CHARS = 9000;   // per page returned by read_pages
// Page images are re-sent on every later turn of the question, so cap their
// total size well under the API's 32 MB request limit.
const MAX_VIEW_BYTES = 12 * 1024 * 1024;

function systemPrompt(search) {
  const list = search.manuals.map((m) =>
    `- ${m.id}: ${m.title}, ${m.pageCount} pages. ${m.covers}`).join("\n");
  return `You are the manual assistant for the maintenance crew of the Phoenix, a Vekoma Suspended Family Coaster (IB 45032) at Deno's Wonder Wheel Amusement Park, Coney Island. Mechanics ask you questions by voice while working on the ride, usually from a phone, often outdoors and in a hurry.

You answer only from the ride's manuals, which you reach through your tools:
${list}

How to find answers:
- Search first; never answer from general knowledge about coasters, bolts or equipment. A value you have not read on a page in this session must not appear in your answer.
- Page numbers in tools are PDF page numbers (1 = first page of the file). Printed page numbers in the text can differ; always cite the PDF page.
- The manuals point at each other; follow those references to the actual value. In particular:
  - Torque: a value on the assembly drawing (Parts List) applies first. If the drawing gives none, Vekoma TS-G01 (in TS) says to use its standard tables 1-4 by bolt grade (8.8, 10.9, stainless, HV), material and lubrication. Use the "lubricated" column when the bolts are secured with Loctite or are geomet coated, as the table footnotes say. The OMM's own torque section (7.5) only gives anchor nut torques.
  - Wear and rejection limits: OMM 7.3 says critical rejection dimensions are on the Parts List drawings.
  - Part numbers: mechanical parts are in the Parts List tables (PART NR column, 7 digits); electrical parts are in the Diagrams component lists (catalogue numbers by device tag such as -X34F); bought-in equipment is in the OEM documentation.
- Search results and read_pages mark pages that are mostly a picture (imageHeavy). The TS-G01 torque tables, drawings and diagrams are like this. Before you state a number from such a page, call view_page and read it from the image. Read table rows and columns carefully; say which row and column you used.
- When the question is ambiguous (which brake, which bolt, which train part), give the answer for the most likely case and name the alternatives briefly, or ask one short question back if guessing could mislead.

Safety rules:
- If the manuals don't clearly answer the question, say so plainly and point to the closest relevant pages. Never fill a gap with a typical or estimated value.
- For torque, give newton-metres as written. You may add foot-pounds converted with the manual's factor 0.737; say it is converted.
- For work on live electrical equipment, point to the diagram pages and say the work must be done by a qualified electrician with lockout/tagout. Do not walk anyone through live electrical work.
- The manuals are the authority. Never contradict them, and never suggest skipping a step they require.

When you have the answer, call give_answer exactly once:
- answer: what the mechanic reads on screen. Lead with the value or the direct answer, then the details that matter (conditions, steps, related values). Short paragraphs or a few lines; plain text, no markdown headings.
- spoken: what is read aloud. One to three short sentences with the key value, written for speech: units in words ("170 newton metres"), part numbers in digit groups ("part number 303 01 64"), and the manual and section ("parts list, fixed EC brake drawing").
- citations: every page you took a value from.`;
}

function tools(search) {
  const ids = search.manuals.map((m) => m.id);
  return [
    {
      name: "search_manuals",
      description: "Keyword search across the manuals. Returns the best-matching pages with a short snippet, " +
        "the section heading if known, and whether the page is mostly a picture. Use specific words that would " +
        "appear on the page: part names, bolt sizes (M16), drawing or part numbers, device tags (-X34F), " +
        "section numbers (4.10.3), TS numbers (TS-G01). Search again with different words if the first results miss.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search words." },
          manual: { type: "string", enum: ["ANY", ...ids], description: "Limit to one manual, or ANY." },
        },
        required: ["query", "manual"],
        additionalProperties: false,
      },
    },
    {
      name: "read_pages",
      description: "Full extracted text of up to 4 pages of one manual. Text from tables keeps one row per line. " +
        "Pages marked imageHeavy may have important content only in the picture; use view_page for those.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          manual: { type: "string", enum: ids },
          pages: { type: "array", items: { type: "integer" }, description: "PDF page numbers, at most 4." },
        },
        required: ["manual", "pages"],
        additionalProperties: false,
      },
    },
    {
      name: "view_page",
      description: `Look at one page as an image (attached after the tool result). Use for drawings, diagrams and ` +
        `picture-only tables such as the TS-G01 torque tables. Limited to ${MAX_PAGE_VIEWS} pages per question.`,
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          manual: { type: "string", enum: ids },
          page: { type: "integer", description: "PDF page number." },
        },
        required: ["manual", "page"],
        additionalProperties: false,
      },
    },
    {
      name: "give_answer",
      description: "Deliver the final answer to the mechanic. Call once, at the end.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          found: { type: "string", enum: ["yes", "partly", "no"], description: "Did the manuals answer the question?" },
          answer: { type: "string" },
          spoken: { type: "string" },
          citations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                manual: { type: "string", enum: ids },
                page: { type: "integer" },
                what: { type: "string", description: "What this page provided, a few words." },
              },
              required: ["manual", "page", "what"],
              additionalProperties: false,
            },
          },
        },
        required: ["found", "answer", "spoken", "citations"],
        additionalProperties: false,
      },
    },
  ];
}

/**
 * Answer one question. history: [{ q, a }] of earlier turns in this chat.
 * Returns { found, answer, spoken, citations: [{ manual, title, path, page, what }], usage, turns }.
 */
export async function answerQuestion({ apiKey, search, question, history = [], loadBytes, client }) {
  client = client || new Anthropic({ apiKey });
  const messages = [];
  for (const h of history.slice(-6)) {
    if (!h || !h.q || !h.a) continue;
    messages.push({ role: "user", content: String(h.q).slice(0, 2000) });
    messages.push({ role: "assistant", content: String(h.a).slice(0, 4000) });
  }
  messages.push({ role: "user", content: String(question).slice(0, 2000) });

  const system = systemPrompt(search);
  const toolDefs = tools(search);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let views = 0;
  let viewBytes = 0;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: EFFORT },
      cache_control: { type: "ephemeral" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      tools: toolDefs,
      messages,
    });
    usage.input += response.usage.input_tokens || 0;
    usage.output += response.usage.output_tokens || 0;
    usage.cacheRead += response.usage.cache_read_input_tokens || 0;
    usage.cacheWrite += response.usage.cache_creation_input_tokens || 0;

    if (response.stop_reason === "refusal") {
      return declined("I can't answer that one. Please check the manual directly.", usage, turn);
    }
    messages.push({ role: "assistant", content: response.content });

    const calls = response.content.filter((b) => b.type === "tool_use");
    const final = calls.find((c) => c.name === "give_answer");
    if (final) return finish(final.input, search, usage, turn);

    if (!calls.length) {
      if (response.stop_reason === "pause_turn") continue;
      // Answered in plain text instead of give_answer — still usable.
      const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (text) return finish({ found: "partly", answer: text, spoken: text.split(/(?<=\.)\s/)[0], citations: [] }, search, usage, turn);
      if (response.stop_reason === "max_tokens") break;
      continue;
    }

    const results = [];
    const attachments = [];
    for (const call of calls) {
      try {
        const out = await runTool(call, search, loadBytes, (bytes) => {
          if (views >= MAX_PAGE_VIEWS || viewBytes + bytes > MAX_VIEW_BYTES) return false;
          views++;
          viewBytes += bytes;
          return true;
        });
        results.push({ type: "tool_result", tool_use_id: call.id, content: out.text });
        if (out.pdf) {
          attachments.push({ type: "text", text: `Page image for ${call.input.manual} PDF page ${out.page}:` });
          attachments.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: out.pdf } });
        }
      } catch (e) {
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: String(e.message || e) });
      }
    }
    messages.push({ role: "user", content: [...results, ...attachments] });
  }
  return declined("I couldn't pin that down in the manuals. Try asking more specifically, for example naming the part or section.", usage, MAX_TURNS);
}

async function runTool(call, search, loadBytes, takeView) {
  const input = call.input || {};
  if (call.name === "search_manuals") {
    const hits = search.search(input.query, { manual: input.manual === "ANY" ? null : input.manual, limit: 8 });
    if (!hits.length) return { text: "No matching pages. Try other words." };
    return { text: JSON.stringify(hits) };
  }
  if (call.name === "read_pages") {
    const pages = (input.pages || []).slice(0, 4);
    const parts = pages.map((p) => {
      const hit = search.getPage(input.manual, p);
      if (!hit) return `--- ${input.manual} page ${p}: no such page`;
      const flag = hit.page.imageHeavy ? " [imageHeavy: mostly picture, use view_page for values]" : "";
      return `--- ${input.manual} PDF page ${p}${hit.page.heading ? ` (${hit.page.heading})` : ""}${flag}\n` +
        hit.page.text.slice(0, MAX_READ_CHARS);
    });
    return { text: parts.join("\n\n") };
  }
  if (call.name === "view_page") {
    const hit = search.getPage(input.manual, input.page);
    if (!hit) throw new Error(`${input.manual} has no page ${input.page}.`);
    const ex = await excerpt(hit.man.path, input.page, 1, loadBytes);
    if (!takeView(ex.bytes.length)) {
      throw new Error(`Page view limit reached for this question (${MAX_PAGE_VIEWS} pages / ${MAX_VIEW_BYTES / 1048576} MB). Use read_pages.`);
    }
    return { text: `Attached ${input.manual} PDF page ${input.page}.`, pdf: Buffer.from(ex.bytes).toString("base64"), page: input.page };
  }
  throw new Error(`Unknown tool ${call.name}`);
}

function finish(input, search, usage, turns) {
  const citations = [];
  const seen = new Set();
  for (const c of input.citations || []) {
    const hit = search.getPage(c.manual, c.page);
    const key = `${c.manual}:${c.page}`;
    if (!hit || seen.has(key)) continue;
    seen.add(key);
    citations.push({ manual: hit.man.id, title: hit.man.short, path: hit.man.path, page: c.page, what: c.what || "" });
  }
  return {
    found: input.found || "partly",
    answer: String(input.answer || "").trim(),
    spoken: String(input.spoken || input.answer || "").trim(),
    citations,
    usage,
    turns,
  };
}

function declined(message, usage, turns) {
  return { found: "no", answer: message, spoken: message, citations: [], usage, turns };
}
