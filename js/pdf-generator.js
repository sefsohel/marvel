// Client-side PDF generation: template HTML -> isolated iframe -> html2canvas -> centred on an A4 canvas -> jsPDF.
// Result: ONE PDF per edition with exactly two A4 portrait pages (front, then back).
import { EDITIONS, templateById, loadTemplateForPdf, createRenderFrame, A4_PX, PAGE_MARGIN_PX, fitScale } from "./templates.js";
import { downloadBlob } from "./app.js";

const LIBS = {
  html2canvas: "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",
  jspdf: "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"
};
const RENDER_SCALE = 2;                               // 2x for sharp output
const PAGE_CANVAS = { w: A4_PX.w * RENDER_SCALE, h: Math.round(A4_PX.w * RENDER_SCALE * 297 / 210) };

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-lib="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src; s.async = true; s.dataset.lib = src;
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error(`A PDF library failed to load (${src.split("/")[5] || src}). Check your internet connection.`)); };
    document.head.appendChild(s);
  });
}

async function ensureLibs() {
  await Promise.all([loadScript(LIBS.html2canvas), loadScript(LIBS.jspdf)]);
  if (!window.html2canvas) throw new Error("html2canvas did not initialise.");
  if (!window.jspdf || !window.jspdf.jsPDF) throw new Error("jsPDF did not initialise.");
}

function looksBlank(canvas) {
  const c = document.createElement("canvas"); c.width = 24; c.height = 36;
  const g = c.getContext("2d"); g.drawImage(canvas, 0, 0, 24, 36);
  const d = g.getImageData(0, 0, 24, 36).data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) { const v = d[i] + d[i + 1] + d[i + 2]; if (v < min) min = v; if (v > max) max = v; }
  return max - min < 12;
}

/** Renders template source to a full A4 canvas with the card centred (and shrunk only if it would not fit). */
async function renderPageCanvas(html, label) {
  const frame = await createRenderFrame(html);
  try {
    const doc = frame.iframe.contentDocument;
    const cardCanvas = await window.html2canvas(doc.documentElement, {
      scale: RENDER_SCALE, useCORS: true, allowTaint: false, backgroundColor: null,
      width: frame.width, height: frame.height, windowWidth: frame.width, windowHeight: frame.height,
      x: 0, y: 0, scrollX: 0, scrollY: 0, logging: false
    });
    if (!cardCanvas.width || !cardCanvas.height) throw new Error(`${label} rendered with zero size.`);
    const page = document.createElement("canvas");
    page.width = PAGE_CANVAS.w; page.height = PAGE_CANVAS.h;
    const g = page.getContext("2d");
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, page.width, page.height);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    const f = fitScale(frame.width, frame.height);             // same rule as the admin preview
    const dw = cardCanvas.width * f, dh = cardCanvas.height * f;
    g.drawImage(cardCanvas, (page.width - dw) / 2, (page.height - dh) / 2, dw, dh);
    return { canvas: page, blank: looksBlank(cardCanvas), brokenImages: frame.brokenImages };
  } finally {
    frame.iframe.remove();
  }
}

/**
 * Generates and downloads one edition PDF.
 * @returns {{filename, pages, warnings: string[]}}
 */
export async function generateEditionPdf(editionKey, onProgress = () => {}) {
  const edition = EDITIONS[editionKey];
  if (!edition) throw new Error(`Unknown edition "${editionKey}".`);
  const warnings = [];

  onProgress("Loading PDF libraries…");
  await ensureLibs();
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });

  for (let i = 0; i < edition.templates.length; i++) {
    const t = templateById(edition.templates[i]);
    onProgress(`Fetching ${t.filename} (${i + 1}/${edition.templates.length})…`);
    const src = await loadTemplateForPdf(t.id);
    if (src.warning) warnings.push(src.warning);
    onProgress(`Rendering ${t.filename}…`);
    let page;
    try { page = await renderPageCanvas(src.html, t.filename); }
    catch (err) { throw new Error(`Could not render ${t.filename}: ${err.message}`); }
    if (page.blank) warnings.push(`${t.filename} looks blank in the render. Check its HTML.`);
    if (page.brokenImages) warnings.push(`${page.brokenImages} image(s) in ${t.filename} failed to load and are missing from the PDF.`);
    if (i > 0) pdf.addPage("a4", "portrait");
    pdf.addImage(page.canvas.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, 210, 297, undefined, "FAST");
  }

  // Self-check before delivering: page count, order is fixed by the loop, A4 portrait size.
  const n = pdf.getNumberOfPages();
  const w = pdf.internal.pageSize.getWidth(), h = pdf.internal.pageSize.getHeight();
  if (n !== edition.templates.length) throw new Error(`The PDF has ${n} pages instead of ${edition.templates.length}.`);
  if (Math.abs(w - 210) > 0.5 || Math.abs(h - 297) > 0.5) throw new Error(`The PDF page size is ${w.toFixed(1)} x ${h.toFixed(1)} mm instead of A4 portrait.`);

  onProgress("Preparing download…");
  const blob = pdf.output("blob");
  if (!blob || blob.size < 1000) throw new Error("The PDF file came out empty.");
  downloadBlob(blob, edition.pdfName);
  return { filename: edition.pdfName, pages: n, warnings, bytes: blob.size };
}
