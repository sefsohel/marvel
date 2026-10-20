// Admin workbench: template cards, editor, live preview, Firestore save, history, restore, downloads, ZIP.
import { isUnlocked, openPasswordDialog, lockAdmin } from "./password-gate.js";
import { TEMPLATES, templateById, fetchStarter, createA4Preview } from "./templates.js";
import { getTemplate, saveTemplate, listVersions, restoreVersion, byteLength } from "./firebase.js";
import { MAX_HTML_BYTES } from "./firebase-config.js";
import { showToast, formatDate, downloadBlob } from "./app.js";

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ------------------------------------------------------------------ state
const cards = new Map();              // id -> { status: "loading"|"ok"|"missing"|"error", saved, error, preview }
const wb = { id: null, baseline: "", exists: false, sourceLabel: "", saving: false, versionPreview: null, historyOpen: false };
let pendingUploadTarget = null;
let previewTimer = null;
let wbPreview = null;

// ------------------------------------------------------------------ gate
function start() {
  if (isUnlocked()) return unlock();
  openPasswordDialog({ onSuccess: unlock, onCancel: () => { location.href = "index.html"; } });
}
function unlock() {
  $("#locked-screen").hidden = true;
  $("#admin-root").hidden = false;
  buildGrid();
  refreshAll();
}

// ------------------------------------------------------------------ dialogs
function confirmAction({ title, message, confirmLabel = "CONFIRM" }) {
  return new Promise((resolve) => {
    const dlg = $("#confirm-dialog");
    $("#confirm-title").textContent = title;
    $("#confirm-text").textContent = message;
    $("#confirm-yes").textContent = confirmLabel;
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; dlg.close(); cleanup(); resolve(v); };
    const yes = () => done(true), no = () => done(false);
    const esc_ = (e) => { e.preventDefault(); done(false); };
    const cleanup = () => { $("#confirm-yes").removeEventListener("click", yes); $("#confirm-no").removeEventListener("click", no); dlg.removeEventListener("cancel", esc_); };
    $("#confirm-yes").addEventListener("click", yes); $("#confirm-no").addEventListener("click", no); dlg.addEventListener("cancel", esc_);
    dlg.showModal(); $("#confirm-no").focus();
  });
}

// ------------------------------------------------------------------ template cards
function buildGrid() {
  const grid = $("#template-grid");
  grid.innerHTML = "";
  for (const t of TEMPLATES) {
    const el = document.createElement("article");
    el.className = `tcard cut-box edition-${t.edition}`;
    el.dataset.id = t.id;
    el.innerHTML = `
      <div class="tcard-thumb" aria-label="Preview of ${esc(t.filename)}"></div>
      <div class="tcard-info">
        <header class="tcard-head"><h2>${esc(t.filename)}</h2><span class="chip chip-${t.edition}">${t.edition === "color" ? "Color" : "Manga"}</span></header>
        <dl class="tcard-meta">
          <div><dt>Purpose</dt><dd>${esc(t.purpose)}</dd></div>
          <div><dt>Firebase</dt><dd data-role="status">Loading…</dd></div>
          <div><dt>Updated</dt><dd data-role="updated">-</dd></div>
        </dl>
        <div class="tcard-actions">
          <button type="button" class="btn btn-small btn-primary" data-act="edit">EDIT HTML</button>
          <button type="button" class="btn btn-small btn-ghost" data-act="upload">UPLOAD HTML</button>
          <button type="button" class="btn btn-small btn-ghost" data-act="history">HISTORY</button>
          <button type="button" class="btn btn-small btn-ghost" data-act="download">DOWNLOAD</button>
        </div>
      </div>`;
    grid.appendChild(el);
    const preview = createA4Preview($(".tcard-thumb", el));
    cards.set(t.id, { status: "loading", saved: null, error: null, preview, el });
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]"); if (!b) return;
      const act = b.dataset.act;
      if (act === "edit") openWorkbench(t.id);
      if (act === "upload") pickFile(t.id);
      if (act === "history") openWorkbench(t.id, { history: true });
      if (act === "download") downloadSaved(t.id, b);
    });
  }
}

async function refreshCard(id) {
  const c = cards.get(id);
  c.status = "loading"; paintCard(id);
  try {
    const saved = await getTemplate(id);
    c.saved = saved; c.error = null; c.status = saved ? "ok" : "missing";
  } catch (err) { c.saved = null; c.error = err.message; c.status = "error"; }
  paintCard(id);
  // thumbnail: saved version, else starter
  let html = c.saved ? c.saved.html : "";
  if (!html && c.status !== "loading") { try { html = await fetchStarter(id); } catch { html = ""; } }
  c.preview.render(html);
}

