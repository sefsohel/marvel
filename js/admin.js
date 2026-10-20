
import { openPasswordDialog, lockAdmin } from "./password-gate.js";
import {
  TEMPLATES,
  templateById,
  fetchStarter,
  createA4Preview,
} from "./templates.js";
import {
  getTemplate,
  saveTemplate,
  listVersions,
  restoreVersion,
  byteLength,
  signOutAdmin,
} from "./firebase.js";
import { MAX_HTML_BYTES } from "./firebase-config.js";
import { showToast, formatDate, downloadBlob } from "./app.js";

const $ = (selector, root = document) => root.querySelector(selector);

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------

const cards = new Map();

const wb = {
  id: null,
  baseline: "",
  exists: false,
  sourceLabel: "",
  saving: false,
  versionPreview: null,
  historyOpen: false,
};

let pendingUploadTarget = null;
let previewTimer = null;
let wbPreview = null;

// ------------------------------------------------------------------
// Authentication gate
// ------------------------------------------------------------------

function start() {
  openPasswordDialog({
    onSuccess: unlock,
    onCancel: () => {
      location.href = "index.html";
    },
  });
}

function unlock() {
  $("#locked-screen").hidden = true;
  $("#admin-root").hidden = false;

  buildGrid();
  refreshAll();
}

// ------------------------------------------------------------------
// Confirmation dialog
// ------------------------------------------------------------------

function confirmAction({
  title,
  message,
  confirmLabel = "CONFIRM",
}) {
  return new Promise((resolve) => {
    const dialog = $("#confirm-dialog");

    $("#confirm-title").textContent = title;
    $("#confirm-text").textContent = message;
    $("#confirm-yes").textContent = confirmLabel;

    let settled = false;

    const cleanup = () => {
      $("#confirm-yes").removeEventListener("click", yes);
      $("#confirm-no").removeEventListener("click", no);
      dialog.removeEventListener("cancel", onCancel);
    };

    const finish = (value) => {
      if (settled) return;

      settled = true;
      dialog.close();
      cleanup();
      resolve(value);
    };

    const yes = () => finish(true);
    const no = () => finish(false);

    const onCancel = (event) => {
      event.preventDefault();
      finish(false);
    };

    $("#confirm-yes").addEventListener("click", yes);
    $("#confirm-no").addEventListener("click", no);
    dialog.addEventListener("cancel", onCancel);

    dialog.showModal();
    $("#confirm-no").focus();
  });
}

// ------------------------------------------------------------------
// Template cards
// ------------------------------------------------------------------

function buildGrid() {
  const grid = $("#template-grid");
  grid.innerHTML = "";

  for (const template of TEMPLATES) {
    const element = document.createElement("article");

    element.className =
      `tcard cut-box edition-${template.edition}`;

    element.dataset.id = template.id;

    element.innerHTML = `
      <div
        class="tcard-thumb"
        aria-label="Preview of ${esc(template.filename)}"
      ></div>

      <div class="tcard-info">
        <header class="tcard-head">
          <h2>${esc(template.filename)}</h2>
          <span class="chip chip-${template.edition}">
            ${template.edition === "color" ? "Color" : "Manga"}
          </span>
        </header>

        <dl class="tcard-meta">
          <div>
            <dt>Purpose</dt>
            <dd>${esc(template.purpose)}</dd>
          </div>

          <div>
            <dt>Firebase</dt>
            <dd data-role="status">Loading…</dd>
          </div>

          <div>
            <dt>Updated</dt>
            <dd data-role="updated">-</dd>
          </div>
        </dl>

        <div class="tcard-actions">
          <button type="button" class="btn btn-small btn-primary"
            data-act="edit">EDIT HTML</button>

          <button type="button" class="btn btn-small btn-ghost"
            data-act="upload">UPLOAD HTML</button>

          <button type="button" class="btn btn-small btn-ghost"
            data-act="history">HISTORY</button>

          <button type="button" class="btn btn-small btn-ghost"
            data-act="download">DOWNLOAD</button>
        </div>
      </div>
    `;

    grid.appendChild(element);

    const preview = createA4Preview(
      $(".tcard-thumb", element)
    );

    cards.set(template.id, {
      status: "loading",
      saved: null,
      error: null,
      preview,
      el: element,
    });

    element.addEventListener("click", (event) => {
      const button = event.target.closest("[data-act]");
      if (!button) return;

      const action = button.dataset.act;

      if (action === "edit") {
        openWorkbench(template.id);
      }

      if (action === "upload") {
        pickFile(template.id);
      }

      if (action === "history") {
        openWorkbench(template.id, { history: true });
      }

      if (action === "download") {
        downloadSaved(template.id, button);
      }
    });
  }
}

