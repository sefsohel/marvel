// Shared helpers + landing / editions page behaviour.
import { openPasswordDialog, isUnlocked } from "./password-gate.js";

export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function formatDate(d) {
  if (!d) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(d);
}

export function showToast(message, kind = "info", ms = 6000) {
  let region = document.getElementById("toast-region");
  if (!region) { region = document.createElement("div"); region.id = "toast-region"; region.className = "toast-region"; region.setAttribute("aria-live", "polite"); document.body.appendChild(region); }
  const el = document.createElement("div");
  el.className = `toast toast-${kind} cut-box`;
  el.textContent = message;
  region.appendChild(el);
  const kill = () => el.remove();
  el.addEventListener("click", kill);
  if (ms) setTimeout(kill, ms);
  return el;
}

// ---------------- Landing ----------------
function initLanding() {
  const cta = document.getElementById("download-cta");
  cta?.addEventListener("click", (e) => {
    if (reducedMotion() || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    document.body.classList.add("leaving");
    setTimeout(() => { location.href = cta.href; }, 380);
  });
  document.getElementById("settings-btn")?.addEventListener("click", () => {
    if (isUnlocked()) { location.href = "settings.html"; return; }
    openPasswordDialog({ onSuccess: () => { location.href = "settings.html"; }, onCancel: () => document.getElementById("settings-btn")?.focus() });
  });
}

// ---------------- Editions ----------------
function initEditions() {
  const buttons = Array.from(document.querySelectorAll("[data-edition]"));
  let busy = false;

  const setStatus = (panel, text, kind) => {
    const el = panel.querySelector(".status");
    el.textContent = text || ""; el.className = `status${kind ? " " + kind : ""}`;
  };

  buttons.forEach((btn) => btn.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    const panel = btn.closest(".panel");
    buttons.forEach((b) => { b.disabled = true; });
    btn.classList.add("loading"); btn.setAttribute("aria-busy", "true");
    buttons.forEach((b) => { if (b !== btn) setStatus(b.closest(".panel"), ""); });
    setStatus(panel, "Starting…", "progress");
    try {
      const { generateEditionPdf } = await import("./pdf-generator.js");
      const res = await generateEditionPdf(btn.dataset.edition, (m) => setStatus(panel, m, "progress"));
      const warn = res.warnings.length ? ` Note: ${res.warnings.join(" ")}` : "";
      setStatus(panel, `Downloaded ${res.filename} (${res.pages} A4 pages, ${(res.bytes / 1048576).toFixed(1)} MB).${warn}`, res.warnings.length ? "warn" : "ok");
    } catch (err) {
      console.error(err);
      setStatus(panel, `Download failed. ${err.message}`, "err");
    } finally {
      busy = false;
      buttons.forEach((b) => { b.disabled = false; });
      btn.classList.remove("loading"); btn.removeAttribute("aria-busy");
    }
  }));
}

const page = document.body && document.body.dataset.page;
if (page === "landing") initLanding();
if (page === "editions") initEditions();