function paintCard(id) {
  const c = cards.get(id), st = $('[data-role="status"]', c.el), up = $('[data-role="updated"]', c.el);
  st.className = "";
  if (c.status === "loading") { st.textContent = "Loading…"; up.textContent = "-"; }
  else if (c.status === "ok") { st.textContent = "Saved in Firestore"; st.classList.add("ok"); up.textContent = formatDate(c.saved.updatedAt); }
  else if (c.status === "missing") { st.textContent = "Not saved yet (bundled starter shown)"; st.classList.add("warn"); up.textContent = "-"; }
  else { st.textContent = c.error; st.classList.add("err"); up.textContent = "-"; }
}

async function refreshAll() {
  const chip = $("#conn-status");
  chip.textContent = "Checking Firebase…"; chip.className = "chip";
  await Promise.all(TEMPLATES.map((t) => refreshCard(t.id)));
  const states = TEMPLATES.map((t) => cards.get(t.id).status);
  if (states.every((s) => s === "error")) { chip.textContent = "Firebase unreachable"; chip.className = "chip chip-err"; }
  else if (states.some((s) => s === "error")) { chip.textContent = "Firebase partly failing"; chip.className = "chip chip-err"; }
  else if (states.some((s) => s === "missing")) { chip.textContent = "Connected: templates missing"; chip.className = "chip chip-warn"; }
  else { chip.textContent = "Firebase connected"; chip.className = "chip chip-ok"; }
}

async function downloadSaved(id, btn) {
  const t = templateById(id);
  btn.disabled = true;
  try {
    const saved = await getTemplate(id);
    if (!saved) throw new Error(`${t.filename} is not saved in Firebase yet. Open it, save it, then download.`);
    downloadBlob(new Blob([saved.html], { type: "text/html;charset=utf-8" }), t.filename);
    showToast(`Downloaded ${t.filename}.`, "ok");
  } catch (err) { showToast(`Download failed. ${err.message}`, "err", 9000); }
  finally { btn.disabled = false; }
}

// ------------------------------------------------------------------ workbench
const code = () => $("#wb-code");
const isDirty = () => code().value !== wb.baseline;

function buildTabs() {
  const tabs = $("#wb-tabs"); tabs.innerHTML = "";
  for (const t of TEMPLATES) {
    const b = document.createElement("button");
    b.type = "button"; b.role = "tab"; b.className = "wb-tab"; b.dataset.id = t.id;
    b.textContent = t.filename; b.setAttribute("aria-selected", String(t.id === wb.id));
    b.addEventListener("click", () => { if (t.id !== wb.id) switchTemplate(t.id); });
    tabs.appendChild(b);
  }
}

async function guardUnsaved(message) {
  if (!wb.id || !isDirty()) return true;
  return confirmAction({ title: "Unsaved changes", message, confirmLabel: "DISCARD CHANGES" });
}

async function openWorkbench(id, { history = false, uploadFile = null } = {}) {
  const dlg = $("#workbench");
  if (dlg.open) { if (id !== wb.id) return switchTemplate(id, { history, uploadFile }); }
  else {
    wb.id = id; buildTabs();
    if (!wbPreview) wbPreview = createA4Preview($("#wb-preview"));
    dlg.showModal();
  }
  await loadIntoEditor(id);
  if (uploadFile) applyUpload(uploadFile);
  if (history) toggleHistory(true);
}

async function switchTemplate(id, opts = {}) {
  if (!(await guardUnsaved(`You have unsaved changes to ${templateById(wb.id).filename}. Switch to ${templateById(id).filename} and discard them?`))) return;
  toggleHistory(false); exitVersionPreview(true);
  wb.id = id; buildTabs();
  await loadIntoEditor(id);
  if (opts.uploadFile) applyUpload(opts.uploadFile);
  if (opts.history) toggleHistory(true);
}