async function refreshCard(id) {
  const card = cards.get(id);

  card.status = "loading";
  paintCard(id);

  try {
    const saved = await getTemplate(id);

    card.saved = saved;
    card.error = null;
    card.status = saved ? "ok" : "missing";
  } catch (error) {
    card.saved = null;
    card.error = error.message;
    card.status = "error";
  }

  paintCard(id);

  let html = card.saved ? card.saved.html : "";

  if (!html && card.status !== "loading") {
    try {
      html = await fetchStarter(id);
    } catch {
      html = "";
    }
  }

  card.preview.render(html);
}

function paintCard(id) {
  const card = cards.get(id);

  const status = $('[data-role="status"]', card.el);
  const updated = $('[data-role="updated"]', card.el);

  status.className = "";

  if (card.status === "loading") {
    status.textContent = "Loading…";
    updated.textContent = "-";
  } else if (card.status === "ok") {
    status.textContent = "Saved in Firestore";
    status.classList.add("ok");
    updated.textContent = formatDate(card.saved.updatedAt);
  } else if (card.status === "missing") {
    status.textContent = "Not saved yet (bundled starter shown)";
    status.classList.add("warn");
    updated.textContent = "-";
  } else {
    status.textContent = card.error;
    status.classList.add("err");
    updated.textContent = "-";
  }
}

async function refreshAll() {
  const chip = $("#conn-status");

  chip.textContent = "Checking Firebase…";
  chip.className = "chip";

  await Promise.all(
    TEMPLATES.map((template) => refreshCard(template.id))
  );

  const states = TEMPLATES.map(
    (template) => cards.get(template.id).status
  );

  if (states.every((state) => state === "error")) {
    chip.textContent = "Firebase unreachable";
    chip.className = "chip chip-err";
  } else if (states.some((state) => state === "error")) {
    chip.textContent = "Firebase partly failing";
    chip.className = "chip chip-err";
  } else if (states.some((state) => state === "missing")) {
    chip.textContent = "Connected: templates missing";
    chip.className = "chip chip-warn";
  } else {
    chip.textContent = "Firebase connected";
    chip.className = "chip chip-ok";
  }
}

// ------------------------------------------------------------------
// Download saved template
// ------------------------------------------------------------------

