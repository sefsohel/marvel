// Template catalogue, loading rules and the shared isolated renderer used by the PDF export and the admin preview.
import { getTemplate } from "./firebase.js";

export const TEMPLATES = [
  { id: "color_front", filename: "color_front.html", edition: "color", side: "Front", purpose: "Color edition, front page", path: "templates/color_front.html" },
  { id: "color_back",  filename: "color_back.html",  edition: "color", side: "Back",  purpose: "Color edition, back page",  path: "templates/color_back.html" },
  { id: "manga_front", filename: "manga_front.html", edition: "manga", side: "Front", purpose: "Manga edition, front page", path: "templates/manga_front.html" },
  { id: "manga_back",  filename: "manga_back.html",  edition: "manga", side: "Back",  purpose: "Manga edition, back page",  path: "templates/manga_back.html" }
];

export const EDITIONS = {
  color: { label: "Color", pdfName: "color_edition.pdf", templates: ["color_front", "color_back"] },
  manga: { label: "Manga", pdfName: "manga_edition.pdf", templates: ["manga_front", "manga_back"] }
};

export const templateById = (id) => TEMPLATES.find((t) => t.id === id);

// ---- Page geometry (CSS px at 96 dpi) ----
export const A4_PX = { w: 794, h: 1123 };          // 210 x 297 mm
export const PAGE_MARGIN_PX = 38;                    // about 10 mm print-safe margin
export const DEFAULT_CARD = { w: 640, h: 960 };      // used when a template has no <meta name="card-size">

/** Bundled starter file (initial fallback / "load starter"). */
export async function fetchStarter(id) {
  const t = templateById(id);
  if (!t) throw new Error(`Unknown template "${id}".`);
  let res;
  try { res = await fetch(t.path, { cache: "no-store" }); }
  catch (err) { throw new Error(`The bundled starter ${t.path} could not be loaded. Serve the site through a local web server (not file://).`); }
  if (!res.ok) throw new Error(`The bundled starter ${t.path} is missing (HTTP ${res.status}).`);
  return res.text();
}

/**
 * Template source for PDF generation: Firestore first, bundled starter as a visible fallback.
 * Returns { html, source: "firestore" | "starter", warning? }.
 */
export async function loadTemplateForPdf(id) {
  const t = templateById(id);
  let reason;
  try {
    const saved = await getTemplate(id);
    if (saved) return { html: saved.html, source: "firestore" };
    reason = `${t.filename} has not been saved to Firebase yet`;
  } catch (err) {
    reason = `${t.filename} could not be loaded from Firebase (${err.message})`;
  }
  try {
    const html = await fetchStarter(id);
    return { html, source: "starter", warning: `${reason}; the bundled starter was used instead.` };
  } catch (err) {
    throw new Error(`${reason}, and the bundled starter is unavailable too. ${err.message}`);
  }
}