async function loadIntoEditor(id) {
  const t = templateById(id);
  $("#wb-filename").textContent = t.filename;
  $("#wb-meta").textContent = `${t.edition === "color" ? "Color" : "Manga"} edition, ${t.side.toLowerCase()} page`;
  setValidation("Loading from Firebase…", "info");
  code().disabled = true;
  let html = "", label = "", exists = false;
  try {
    const saved = await getTemplate(id);
    if (saved) { html = saved.html; exists = true; label = `Saved ${formatDate(saved.updatedAt)}`; setValidation("", ""); }
    else { html = await fetchStarter(id); label = "Bundled starter, not saved yet"; setValidation(`${t.filename} is not in Firebase yet. The bundled starter is loaded. Press Save to store it.`, "warn"); }
  } catch (err) {
    try { html = await fetchStarter(id); } catch { html = ""; }
    label = "Bundled starter, Firebase unavailable";
    setValidation(`${err.message} The editor shows the bundled starter; saving will fail until the connection works.`, "err");
  }
  wb.exists = exists; wb.baseline = html; wb.sourceLabel = label;
  code().value = html; code().disabled = false;
  updateIndicators(); schedulePreview(0);
}

function updateIndicators() {
  const v = code().value, n = v.length;
  $("#wb-count").textContent = `${n.toLocaleString()} characters (${Math.round(byteLength(v) / 1024)} KB)`;
  const dirty = isDirty();
  const d = $("#wb-dirty");
  d.textContent = dirty ? "Unsaved changes" : (wb.exists ? "Saved" : "Not saved yet");
  d.className = `chip ${dirty ? "chip-warn" : (wb.exists ? "chip-ok" : "chip-warn")}`;
  $("#wb-source").textContent = wb.sourceLabel;
  $("#wb-save").disabled = wb.saving || (!dirty && wb.exists);
}

function setValidation(text, kind) {
  const el = $("#wb-validation"); el.textContent = text; el.className = `wb-validation ${kind || ""}`;
}

function validateSource(html) {
  const problems = [], notes = [];
  if (!html.trim()) problems.push("The HTML is empty.");
  else if (!/<[a-z!][^>]*>/i.test(html)) problems.push("This does not look like HTML. Add at least one tag.");
  const bytes = byteLength(html);
  if (bytes > MAX_HTML_BYTES) problems.push(`The source is ${Math.round(bytes / 1024)} KB; the limit is ${Math.round(MAX_HTML_BYTES / 1024)} KB (Firestore document size).`);
  if (!/<!doctype html/i.test(html)) notes.push("No <!doctype html> found.");
  if (/<script[\s>]/i.test(html)) notes.push("Contains <script>: scripts do not run in the preview or the PDF.");
  if (/(src|href)=["']https?:/i.test(html) || /url\(\s*["']?https?:/i.test(html)) notes.push("Uses external resources: they must allow cross-origin access to appear in the PDF.");
  return { problems, notes };
}

function schedulePreview(delay = 250) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => { if (!wb.versionPreview) wbPreview.render(code().value); }, delay);
}

code()?.addEventListener("input", () => {
  if (wb.versionPreview) exitVersionPreview(false);
  updateIndicators(); schedulePreview();
  const { problems, notes } = validateSource(code().value);
  if (problems.length) setValidation(problems.join(" "), "err");
  else setValidation(notes.join(" "), notes.length ? "warn" : "");
});

// ------------------------------------------------------------------ upload
function pickFile(targetId) {
  pendingUploadTarget = targetId;
  const input = $("#file-input"); input.value = ""; input.click();
}

$("#file-input").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0]; if (!file) return;
  const id = pendingUploadTarget || wb.id; pendingUploadTarget = null;
  if (!/\.html?$/i.test(file.name)) { showToast(`"${file.name}" is not an .html or .htm file.`, "err"); return; }
  if (file.size > MAX_HTML_BYTES * 1.2) { showToast(`"${file.name}" is too large (${Math.round(file.size / 1024)} KB).`, "err"); return; }
  let text;
  try { text = await file.text(); } catch { showToast(`"${file.name}" could not be read.`, "err"); return; }
  const dlg = $("#workbench");
  if (dlg.open && id === wb.id) applyUpload({ name: file.name, text });
  else await openWorkbench(id, { uploadFile: { name: file.name, text } });
});

function applyUpload({ name, text }) {
  const t = templateById(wb.id);
  if (wb.versionPreview) exitVersionPreview(false);
  toggleHistory(false);
  code().value = text.replace(/^\uFEFF/, "");
  wb.sourceLabel = `Uploaded ${name}, not saved`;
  updateIndicators(); schedulePreview(0);
  const { problems, notes } = validateSource(code().value);
  setValidation(problems.length ? problems.join(" ") : `Loaded ${name} into ${t.filename}. Nothing is saved until you press Save. ${notes.join(" ")}`, problems.length ? "err" : "info");
}