async function downloadSaved(id, button) {
  const template = templateById(id);

  button.disabled = true;

  try {
    const saved = await getTemplate(id);

    if (!saved) {
      throw new Error(
        `${template.filename} is not saved in Firebase yet. ` +
        "Open it, save it, then download."
      );
    }

    downloadBlob(
      new Blob([saved.html], {
        type: "text/html;charset=utf-8",
      }),
      template.filename
    );

    showToast(`Downloaded ${template.filename}.`, "ok");
  } catch (error) {
    showToast(
      `Download failed. ${error.message}`,
      "err",
      9000
    );
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------------
// Workbench
// ------------------------------------------------------------------

const code = () => $("#wb-code");

const isDirty = () => code().value !== wb.baseline;

function buildTabs() {
  const tabs = $("#wb-tabs");
  tabs.innerHTML = "";

  for (const template of TEMPLATES) {
    const button = document.createElement("button");

    button.type = "button";
    button.role = "tab";
    button.className = "wb-tab";
    button.dataset.id = template.id;
    button.textContent = template.filename;

    button.setAttribute(
      "aria-selected",
      String(template.id === wb.id)
    );

    button.addEventListener("click", () => {
      if (template.id !== wb.id) {
        switchTemplate(template.id);
      }
    });

    tabs.appendChild(button);
  }
}

async function guardUnsaved(message) {
  if (!wb.id || !isDirty()) return true;

  return confirmAction({
    title: "Unsaved changes",
    message,
    confirmLabel: "DISCARD CHANGES",
  });
}

async function openWorkbench(
  id,
  { history = false, uploadFile = null } = {}
) {
  const dialog = $("#workbench");

  if (dialog.open) {
    if (id !== wb.id) {
      return switchTemplate(id, { history, uploadFile });
    }
  } else {
    wb.id = id;
    buildTabs();

    if (!wbPreview) {
      wbPreview = createA4Preview($("#wb-preview"));
    }

    dialog.showModal();
  }

  await loadIntoEditor(id);

  if (uploadFile) {
    applyUpload(uploadFile);
  }

  if (history) {
    toggleHistory(true);
  }
}

async function switchTemplate(id, options = {}) {
  const currentTemplate = templateById(wb.id);
  const nextTemplate = templateById(id);

  if (
    !(await guardUnsaved(
      `You have unsaved changes to ${currentTemplate.filename}. ` +
      `Switch to ${nextTemplate.filename} and discard them?`
    ))
  ) {
    return;
  }

  toggleHistory(false);
  exitVersionPreview(true);

  wb.id = id;
  buildTabs();

  await loadIntoEditor(id);

  if (options.uploadFile) {
    applyUpload(options.uploadFile);
  }

  if (options.history) {
    toggleHistory(true);
  }
}

async function loadIntoEditor(id) {
  const template = templateById(id);

  $("#wb-filename").textContent = template.filename;

  $("#wb-meta").textContent =
    `${template.edition === "color" ? "Color" : "Manga"} edition, ` +
    `${template.side.toLowerCase()} page`;

  setValidation("Loading from Firebase…", "info");
  code().disabled = true;

  let html = "";
  let label = "";
  let exists = false;

  try {
    const saved = await getTemplate(id);

    if (saved) {
      html = saved.html;
      exists = true;
      label = `Saved ${formatDate(saved.updatedAt)}`;
      setValidation("", "");
    } else {
      html = await fetchStarter(id);
      label = "Bundled starter, not saved yet";

      setValidation(
        `${template.filename} is not in Firebase yet. ` +
        "The bundled starter is loaded. Press Save to store it.",
        "warn"
      );
    }
  } catch (error) {
    try {
      html = await fetchStarter(id);
    } catch {
      html = "";
    }

    label = "Bundled starter, Firebase unavailable";

    setValidation(
      `${error.message} The editor shows the bundled starter; ` +
      "saving will fail until the connection works.",
      "err"
    );
  }

  wb.exists = exists;
  wb.baseline = html;
  wb.sourceLabel = label;

  code().value = html;
  code().disabled = false;

  updateIndicators();
  schedulePreview(0);
}

function updateIndicators() {
  const value = code().value;
  const dirty = isDirty();

  $("#wb-count").textContent =
    `${value.length.toLocaleString()} characters ` +
    `(${Math.round(byteLength(value) / 1024)} KB)`;

  const dirtyChip = $("#wb-dirty");

  dirtyChip.textContent = dirty
    ? "Unsaved changes"
    : wb.exists
      ? "Saved"
      : "Not saved yet";

  dirtyChip.className =
    `chip ${
      dirty
        ? "chip-warn"
        : wb.exists
          ? "chip-ok"
          : "chip-warn"
    }`;

  $("#wb-source").textContent = wb.sourceLabel;

  $("#wb-save").disabled =
    wb.saving || (!dirty && wb.exists);
}

function setValidation(text, kind) {
  const element = $("#wb-validation");

  element.textContent = text;
  element.className = `wb-validation ${kind || ""}`;
}

function validateSource(html) {
  const problems = [];
  const notes = [];

  if (!html.trim()) {
    problems.push("The HTML is empty.");
  } else if (!/<[a-z!][^>]*>/i.test(html)) {
    problems.push("This does not look like HTML. Add at least one tag.");
  }

  const bytes = byteLength(html);

  if (bytes > MAX_HTML_BYTES) {
    problems.push(
      `The source is ${Math.round(bytes / 1024)} KB; ` +
      `the limit is ${Math.round(MAX_HTML_BYTES / 1024)} KB ` +
      "(Firestore document size)."
    );
  }

  if (!/<!doctype html/i.test(html)) {
    notes.push("No <!doctype html> found.");
  }

  if (/<script[\s>]/i.test(html)) {
    notes.push(
      "Contains <script>: scripts do not run in the preview or the PDF."
    );
  }

  if (
    /(src|href)=["']https?:/i.test(html) ||
    /url\(\s*["']?https?:/i.test(html)
  ) {
    notes.push(
      "Uses external resources: they must allow cross-origin access to appear in the PDF."
    );
  }

  return { problems, notes };
}

function schedulePreview(delay = 250) {
  clearTimeout(previewTimer);

  previewTimer = setTimeout(() => {
    if (!wb.versionPreview && wbPreview) {
      wbPreview.render(code().value);
    }
  }, delay);
}

code()?.addEventListener("input", () => {
  if (wb.versionPreview) {
    exitVersionPreview(false);
  }

  updateIndicators();
  schedulePreview();

  const { problems, notes } = validateSource(code().value);

  if (problems.length) {
    setValidation(problems.join(" "), "err");
  } else {
    setValidation(
      notes.join(" "),
      notes.length ? "warn" : ""
    );
  }
});

// ------------------------------------------------------------------
// Upload HTML
// ------------------------------------------------------------------

function pickFile(targetId) {
  pendingUploadTarget = targetId;

  const input = $("#file-input");
  input.value = "";
  input.click();
}

$("#file-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  const id = pendingUploadTarget || wb.id;
  pendingUploadTarget = null;

  if (!/\.html?$/i.test(file.name)) {
    showToast(
      `"${file.name}" is not an .html or .htm file.`,
      "err"
    );
    return;
  }

  if (file.size > MAX_HTML_BYTES * 1.2) {
    showToast(
      `"${file.name}" is too large ` +
      `(${Math.round(file.size / 1024)} KB).`,
      "err"
    );
    return;
  }

  let text;

  try {
    text = await file.text();
  } catch {
    showToast(`"${file.name}" could not be read.`, "err");
    return;
  }

  const dialog = $("#workbench");

  if (dialog.open && id === wb.id) {
    applyUpload({ name: file.name, text });
  } else {
    await openWorkbench(id, {
      uploadFile: { name: file.name, text },
    });
  }
});

function applyUpload({ name, text }) {
  const template = templateById(wb.id);

  if (wb.versionPreview) {
    exitVersionPreview(false);
  }

  toggleHistory(false);

  code().value = text.replace(/^\uFEFF/, "");
  wb.sourceLabel = `Uploaded ${name}, not saved`;

  updateIndicators();
  schedulePreview(0);

  const { problems, notes } = validateSource(code().value);

  setValidation(
    problems.length
      ? problems.join(" ")
      : `Loaded ${name} into ${template.filename}. ` +
        `Nothing is saved until you press Save. ${notes.join(" ")}`,
    problems.length ? "err" : "info"
  );
}

$("#wb-upload").addEventListener("click", () => {
  pickFile(wb.id);
});

$("#wb-starter").addEventListener("click", async () => {
  try {
    const html = await fetchStarter(wb.id);

    if (
      isDirty() &&
      !(await confirmAction({
        title: "Replace editor contents?",
        message:
          `Load the bundled starter for ${templateById(wb.id).filename}? ` +
          "Your current edits will be replaced; nothing is saved.",
        confirmLabel: "LOAD STARTER",
      }))
    ) {
      return;
    }

    if (wb.versionPreview) {
      exitVersionPreview(false);
    }

    code().value = html;
    wb.sourceLabel = "Bundled starter, not saved";

    updateIndicators();
    schedulePreview(0);

    setValidation(
      "Starter loaded. Press Save to store it in Firebase.",
      "info"
    );
  } catch (error) {
    setValidation(error.message, "err");
  }
});

$("#wb-download").addEventListener("click", () => {
  const template = templateById(wb.id);

  downloadBlob(
    new Blob([code().value], {
      type: "text/html;charset=utf-8",
    }),
    template.filename
  );
});

// ------------------------------------------------------------------
// Save
// ------------------------------------------------------------------

$("#wb-save").addEventListener("click", async () => {
  if (wb.saving) return;

  const template = templateById(wb.id);
  const html = code().value;
  const { problems } = validateSource(html);

  if (problems.length) {
    setValidation(problems.join(" "), "err");
    return;
  }

  wb.saving = true;
  $("#wb-save").classList.add("loading");
  updateIndicators();

  setValidation(`Saving ${template.filename}…`, "info");

  try {
    await saveTemplate(template.id, template.filename, html);

    const check = await getTemplate(template.id);

    if (!check || check.html !== html) {
      throw new Error(
        "Firestore did not return the saved content. " +
        "The save could not be verified; try again."
      );
    }

    wb.baseline = html;
    wb.exists = true;
    wb.sourceLabel = `Saved ${formatDate(check.updatedAt)}`;

    setValidation(
      `Saved ${template.filename} to Firebase. ` +
      "The previous version was archived if one existed.",
      "ok"
    );

    showToast(`Saved ${template.filename} to Firebase.`, "ok");

    refreshCard(template.id);

    if (wb.historyOpen) {
      renderHistory();
    }
  } catch (error) {
    setValidation(`Save failed. ${error.message}`, "err");

    showToast(
      `Save failed. ${error.message}`,
      "err",
      10000
    );
  } finally {
    wb.saving = false;
    $("#wb-save").classList.remove("loading");
    updateIndicators();
  }
});

async function closeWorkbench() {
  if (
    !(await guardUnsaved(
      "You have unsaved changes. Close the editor and discard them?"
    ))
  ) {
    return;
  }

  toggleHistory(false);
  exitVersionPreview(true);

  $("#workbench").close();
  wb.id = null;
}

$("#wb-cancel").addEventListener("click", closeWorkbench);

$("#workbench").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeWorkbench();
});

window.addEventListener("beforeunload", (event) => {
  if ($("#workbench").open && wb.id && isDirty()) {
    event.preventDefault();
    event.returnValue = "";
  }
});

// ------------------------------------------------------------------
// History and restore
// ------------------------------------------------------------------

function toggleHistory(open) {
  wb.historyOpen = open;

  $("#wb-history-pane").hidden = !open;
  $("#wb-editor-pane").hidden = open;

  $("#wb-history-btn").setAttribute(
    "aria-pressed",
    String(open)
  );

  if (open) {
    renderHistory();
  } else {
    exitVersionPreview(true);
  }
}

$("#wb-history-btn").addEventListener("click", () => {
  toggleHistory(!wb.historyOpen);
});

$("#wb-history-close").addEventListener("click", () => {
  toggleHistory(false);
});

async function renderHistory() {
  const list = $("#wb-history-list");
  const id = wb.id;
  const template = templateById(id);

  list.innerHTML =
    '<li class="history-empty">Loading history…</li>';

  try {
    const rows = await listVersions(id);

    if (id !== wb.id) return;

    if (!rows.length) {
      list.innerHTML =
        `<li class="history-empty">No archived versions yet. ` +
        `The first one appears when ${esc(template.filename)} ` +
        "is replaced by a save or restore.</li>";
      return;
    }

    list.innerHTML = "";

    rows.forEach((version, index) => {
      const item = document.createElement("li");
      item.className = "history-item cut-box";

      const reason =
        version.reason === "replaced-by-restore"
          ? "archived before a restore"
          : "archived by a save";

      item.innerHTML = `
        <div>
          <strong>
            ${esc(formatDate(
              version.originalUpdatedAt || version.savedAt
            ))}
          </strong>

          <span>
            ${esc(reason)} on ${esc(formatDate(version.savedAt))}
            &middot; ${Math.round(byteLength(version.html) / 1024)} KB
            ${index === 0 ? " &middot; most recent archive" : ""}
          </span>
        </div>

        <div class="history-btns">
          <button type="button" class="btn btn-small btn-ghost"
            data-act="preview">PREVIEW</button>

          <button type="button" class="btn btn-small btn-primary"
            data-act="restore">RESTORE</button>
        </div>
      `;

      item
        .querySelector('[data-act="preview"]')
        .addEventListener("click", () => {
          enterVersionPreview(version);
        });

      item
        .querySelector('[data-act="restore"]')
        .addEventListener("click", () => {
          doRestore(version);
        });

      list.appendChild(item);
    });
  } catch (error) {
    list.innerHTML =
      `<li class="history-empty err">${esc(error.message)}</li>`;
  }
}

function enterVersionPreview(version) {
  wb.versionPreview = version;

  const banner = $("#wb-banner");
  banner.hidden = false;

  banner.innerHTML = `
    <span>
      Previewing the version from
      <strong>
        ${esc(formatDate(
          version.originalUpdatedAt || version.savedAt
        ))}
      </strong>.
      The editor is unchanged.
    </span>

    <button type="button" class="btn btn-small btn-ghost"
      id="wb-banner-close">BACK TO EDITOR PREVIEW</button>
  `;

  $("#wb-banner-close").addEventListener("click", () => {
    exitVersionPreview(false);
  });

  wbPreview.render(version.html);
}

function exitVersionPreview(silent) {
  if (!wb.versionPreview) return;

  wb.versionPreview = null;
  $("#wb-banner").hidden = true;

  if (!silent) {
    wbPreview.render(code().value);
  }
}

async function doRestore(version) {
  const template = templateById(wb.id);

  const dirtyNote = isDirty()
    ? " Unsaved edits in the editor will be replaced."
    : "";

  const confirmed = await confirmAction({
    title: `Restore ${template.filename}?`,
    message:
      `Restore the version from ${formatDate(
        version.originalUpdatedAt || version.savedAt
      )}? The current version is archived first, so it can be restored later. ` +
      `Other templates are not affected.${dirtyNote}`,
    confirmLabel: "RESTORE VERSION",
  });

  if (!confirmed) return;

  try {
    await restoreVersion(
      template.id,
      template.filename,
      version.id
    );

    showToast(
      `Restored ${template.filename}. ` +
      "The previous current version is in the history.",
      "ok"
    );

    exitVersionPreview(true);

    await loadIntoEditor(template.id);

    await refreshCard(template.id);
    await renderHistory();
  } catch (error) {
    showToast(
      `Restore failed. ${error.message}`,
      "err",
      10000
    );
  }
}

// ------------------------------------------------------------------
// Header actions: sign-out
// ------------------------------------------------------------------

$("#btn-lock").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;

  try {
    await signOutAdmin();

    lockAdmin();
    location.href = "index.html";
  } catch (error) {
    showToast(
      `Sign-out failed. ${error.message}`,
      "err",
      10000
    );

    button.disabled = false;
  }
});

