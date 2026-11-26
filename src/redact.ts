// Echte verwijdering: elke pagina wordt opnieuw opgebouwd als nieuwe afbeelding waarin de
// pixels van de persoonsgegevens zijn overschreven. De nieuwe PDF bevat ALLEEN die
// afbeeldingen: geen originele beeldlagen, geen tekstlaag, geen metadata, geen bestandsnaam.
import { PDFDocument } from 'pdf-lib';
import type { Box, PageState, Rect, Settings } from './types';
import type { Source } from './pdfio';
import { openPdfBytes, readOutline, release } from './pdfio';
import { addOutline, type OutlineEntry } from './outline';
import { OPS, type PDFDocumentProxy } from 'pdfjs-dist';

export function drawFittedText(ctx: CanvasRenderingContext2D, text: string, b: { x: number; y: number; w: number; h: number }, rot: number, color: string) {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const along = rot % 180 ? b.h : b.w;
  const across = rot % 180 ? b.w : b.h;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((rot * Math.PI) / 180);
  let size = Math.max(6, across * 0.55);
  const family = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  ctx.font = `600 ${size}px ${family}`;
  const maxW = along * 0.92;
  const m = ctx.measureText(text).width;
  if (m > maxW) {
    size = Math.max(5, (size * maxW) / m);
    ctx.font = `600 ${size}px ${family}`;
  }
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  // Links uitlijnen in leesrichting, zoals iemand een naam zou schrijven.
  const tw = ctx.measureText(text).width;
  const startX = -along / 2 + Math.min(along * 0.04 + size * 0.2, (along - tw) / 2);
  ctx.fillText(text, startX, 0);
  ctx.restore();
}

export function applyRedactions(canvas: HTMLCanvasElement, boxes: Box[], text: string | null, s: Settings) {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  const fill = s.fill === 'zwart' ? '#000' : '#fff';
  const fg = s.fill === 'zwart' ? '#fff' : s.textColor;
  for (const b of boxes) {
    const r = { x: Math.floor(b.x * W), y: Math.floor(b.y * H), w: Math.ceil(b.w * W) + 1, h: Math.ceil(b.h * H) + 1 };
    ctx.fillStyle = fill;
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  if (text) {
    for (const b of boxes) {
      if (!b.text) continue;
      drawFittedText(ctx, text, { x: b.x * W, y: b.y * H, w: b.w * W, h: b.h * H }, b.rot, fg);
    }
    if (s.stampEveryPage) {
      const size = Math.round(Math.min(W, H) * 0.018);
      const padX = size * 1.2;
      const padY = size * 1.2;
      const family = '"Segoe UI", Roboto, Arial, sans-serif';
      ctx.font = `600 ${size}px ${family}`;
      const tw = ctx.measureText(text).width;
      const left = s.stampPosition.includes('links');
      const top = s.stampPosition.includes('boven');
      const x = left ? padX : W - padX - tw;
      const y = top ? padY : H - padY - size;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillRect(x - size * 0.4, y - size * 0.3, tw + size * 0.8, size * 1.6);
      ctx.fillStyle = s.textColor;
      ctx.textBaseline = 'top';
      ctx.fillText(text, x, y);
    }
  }
}

function toGray(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

function canvasToJpeg(canvas: HTMLCanvasElement, q: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error('JPEG maken mislukt'))),
      'image/jpeg',
      q,
    ),
  );
}

/** Rendert één pagina met redacties toegepast (voor export en voorbeeldweergave). */
export async function renderRedacted(src: Source, page: PageState, dpi: number, text: string, s: Settings) {
  const canvas = await src.render(page.index, dpi);
  applyRedactions(canvas, page.boxes, text, s);
  if (s.grayscale) toGray(canvas);
  return canvas;
}

export async function exportDocument(
  src: Source,
  pages: PageState[],
  text: string,
  s: Settings,
  progress: (done: number, total: number) => void = () => {},
  targetBytesPerPage = 0,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  let done = 0;
  for (const p of pages) {
    const canvas = await renderRedacted(src, p, s.exportDpi, text, s);
    const jpg = await encodePage(canvas, s, targetBytesPerPage);
    release(canvas);
    const img = await pdf.embedJpg(jpg);
    const page = pdf.addPage([p.wPt, p.hPt]);
    page.drawImage(img, { x: 0, y: 0, width: p.wPt, height: p.hPt });
    progress(++done, pages.length);
  }
  // Bladwijzer: ook na samenvoegen (of in "Snel wissen") is te zien waar deze kandidaat begint.
  addOutline(pdf, [{ title: text, page: 0 }]);
  pdf.setTitle(text);
  pdf.setProducer('NamenWeg');
  pdf.setCreator('NamenWeg');
  return pdf.save({ useObjectStreams: true });
}

/** JPEG van een pagina; bij automatische kwaliteit ongeveer zo groot als het origineel. */
async function encodePage(canvas: HTMLCanvasElement, s: Settings, targetBytesPerPage = 0) {
  if (s.jpegQuality > 0) return canvasToJpeg(canvas, s.jpegQuality);
  const target = targetBytesPerPage ? targetBytesPerPage * 1.25 : Infinity;
  let jpg = await canvasToJpeg(canvas, 0.8);
  for (const q of [0.7, 0.6, 0.5, 0.42]) {
    if (jpg.length <= target) break;
    jpg = await canvasToJpeg(canvas, q);
  }
  return jpg;
}

