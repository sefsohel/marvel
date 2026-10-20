
import {
  firebaseConfig,
  COLLECTION_CURRENT,
  COLLECTION_VERSIONS,
  MAX_HTML_BYTES,
} from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.2";
let ctx = null;

export class FirebaseProblem extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.name = "FirebaseProblem";
    this.kind = kind;
    this.cause = cause;
  }
}

async function init() {
  if (ctx) return ctx;

  let appMod, fsMod, authMod;

  try {
    [appMod, fsMod, authMod] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-firestore.js`),
      import(`${SDK}/firebase-auth.js`),
    ]);
  } catch (err) {
    throw new FirebaseProblem(
      "sdk",
      "Firebase SDK could not be loaded. Check your internet connection or browser extensions.",
      err
    );
  }

  const app = appMod.getApps().length
    ? appMod.getApp()
    : appMod.initializeApp(firebaseConfig);

  const db = fsMod.getFirestore(app);
  const auth = authMod.getAuth(app);

  ctx = { app, db, fs: fsMod, auth, authMod };
  return ctx;
}

export async function signInAdmin(email, password) {
  const { auth, authMod } = await init();

  try {
    const result = await authMod.signInWithEmailAndPassword(
      auth,
      email.trim(),
      password
    );

    return result.user;
  } catch (err) {
    const messages = {
      "auth/invalid-credential": "Incorrect email or password.",
      "auth/user-not-found": "No account exists for this email.",
      "auth/wrong-password": "Incorrect email or password.",
      "auth/invalid-email": "Enter a valid email address.",
      "auth/too-many-requests":
        "Too many login attempts. Please wait and try again.",
      "auth/network-request-failed":
        "Network error. Check your internet connection.",
    };

    throw new FirebaseProblem(
      err.code || "auth-error",
      messages[err.code] || `Sign-in failed: ${err.message}`,
      err
    );
  }
}

export async function signOutAdmin() {
  const { auth, authMod } = await init();
  await authMod.signOut(auth);
}

export async function getCurrentAdmin() {
  const { auth } = await init();
  return auth.currentUser;
}

export async function requireAdmin() {
  const user = await getCurrentAdmin();

  if (!user) {
    throw new FirebaseProblem(
      "unauthenticated",
      "Please sign in with your admin account first."
    );
  }

  return user;
}

function wrap(err, action) {
  if (err instanceof FirebaseProblem) return err;

  const code = err?.code ? String(err.code) : "";
  let msg;

  if (code.includes("permission-denied")) {
    msg = `Firestore refused to ${action}. Check your Firestore security rules and make sure you are signed in with the authorized admin account.`;
  } else if (code.includes("unauthenticated")) {
    msg = `You must sign in before you can ${action}.`;
  } else if (
    code.includes("unavailable") ||
    code.includes("deadline") ||
    /offline|network|timed out/i.test(err?.message || "")
  ) {
    msg = `Could not reach Cloud Firestore while trying to ${action}. Check your connection and try again.`;
  } else if (code.includes("not-found")) {
    msg = `Cloud Firestore database was not found while trying to ${action}.`;
  } else if (code.includes("resource-exhausted")) {
    msg = `Firestore quota was exceeded while trying to ${action}.`;
  } else if (
    code.includes("invalid-argument") ||
    code.includes("out-of-range")
  ) {
    msg = `Firestore rejected the data while trying to ${action}. The document may be too large or invalid.`;
  } else {
    msg = `Failed to ${action}: ${err?.message || "Unknown error"}`;
  }

  return new FirebaseProblem(code || "unknown", msg, err);
}

function withTimeout(promise, ms, action) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new FirebaseProblem(
          "timeout",
          `Timed out while trying to ${action}. Firestore did not respond within ${ms / 1000} seconds.`
        )
      );
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() =>
    clearTimeout(timer)
  );
}

const toDate = (ts) =>
  ts && typeof ts.toDate === "function" ? ts.toDate() : null;

export function byteLength(str) {
  return new TextEncoder().encode(str).length;
}

function assertHtml(html) {
  if (typeof html !== "string" || !html.trim()) {
    throw new FirebaseProblem("validation", "The HTML source is empty.");
  }

  const size = byteLength(html);

  if (size > MAX_HTML_BYTES) {
    throw new FirebaseProblem(
      "validation",
      `The HTML is ${Math.round(size / 1024)} KB. The configured limit is ${Math.round(MAX_HTML_BYTES / 1024)} KB. Reduce embedded images or host them elsewhere.`
    );
  }
}

export async function getTemplate(id) {
  const action = `read ${id}.html`;

  try {
    const { db, fs } = await init();

    const snap = await withTimeout(
      fs.getDoc(fs.doc(db, COLLECTION_CURRENT, id)),
      15000,
      action
    );

    if (!snap.exists()) return null;

    const data = snap.data();

    if (typeof data.html !== "string") {
      throw new FirebaseProblem(
        "invalid",
        `The Firestore document for ${id} has no "html" text field.`
      );
    }

    return {
      id,
      filename: data.filename || `${id}.html`,
      html: data.html,
      updatedAt: toDate(data.updatedAt),
    };
  } catch (err) {
    throw wrap(err, action);
  }
}

export async function saveTemplate(id, filename, html) {
  assertHtml(html);

  const action = `save ${filename}`;

  try {
    const { db, fs } = await init();
    await requireAdmin();

    const currentRef = fs.doc(db, COLLECTION_CURRENT, id);

    await withTimeout(
      fs.runTransaction(db, async (tx) => {
        const snap = await tx.get(currentRef);

        if (snap.exists()) {
          const previous = snap.data();

          tx.set(
            fs.doc(db, COLLECTION_VERSIONS, newVersionId(id)),
            {
              templateId: id,
              filename,
              html: previous.html,
              savedAt: fs.serverTimestamp(),
              originalUpdatedAt: previous.updatedAt || null,
              reason: "replaced-by-save",
            }
          );
        }

        tx.set(currentRef, {
          filename,
          html,
          updatedAt: fs.serverTimestamp(),
        });
      }),
      20000,
      action
    );
  } catch (err) {
    throw wrap(err, action);
  }
}

export async function restoreVersion(id, filename, versionId) {
  const action = `restore a version of ${filename}`;

  try {
    const { db, fs } = await init();
    await requireAdmin();

    const currentRef = fs.doc(db, COLLECTION_CURRENT, id);
    const versionRef = fs.doc(db, COLLECTION_VERSIONS, versionId);

    await withTimeout(
      fs.runTransaction(db, async (tx) => {
        const [currentSnap, versionSnap] = await Promise.all([
          tx.get(currentRef),
          tx.get(versionRef),
        ]);

        if (!versionSnap.exists()) {
          throw new FirebaseProblem(
            "missing",
            "That version no longer exists in history."
          );
        }

        const version = versionSnap.data();

        if (version.templateId !== id) {
          throw new FirebaseProblem(
            "mismatch",
            "That version belongs to a different template."
          );
        }

        assertHtml(version.html);

        if (currentSnap.exists()) {
          const previous = currentSnap.data();

          tx.set(
            fs.doc(db, COLLECTION_VERSIONS, newVersionId(id)),
            {
              templateId: id,
              filename,
              html: previous.html,
              savedAt: fs.serverTimestamp(),
              originalUpdatedAt: previous.updatedAt || null,
              reason: "replaced-by-restore",
            }
          );
        }

        tx.set(currentRef, {
          filename,
          html: version.html,
          updatedAt: fs.serverTimestamp(),
        });
      }),
      20000,
      action
    );
  } catch (err) {
    throw wrap(err, action);
  }
}

export async function listVersions(id) {
  const action = `load the history of ${id}.html`;

  try {
    const { db, fs } = await init();
    await requireAdmin();

    const query = fs.query(
      fs.collection(db, COLLECTION_VERSIONS),
      fs.where("templateId", "==", id)
    );

    const snap = await withTimeout(
      fs.getDocs(query),
      15000,
      action
    );

    const rows = snap.docs.map((doc) => {
      const version = doc.data();

      return {
        id: doc.id,
        templateId: version.templateId,
        filename: version.filename,
        html: version.html || "",
        reason: version.reason || "",
        savedAt: toDate(version.savedAt),
        originalUpdatedAt: toDate(version.originalUpdatedAt),
      };
    });

    rows.sort(
      (a, b) =>
        (b.savedAt?.getTime() || 0) -
        (a.savedAt?.getTime() || 0)
    );

    return rows;
  } catch (err) {
    throw wrap(err, action);
  }
}

function newVersionId(id) {
  return `${id}__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