// ------------------------------------------------------------------
// Export templates as ZIP
// ------------------------------------------------------------------

$("#btn-zip").addEventListener("click", async (event) => {
  const button = event.currentTarget;

  button.disabled = true;
  button.classList.add("loading");

  try {
    const zipUrl =
      "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

    if (!window.JSZip) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");

        script.src = zipUrl;
        script.onload = resolve;

        script.onerror = () => {
          reject(
            new Error(
              "The ZIP library (JSZip) could not be loaded. " +
              "Check your connection."
            )
          );
        };

        document.head.appendChild(script);
      });
    }

    const results = await Promise.allSettled(
      TEMPLATES.map((template) => getTemplate(template.id))
    );

    const failures = [];
    const zip = new window.JSZip();

    results.forEach((result, index) => {
      const template = TEMPLATES[index];

      if (result.status === "rejected") {
        failures.push(
          `${template.filename}: ${result.reason.message}`
        );
      } else if (!result.value) {
        failures.push(
          `${template.filename}: not saved in Firebase yet`
        );
      } else {
        zip.file(template.filename, result.value.html);
      }
    });

    if (failures.length) {
      throw new Error(
        "Export cancelled, so no incomplete ZIP was created. " +
        failures.join(" | ")
      );
    }

    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
    });

    downloadBlob(blob, "epic_card_templates.zip");

    showToast(
      "Exported 4 templates from Firebase as epic_card_templates.zip.",
      "ok"
    );
  } catch (error) {
    showToast(error.message, "err", 12000);
  } finally {
    button.disabled = false;
    button.classList.remove("loading");
  }
});