$("#wb-upload").addEventListener("click", () => pickFile(wb.id));
$("#wb-starter").addEventListener("click", async () => {
  try {
    const html = await fetchStarter(wb.id);
    if (isDirty() && !(await confirmAction({ title: "Replace editor contents?", message: `Load the bundled starter for ${templateById(wb.id).filename}? Your current edits in the editor will be replaced (nothing is saved).`, confirmLabel: "LOAD STARTER" }))) return;
    if (wb.versionPreview) exitVersionPreview(false);
    code().value = html; wb.sourceLabel = "Bundled starter, not saved"; updateIndicators(); schedulePreview(0);
    setValidation("Starter loaded. Press Save to store it in Firebase.", "info");
  } catch (err) { setValidation(err.message, "err"); }
});

$("#wb-download").addEventListener("click", () => {
  const t = templateById(wb.id);
  downloadBlob(new Blob([code().value], { type: "text/html;charset=utf-8" }), t.filename);
});

// ------------------------------------------------------------------ save / cancel
$("#wb-save").addEventListener("click", async () => {
  if (wb.saving) return;
  const t = templateById(wb.id), html = code().value;
  const { problems } = validateSource(html);
  if (problems.length) { setValidation(problems.join(" "), "err"); return; }
  wb.saving = true; $("#wb-save").classList.add("loading"); updateIndicators();
  setValidation(`Saving ${t.filename}…`, "info");
  try {
    await saveTemplate(t.id, t.filename, html);
    const check = await getTemplate(t.id);                  // read back so success is never assumed
    if (!check || check.html !== html) throw new Error("Firestore did not return the saved content. Nothing was confirmed; try again.");
    wb.baseline = html; wb.exists = true; wb.sourceLabel = `Saved ${formatDate(check.updatedAt)}`;
    setValidation(`Saved ${t.filename} to Firebase. The previous version was archived.`, "ok");
    showToast(`Saved ${t.filename} to Firebase.`, "ok");
    refreshCard(t.id);
    if (wb.historyOpen) renderHistory();
  } catch (err) {
    setValidation(`Save failed. ${err.message}`, "err");
    showToast(`Save failed. ${err.message}`, "err", 10000);
  } finally {
    wb.saving = false; $("#wb-save").classList.remove("loading"); updateIndicators();
  }
});

async function closeWorkbench() {
  if (!(await guardUnsaved("You have unsaved changes. Close the editor and discard them?"))) return;
  toggleHistory(false); exitVersionPreview(true);
  $("#workbench").close(); wb.id = null;
}
$("#wb-cancel").addEventListener("click", closeWorkbench);
$("#workbench").addEventListener("cancel", (e) => { e.preventDefault(); closeWorkbench(); });
window.addEventListener("beforeunload", (e) => { if ($("#workbench").open && wb.id && isDirty()) { e.preventDefault(); e.returnValue = ""; } });

// ------------------------------------------------------------------ history / restore
function toggleHistory(open) {
  wb.historyOpen = open;
  $("#wb-history-pane").hidden = !open; $("#wb-editor-pane").hidden = open;
  $("#wb-history-btn").setAttribute("aria-pressed", String(open));
  if (open) renderHistory(); else exitVersionPreview(true);
}
$("#wb-history-btn").addEventListener("click", () => toggleHistory(!wb.historyOpen));
$("#wb-history-close").addEventListener("click", () => toggleHistory(false));

async function renderHistory() {
  const list = $("#wb-history-list"), id = wb.id, t = templateById(id);
  list.innerHTML = `<li class="history-empty">Loading history…</li>`;
  try {
    const rows = await listVersions(id);
    if (id !== wb.id) return;
    if (!rows.length) { list.innerHTML = `<li class="history-empty">No archived versions yet. The first one appears the next time ${esc(t.filename)} is saved.</li>`; return; }
    list.innerHTML = "";
    rows.forEach((v, i) => {
      const li = document.createElement("li"); li.className = "history-item cut-box";
      const why = v.reason === "replaced-by-restore" ? "archived before a restore" : "archived by a save";
      li.innerHTML = `<div><strong>${esc(formatDate(v.originalUpdatedAt || v.savedAt))}</strong><span>${esc(why)} on ${esc(formatDate(v.savedAt))} &middot; ${Math.round(byteLength(v.html) / 1024)} KB${i === 0 ? " &middot; most recent archive" : ""}</span></div>
        <div class="history-btns"><button type="button" class="btn btn-small btn-ghost" data-act="preview">PREVIEW</button><button type="button" class="btn btn-small btn-primary" data-act="restore">RESTORE</button></div>`;
      li.querySelector('[data-act="preview"]').addEventListener("click", () => enterVersionPreview(v));
      li.querySelector('[data-act="restore"]').addEventListener("click", () => doRestore(v));
      list.appendChild(li);
    });
  } catch (err) { list.innerHTML = `<li class="history-empty err">${esc(err.message)}</li>`; }
}