/** Reads <meta name="card-size" content="640x960"> from template source. */
export function parseCardSize(html) {
  const m = /<meta[^>]+name=["']card-size["'][^>]*content=["']\s*(\d{2,4})\s*[x×]\s*(\d{2,4})\s*(?:px)?\s*["']/i.exec(html)
        || /<meta[^>]+content=["']\s*(\d{2,4})\s*[x×]\s*(\d{2,4})\s*(?:px)?\s*["'][^>]*name=["']card-size["']/i.exec(html);
  if (!m) return { ...DEFAULT_CARD };
  const w = Math.min(4000, Math.max(100, +m[1])), h = Math.min(4000, Math.max(100, +m[2]));
  return { w, h };
}

/** Scale (never above 1) that fits a card inside the A4 page margins without distortion. */
export function fitScale(w, h) {
  return Math.min(1, (A4_PX.w - 2 * PAGE_MARGIN_PX) / w, (A4_PX.h - 2 * PAGE_MARGIN_PX) / h);
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

/**
 * Creates a script-free iframe (sandbox="allow-same-origin" and no allow-scripts) so uploaded template
 * scripts never run. Resolves once load, fonts and images have settled.
 * Returns { iframe, width, height, brokenImages }.
 */
export async function createRenderFrame(html, { parent = document.body, hidden = true } = {}) {
  const size = parseCardSize(html);
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-same-origin");
  iframe.setAttribute("title", "Template render");
  iframe.setAttribute("scrolling", "no");
  iframe.style.cssText = `width:${size.w}px;height:${size.h}px;border:0;display:block;background:#fff;` +
    (hidden ? "position:fixed;left:-20000px;top:0;opacity:0;pointer-events:none;" : "");
  const loaded = new Promise((resolve, reject) => {
    iframe.addEventListener("load", resolve, { once: true });
    iframe.addEventListener("error", () => reject(new Error("The template could not be rendered.")), { once: true });
  });
  iframe.srcdoc = html;
  parent.appendChild(iframe);
  try {
    await withTimeout(loaded, 20000);
    const doc = iframe.contentDocument;
    if (!doc || !doc.documentElement) throw new Error("The template document is not available.");
    if (doc.fonts && doc.fonts.ready) await withTimeout(doc.fonts.ready, 8000);
    const imgs = Array.from(doc.images || []);
    await withTimeout(Promise.all(imgs.map((img) => (img.complete ? (img.decode ? img.decode().catch(() => {}) : null) : new Promise((r) => { img.onload = img.onerror = r; })))), 12000);
    await new Promise((r) => setTimeout(r, 120));
    const de = doc.documentElement;
    const width = Math.max(size.w, de.scrollWidth), height = Math.max(size.h, de.scrollHeight);
    if (width !== size.w || height !== size.h) { iframe.style.width = width + "px"; iframe.style.height = height + "px"; }
    const brokenImages = imgs.filter((i) => i.complete && i.naturalWidth === 0).length;
    return { iframe, width, height, brokenImages };
  } catch (err) {
    iframe.remove();
    throw err;
  }
}

/**
 * Live A4 preview. host receives a white 210x297 sheet (scaled to the container width) with the
 * template centred on it exactly as the PDF will place it.
 */
export function createA4Preview(host) {
  host.innerHTML = `<div class="a4-wrap"><div class="a4-sheet"><div class="a4-card"></div></div><p class="a4-msg" role="status" hidden></p></div>`;
  const wrap = host.querySelector(".a4-wrap"), sheet = host.querySelector(".a4-sheet");
  const card = host.querySelector(".a4-card"), msg = host.querySelector(".a4-msg");
  let token = 0, current = null;

  const layout = () => {
    const s = wrap.clientWidth / A4_PX.w;
    if (s > 0) { sheet.style.transform = `scale(${s})`; wrap.style.height = `${A4_PX.h * s}px`; }
  };
  const ro = new ResizeObserver(layout); ro.observe(wrap); layout();

  const say = (text) => { msg.textContent = text || ""; msg.hidden = !text; sheet.classList.toggle("is-empty", !!text); };

  async function render(html) {
    const my = ++token;
    card.replaceChildren();
    if (!html || !html.trim()) { say("Nothing to preview yet. Add HTML to see the A4 page."); return; }
    say("");
    try {
      const r = await createRenderFrame(html, { parent: card, hidden: false });
      if (my !== token) { r.iframe.remove(); return; }
      const f = fitScale(r.width, r.height);
      r.iframe.style.position = "absolute";
      r.iframe.style.transformOrigin = "0 0";
      r.iframe.style.left = `${(A4_PX.w - r.width * f) / 2}px`;
      r.iframe.style.top = `${(A4_PX.h - r.height * f) / 2}px`;
      r.iframe.style.transform = `scale(${f})`;
      r.iframe.style.opacity = "1";
      current = r.iframe;
      if (r.brokenImages) say(`${r.brokenImages} image(s) failed to load in the preview.`);
    } catch (err) {
      if (my === token) say(`Preview unavailable: ${err.message}`);
    }
  }
  return { render, destroy() { token++; ro.disconnect(); host.innerHTML = ""; }, get frame() { return current; } };
}