// ------------------------------------------------------------------
// Initialize missing templates
// ------------------------------------------------------------------

$("#btn-init").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;

  try {
    await refreshAll();

    const missing = TEMPLATES.filter(
      (template) => cards.get(template.id).status === "missing"
    );

    const broken = TEMPLATES.filter(
      (template) => cards.get(template.id).status === "error"
    );

    if (broken.length) {
      const details = broken
        .map((template) => {
          const error =
            cards.get(template.id)?.error || "Unknown error";

          return `${template.filename}: ${error}`;
        })
        .join("\n");

      throw new Error(`Firebase check failed:\n${details}`);
    }

    if (!missing.length) {
      showToast(
        "All four templates already exist in Firebase. Nothing to initialize.",
        "info"
      );
      return;
    }

    const confirmed = await confirmAction({
      title: "Initialize templates",
      message:
        `Save the bundled starter for ${missing
          .map((template) => template.filename)
          .join(", ")} to Firebase? Existing templates are never touched.`,
      confirmLabel: "SAVE STARTERS",
    });

    if (!confirmed) return;

    for (const template of missing) {
      const html = await fetchStarter(template.id);

      await saveTemplate(
        template.id,
        template.filename,
        html
      );
    }

    showToast(
      `Saved ${missing.length} starter template(s) to Firebase.`,
      "ok"
    );

    await refreshAll();
  } catch (error) {
    showToast(error.message, "err", 10000);
  } finally {
    button.disabled = false;
  }
});

// ------------------------------------------------------------------
// Start the admin application
// ------------------------------------------------------------------

start();