function enterVersionPreview(v) {
  wb.versionPreview = v;
  const b = $("#wb-banner");
  b.hidden = false;
  b.innerHTML = `<span>Previewing the version from <strong>${esc(formatDate(v.originalUpdatedAt || v.savedAt))}</strong>. The editor is unchanged.</span><button type="button" class="btn btn-small btn-ghost" id="wb-banner-close">BACK TO EDITOR PREVIEW</button>`;
  $("#wb-banner-close").addEventListener("click", () => exitVersionPreview(false));
  wbPreview.render(v.html);
}
function exitVersionPreview(silent) {
  if (!wb.versionPreview) return;
  wb.versionPreview = null; $("#wb-banner").hidden = true;
  if (!silent) wbPreview.render(code().value);
}

async function doRestore(v) {
  const t = templateById(wb.id);
  const dirtyNote = isDirty() ? " Unsaved edits in the editor will be replaced." : "";
  const ok = await confirmAction({
    title: `Restore ${t.filename}?`,
    message: `Restore the version from ${formatDate(v.originalUpdatedAt || v.savedAt)}? The current version is archived first, so it can be restored later. Other templates are not affected.${dirtyNote}`,
    confirmLabel: "RESTORE VERSION"
  });
  if (!ok) return;
  try {
    await restoreVersion(t.id, t.filename, v.id);
    showToast(`Restored ${t.filename}. The previous current version is in the history.`, "ok");
    exitVersionPreview(true);
    await loadIntoEditor(t.id);
    refreshCard(t.id); renderHistory();
  } catch (err) { showToast(`Restore failed. ${err.message}`, "err", 10000); }
}

// ------------------------------------------------------------------ header actions
$("#btn-lock").addEventListener("click", () => { lockAdmin(); location.href = "index.html"; });

$("#btn-zip").addEventListener("click", async (e) => {
  const btn = e.currentTarget; btn.disabled = true; btn.classList.add("loading");
  try {
    const zipUrl = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    if (!window.JSZip) await new Promise((res, rej) => { const s = document.createElement("script"); s.src = zipUrl; s.onload = res; s.onerror = () => rej(new Error("The ZIP library (JSZip) could not be loaded. Check your connection.")); document.head.appendChild(s); });
    const results = await Promise.allSettled(TEMPLATES.map((t) => getTemplate(t.id)));
    const failures = [], zip = new window.JSZip();
    results.forEach((r, i) => {
      const t = TEMPLATES[i];
      if (r.status === "rejected") failures.push(`${t.filename}: ${r.reason.message}`);
      else if (!r.value) failures.push(`${t.filename}: not saved in Firebase yet`);
      else zip.file(t.filename, r.value.html);
    });
    if (failures.length) throw new Error(`Export cancelled, so no outdated files are included. ${failures.join(" | ")}`);
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    downloadBlob(blob, "epic_card_templates.zip");
    showToast("Exported 4 templates from Firebase as epic_card_templates.zip.", "ok");
  } catch (err) { showToast(err.message, "err", 12000); }
  finally { btn.disabled = false; btn.classList.remove("loading"); }
});

$("#btn-init").addEventListener("click", async (e) => {
  const btn = e.currentTarget; btn.disabled = true;
  try {
    await refreshAll();
    const missing = TEMPLATES.filter((t) => cards.get(t.id).status === "missing");
    const broken = TEMPLATES.filter((t) => cards.get(t.id).status === "error");
   if (broken.length) {
  const details = broken
    .map((t) => {
      const error = cards.get(t.id)?.error || "Unknown error";
      return `${t.filename}: ${error}`;
    })
    .join("\n");

  throw new Error(`Firebase check failed:\n${details}`);
}
    if (!missing.length) { showToast("All four templates already exist in Firebase. Nothing to initialize.", "info"); return; }
    if (!(await confirmAction({ title: "Initialize templates", message: `Save the bundled starter for ${missing.map((t) => t.filename).join(", ")} to Firebase? Existing templates are never touched.`, confirmLabel: "SAVE STARTERS" }))) return;
    for (const t of missing) { await saveTemplate(t.id, t.filename, await fetchStarter(t.id)); }
    showToast(`Saved ${missing.length} starter template(s) to Firebase.`, "ok");
    await refreshAll();
  } catch (err) { showToast(err.message, "err", 10000); }
  finally { btn.disabled = false; }
});

start();
