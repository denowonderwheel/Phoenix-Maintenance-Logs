/* Phoenix Tracker v3 — Cloud Functions.

   askManual           Voice/typed question → answer from the manuals, with page citations.
   manualPage          A few pages of a manual as a small PDF, for signed-in users only.
   manualIndexStatus   Which manuals are indexed (admin panel).
   rebuildManualIndex  Admin: index new/changed manuals and lock their public download links.

   The Claude API key lives in Secret Manager as ANTHROPIC_API_KEY. */

import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { setGlobalOptions, logger } from "firebase-functions/v2";
import {
  requireStaff, requireAdmin, normalizeManualPath, downloadBytes,
  lockManualLinks, rebuildIndex, loadSearch, countQuestion,
} from "./lib/store.js";
import { answerQuestion, MODEL } from "./lib/assistant.js";
import { excerpt } from "./lib/pages.js";

initializeApp();
setGlobalOptions({ region: "us-central1" });

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const DAILY_QUESTIONS_PER_USER = 60;

export const askManual = onCall(
  { secrets: [ANTHROPIC_API_KEY], memory: "2GiB", timeoutSeconds: 300, concurrency: 8 },
  async (request) => {
    const profile = await requireStaff(request);
    const question = String((request.data && request.data.question) || "").trim();
    if (!question) throw new HttpsError("invalid-argument", "Ask a question.");
    if (question.length > 2000) throw new HttpsError("invalid-argument", "That question is too long.");
    const history = Array.isArray(request.data.history) ? request.data.history.slice(-6) : [];

    await countQuestion(profile.uid, DAILY_QUESTIONS_PER_USER);
    const search = await loadSearch();
    if (!search.manuals.length) {
      throw new HttpsError("failed-precondition", "The manuals haven't been indexed yet. An admin needs to run Rebuild manual index.");
    }

    const started = Date.now();
    let result;
    try {
      result = await answerQuestion({
        apiKey: ANTHROPIC_API_KEY.value(), search, question, history, loadBytes: downloadBytes,
      });
    } catch (e) {
      logger.error("askManual failed", e);
      throw new HttpsError("internal", "The manual assistant had a problem. Try again in a moment.");
    }
    const ms = Date.now() - started;

    // Keep a record of every question and answer so answers can be checked later.
    await getFirestore().collection("assistantLog").add({
      uid: profile.uid,
      name: profile.displayName || profile.email || "",
      question,
      answer: result.answer,
      found: result.found,
      citations: result.citations.map(({ manual, page, what }) => ({ manual, page, what })),
      model: MODEL,
      usage: result.usage,
      turns: result.turns,
      ms,
      at: FieldValue.serverTimestamp(),
    }).catch((e) => logger.warn("assistantLog write failed", e));

    return {
      found: result.found,
      answer: result.answer,
      spoken: result.spoken,
      citations: result.citations,
      ms,
    };
  },
);

export const manualPage = onCall(
  { memory: "2GiB", timeoutSeconds: 120, concurrency: 8 },
  async (request) => {
    await requireStaff(request);
    const path = normalizeManualPath(request.data && request.data.path);
    const page = Math.max(1, Number(request.data.page) || 1);
    const count = Math.min(10, Math.max(1, Number(request.data.count) || 4));
    try {
      const ex = await excerpt(path, page, count, downloadBytes);
      return { pdf: Buffer.from(ex.bytes).toString("base64"), first: ex.first, last: ex.last, total: ex.total };
    } catch (e) {
      if (e && e.code === 404) throw new HttpsError("not-found", "That manual isn't in storage.");
      logger.error("manualPage failed", path, e);
      throw new HttpsError("internal", "Couldn't open that manual page.");
    }
  },
);

export const manualIndexStatus = onCall({ memory: "1GiB" }, async (request) => {
  await requireStaff(request);
  const search = await loadSearch();
  return {
    manuals: search.manuals.map((m) => ({ id: m.id, title: m.title, file: m.file, pages: m.pageCount })),
  };
});

export const rebuildManualIndex = onCall(
  { memory: "4GiB", cpu: 2, timeoutSeconds: 1800 },
  async (request) => {
    await requireAdmin(request);
    const force = !!(request.data && request.data.force);
    const locked = await lockManualLinks();
    const manuals = await rebuildIndex({ force, log: (m) => logger.info(m) });
    return { locked, manuals };
  },
);
