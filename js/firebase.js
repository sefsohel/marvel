// Firebase / Cloud Firestore access layer (modular SDK, loaded lazily from the CDN).
import { firebaseConfig, COLLECTION_CURRENT, COLLECTION_VERSIONS, MAX_HTML_BYTES } from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.2";
let ctx = null;

async function init() {
  if (ctx) return ctx;
  let appMod, fsMod;
  try {
    [appMod, fsMod] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-firestore.js`)
    ]);
  } catch (err) {
    throw new FirebaseProblem("sdk", "The Firebase SDK could not be loaded from the CDN. Check your internet connection or a blocker extension.", err);
  }
  const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(firebaseConfig);
  const db = fsMod.getFirestore(app);
  ctx = { db, fs: fsMod };
  return ctx;
}

export class FirebaseProblem extends Error {
  constructor(kind, message, cause) { super(message); this.name = "FirebaseProblem"; this.kind = kind; this.cause = cause; }
}

/** Turn any Firestore/SDK error into a readable FirebaseProblem. */
function wrap(err, action) {
  if (err instanceof FirebaseProblem) return err;
  const code = err && err.code ? String(err.code) : "";
  let msg;
  if (code.includes("permission-denied")) msg = `Firestore refused to ${action}. The security rules do not allow this operation (see README, "Firestore rules").`;
  else if (code.includes("unavailable") || code.includes("deadline") || /offline|network|timed out/i.test(err && err.message)) msg = `Could not reach Cloud Firestore while trying to ${action}. Check your connection and try again.`;
  else if (code.includes("not-found")) msg = `Cloud Firestore database was not found while trying to ${action}. Create the database in the Firebase console first.`;
  else if (code.includes("resource-exhausted")) msg = `Firestore quota was exceeded while trying to ${action}.`;
  else if (code.includes("invalid-argument") || code.includes("out-of-range")) msg = `Firestore rejected the data while trying to ${action} (it may be too large).`;
  else msg = `Failed to ${action}: ${(err && err.message) || "unknown error"}`;
  return new FirebaseProblem(code || "unknown", msg, err);
}

function withTimeout(promise, ms, action) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new FirebaseProblem("timeout", `Timed out while trying to ${action}. Cloud Firestore did not answer within ${ms / 1000} seconds.`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

const toDate = (ts) => (ts && typeof ts.toDate === "function" ? ts.toDate() : null);

export function byteLength(str) { return new TextEncoder().encode(str).length; }

function assertHtml(html) {
  if (typeof html !== "string" || !html.trim()) throw new FirebaseProblem("validation", "The HTML source is empty.");
  const n = byteLength(html);
  if (n > MAX_HTML_BYTES) throw new FirebaseProblem("validation", `The HTML is ${Math.round(n / 1024)} KB. Firestore documents are limited to 1 MiB, so templates must stay under ${Math.round(MAX_HTML_BYTES / 1024)} KB. Reduce embedded images or host them elsewhere.`);
}

/** Read one current template. Returns null when the document does not exist. */
export async function getTemplate(id) {
  const action = `read ${id}.html`;
  try {
    const { db, fs } = await init();
    const snap = await withTimeout(fs.getDoc(fs.doc(db, COLLECTION_CURRENT, id)), 15000, action);
    if (!snap.exists()) return null;
    const d = snap.data();
    if (typeof d.html !== "string") throw new FirebaseProblem("invalid", `The Firestore document for ${id} has no "html" text field.`);
    return { id, filename: d.filename || `${id}.html`, html: d.html, updatedAt: toDate(d.updatedAt) };
  } catch (err) { throw wrap(err, action); }
}

/** Save a template. In one transaction: archive the existing version, then write the new one. */
export async function saveTemplate(id, filename, html) {
  assertHtml(html);
  const action = `save ${filename}`;
  try {
    const { db, fs } = await init();
    const curRef = fs.doc(db, COLLECTION_CURRENT, id);
    await withTimeout(fs.runTransaction(db, async (tx) => {
      const snap = await tx.get(curRef);
      if (snap.exists()) {
        const prev = snap.data();
        tx.set(fs.doc(db, COLLECTION_VERSIONS, newVersionId(id)), {
          templateId: id, filename, html: prev.html,
          savedAt: fs.serverTimestamp(), originalUpdatedAt: prev.updatedAt || null, reason: "replaced-by-save"
        });
      }
      tx.set(curRef, { filename, html, updatedAt: fs.serverTimestamp() });
    }), 20000, action);
  } catch (err) { throw wrap(err, action); }
}

/** Restore an archived version. The current version is archived first; other templates are untouched. */
export async function restoreVersion(id, filename, versionId) {
  const action = `restore a version of ${filename}`;
  try {
    const { db, fs } = await init();
    const curRef = fs.doc(db, COLLECTION_CURRENT, id);
    const verRef = fs.doc(db, COLLECTION_VERSIONS, versionId);
    await withTimeout(fs.runTransaction(db, async (tx) => {
      const [curSnap, verSnap] = await Promise.all([tx.get(curRef), tx.get(verRef)]);
      if (!verSnap.exists()) throw new FirebaseProblem("missing", "That version no longer exists in the history.");
      const ver = verSnap.data();
      if (ver.templateId !== id) throw new FirebaseProblem("mismatch", "That version belongs to a different template.");
      assertHtml(ver.html);
      if (curSnap.exists()) {
        const prev = curSnap.data();
        tx.set(fs.doc(db, COLLECTION_VERSIONS, newVersionId(id)), {
          templateId: id, filename, html: prev.html,
          savedAt: fs.serverTimestamp(), originalUpdatedAt: prev.updatedAt || null, reason: "replaced-by-restore"
        });
      }
      tx.set(curRef, { filename, html: ver.html, updatedAt: fs.serverTimestamp() });
    }), 20000, action);
  } catch (err) { throw wrap(err, action); }
}

/** List archived versions of one template, newest first. */
export async function listVersions(id) {
  const action = `load the history of ${id}.html`;
  try {
    const { db, fs } = await init();
    const q = fs.query(fs.collection(db, COLLECTION_VERSIONS), fs.where("templateId", "==", id));
    const snap = await withTimeout(fs.getDocs(q), 15000, action);
    const rows = snap.docs.map((d) => {
      const v = d.data();
      return { id: d.id, templateId: v.templateId, filename: v.filename, html: v.html || "", reason: v.reason || "", savedAt: toDate(v.savedAt), originalUpdatedAt: toDate(v.originalUpdatedAt) };
    });
    rows.sort((a, b) => (b.savedAt?.getTime() || 0) - (a.savedAt?.getTime() || 0));
    return rows;
  } catch (err) { throw wrap(err, action); }
}

function newVersionId(id) {
  return `${id}__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