/** Geëxporteerde toetsen samenvoegen tot één PDF, met een bladwijzer per kandidaat. */
export async function combineDocuments(parts: { bytes: Uint8Array; title: string }[]): Promise<Uint8Array> {
  const out = await PDFDocument.create({ updateMetadata: false });
  const outline: OutlineEntry[] = [];
  for (const { bytes, title } of parts) {
    const d = await PDFDocument.load(bytes);
    outline.push({ title, page: out.getPageCount() });
    const pages = await out.copyPages(d, d.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  addOutline(out, outline);
  out.setTitle('Geanonimiseerde toetsen');
  out.setProducer('NamenWeg');
  out.setCreator('NamenWeg');
  return out.save({ useObjectStreams: true });
}

export interface VerifyResult {
  ok: boolean;
  checks: { ok: boolean; msg: string }[];
}

/**
 * Controleer de uitvoer: opnieuw inlezen, geen tekstlaag, precies één afbeelding per pagina en
 * geen namen of de oorspronkelijke bestandsnaam in de metadata.
 */
export async function verifyOutput(bytes: Uint8Array, forbidden: string[], expectedPages: number): Promise<VerifyResult> {
  const checks: { ok: boolean; msg: string }[] = [];
  const pdf = await openPdfBytes(bytes.slice());
  checks.push({ ok: pdf.numPages === expectedPages, msg: `${pdf.numPages} van ${expectedPages} pagina's` });
  let textItems = 0;
  let badPages = 0;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    textItems += tc.items.length;
    const ops = await page.getOperatorList();
    const imgs = ops.fnArray.filter((f) => f === OPS.paintImageXObject || f === OPS.paintXObject).length;
    if (imgs !== 1) badPages++;
  }
  checks.push({ ok: textItems === 0, msg: textItems === 0 ? 'Geen tekstlaag' : `${textItems} tekstfragmenten gevonden` });
  checks.push({ ok: badPages === 0, msg: badPages === 0 ? 'Elke pagina is één nieuwe afbeelding' : `${badPages} pagina's met afwijkende opbouw` });
  // Metadata (Info + XMP) via pdf.js, dus ook als die gecomprimeerd is opgeslagen. In de
  // beeldgegevens zelf zoeken heeft geen zin (JPEG-bytes kunnen toevallig lijken op tekst).
  const meta = await pdf.getMetadata().catch(() => null);
  const info = (JSON.stringify(meta?.info ?? {}) + ' ' + String(meta?.metadata?.getRaw?.() ?? "")).toLowerCase();
  const hits = forbidden.filter((f) => f.length >= 3 && info.includes(f));
  checks.push({
    ok: hits.length === 0,
    msg: hits.length === 0 ? 'Geen namen of bestandsnaam in de metadata' : `Gevonden in metadata: ${hits.join(', ')}`,
  });
  // Bladwijzers mogen alleen de vervangende tekst bevatten.
  const outline = await readOutline(pdf);
  if (outline.length) {
    const titles = outline.map((o) => o.title.toLowerCase()).join(' ');
    const bad = forbidden.filter((f) => f.length >= 3 && titles.includes(f));
    checks.push({
      ok: bad.length === 0,
      msg: bad.length === 0 ? `Inhoudsopgave: ${outline.length} bladwijzer${outline.length === 1 ? '' : 's'}, zonder namen` : `Gevonden in de inhoudsopgave: ${bad.join(', ')}`,
    });
  }
  await pdf.loadingTask.destroy();
  return { ok: checks.every((c) => c.ok), checks };
}

/** Is deze pagina al "schoon": alleen één afbeelding, geen tekst en geen opmerkingen? */
export async function pageIsClean(pdf: PDFDocumentProxy, index: number) {
  const page = await pdf.getPage(index + 1);
  if ((await page.getTextContent()).items.length) return false;
  if ((await page.getAnnotations()).length) return false;
  const ops = await page.getOperatorList();
  const imgs = ops.fnArray.filter((f) => f === OPS.paintImageXObject || f === OPS.paintXObject || f === OPS.paintInlineImageXObject).length;
  return imgs === 1;
}

/**
 * Snel wissen: alleen pagina's met nieuwe vakken (of die niet "schoon" zijn) worden opnieuw
 * opgebouwd als afbeelding; de andere pagina's gaan ongewijzigd mee. De bladwijzers blijven.
 */
export async function patchPdf(
  bytes: Uint8Array,
  pdf: PDFDocumentProxy,
  src: Source,
  boxes: Rect[][],
  outline: OutlineEntry[],
  s: Settings,
  progress: (done: number, total: number) => void = () => {},
): Promise<{ bytes: Uint8Array; rebuilt: number }> {
  const n = src.numPages;
  let input: PDFDocument | null = null;
  try {
    input = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    input = null; // bijv. versleuteld: dan alles opnieuw opbouwen
  }
  const out = await PDFDocument.create({ updateMetadata: false });
  const target = bytes.length / Math.max(1, n);
  let rebuilt = 0;
  for (let i = 0; i < n; i++) {
    const own = boxes[i] ?? [];
    if (!own.length && input && (await pageIsClean(pdf, i))) {
      const [p] = await out.copyPages(input, [i]);
      out.addPage(p);
    } else {
      const canvas = await src.render(i, s.exportDpi);
      applyRedactions(canvas, own.map((r) => ({ ...r, id: '', kind: 'handmatig', source: 'handmatig', rot: 0, text: false })), null, s);
      if (s.grayscale) toGray(canvas);
      const jpg = await encodePage(canvas, s, target);
      release(canvas);
      const img = await out.embedJpg(jpg);
      const { w, h } = src.sizes[i];
      out.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
      rebuilt++;
    }
    progress(i + 1, n);
  }
  addOutline(out, outline);
  out.setTitle(outline.length === 1 ? outline[0].title : 'Geanonimiseerde toetsen');
  out.setProducer('NamenWeg');
  out.setCreator('NamenWeg');
  return { bytes: await out.save({ useObjectStreams: true }), rebuilt };
}
