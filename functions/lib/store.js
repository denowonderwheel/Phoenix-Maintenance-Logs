/* Storage + Firestore helpers shared by the functions: who may call them,
   where the manuals and their search index live, and the download-link lock. */

import { getStorage } from "firebase-admin/storage";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { extractPages } from "./extract.js";
import { describeManual } from "./catalog.js";
import { ManualSearch } from "./search.js";

export const MANUALS_PREFIX = "manuals/";
const INDEX_PREFIX = "manual-index/";
const INDEX_FORMAT = 1;

const bucket = () => getStorage().bucket();

/** Signed-in, active tracker user (admin / supervisor / mechanic). Returns the profile. */
export async function requireStaff(request) {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to use the manuals.");
  const snap = await getFirestore().doc(`users/${uid}`).get();
  const profile = snap.exists ? snap.data() : null;
  if (!profile || profile.disabled === true || !["admin", "supervisor", "mechanic"].includes(profile.role)) {
    throw new HttpsError("permission-denied", "Your account doesn't have access to the manuals.");
  }
  return { uid, ...profile };
}

export async function requireAdmin(request) {
  const profile = await requireStaff(request);
  if (profile.role !== "admin") throw new HttpsError("permission-denied", "Admins only.");
  return profile;
}

/** Accepts "manuals/x.pdf", a gs:// URL, or an old Firebase download URL; returns "manuals/x.pdf". */
export function normalizeManualPath(input) {
  let path = String(input || "").trim();
  const dl = path.match(/\/o\/([^?#]+)/);
  if (/^https?:\/\//i.test(path) && dl) path = decodeURIComponent(dl[1]);
  path = path.replace(/^gs:\/\/[^/]+\//i, "");
  if (!path.startsWith(MANUALS_PREFIX) || !/\.pdf$/i.test(path) || path.includes("..")) {
    throw new HttpsError("invalid-argument", "Not a manual in this tracker's storage.");
  }
  return path;
}

export async function downloadBytes(path) {
  const [buf] = await bucket().file(path).download();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Remove the public download token from every manual so only signed-in users
 *  (through the app) can open them. Returns how many files were locked. */
export async function lockManualLinks() {
  const [files] = await bucket().getFiles({ prefix: MANUALS_PREFIX });
  let locked = 0;
  for (const f of files) {
    if (!/\.pdf$/i.test(f.name)) continue;
    const [meta] = await f.getMetadata();
    if (meta.metadata && meta.metadata.firebaseStorageDownloadTokens) {
      await f.setMetadata({ metadata: { firebaseStorageDownloadTokens: null } });
      locked++;
    }
  }
  return locked;
}

/** (Re)build the search index for any manual that changed since it was last indexed. */
export async function rebuildIndex({ force = false, log = console.log } = {}) {
  const [files] = await bucket().getFiles({ prefix: MANUALS_PREFIX });
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name));
  const [existing] = await bucket().getFiles({ prefix: INDEX_PREFIX });
  const indexed = new Map();
  for (const f of existing) {
    const [meta] = await f.getMetadata();
    if (meta.metadata) indexed.set(f.name, meta.metadata);
  }

  const results = [];
  const usedIds = new Set();
  const keep = new Set();
  for (const f of pdfs) {
    const info = describeManual(f.name);
    let id = info.id;
    for (let n = 2; usedIds.has(id); n++) id = `${info.id}${n}`;
    usedIds.add(id);
    const indexName = `${INDEX_PREFIX}${f.name.slice(MANUALS_PREFIX.length).replace(/\.pdf$/i, "")}.json`;
    keep.add(indexName);
    const prev = indexed.get(indexName);
    const generation = String(f.metadata.generation);
    if (!force && prev && prev.sourceGeneration === generation && prev.format === String(INDEX_FORMAT) && prev.manualId === id) {
      results.push({ id, file: info.file, pages: Number(prev.pageCount), status: "up to date" });
      continue;
    }
    log(`Indexing ${f.name}…`);
    const pages = await extractPages(await downloadBytes(f.name));
    const body = { format: INDEX_FORMAT, ...info, id, generation, pageCount: pages.length, pages };
    await bucket().file(indexName).save(JSON.stringify(body), {
      gzip: true,
      contentType: "application/json",
      metadata: {
        metadata: { sourceGeneration: generation, format: String(INDEX_FORMAT), manualId: id, pageCount: String(pages.length) },
      },
    });
    results.push({ id, file: info.file, pages: pages.length, status: "indexed" });
  }
  // Drop index files for manuals that were deleted.
  for (const f of existing) {
    if (!keep.has(f.name)) { await f.delete().catch(() => {}); }
  }
  indexCache = null;
  return results;
}

let indexCache = null;
const INDEX_TTL_MS = 10 * 60 * 1000;

/** Load every manual's index into a ManualSearch, cached per warm instance. */
export async function loadSearch() {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.search;
  const [files] = await bucket().getFiles({ prefix: INDEX_PREFIX });
  const manuals = [];
  for (const f of files) {
    const [buf] = await f.download();
    const m = JSON.parse(buf.toString("utf8"));
    if (m.format === INDEX_FORMAT) manuals.push(m);
  }
  manuals.sort((a, b) => a.id.localeCompare(b.id));
  const search = new ManualSearch(manuals);
  indexCache = { at: Date.now(), search };
  return search;
}

/** Per-user daily question cap, so a stuck button or shared login can't run up the bill. */
export async function countQuestion(uid, limit) {
  const day = new Date().toISOString().slice(0, 10);
  const ref = getFirestore().doc(`assistantUsage/${uid}_${day}`);
  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const n = snap.exists ? snap.data().count || 0 : 0;
    if (n >= limit) {
      throw new HttpsError("resource-exhausted", `Daily limit of ${limit} questions reached. It resets at midnight UTC.`);
    }
    tx.set(ref, { uid, day, count: n + 1 }, { merge: true });
    return n + 1;
  });
}
