// Inlezen en renderen van PDF's en afbeeldingen. Alles gebeurt in het geheugen van de browser.
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export const assetUrl = (p: string) => new URL(import.meta.env.BASE_URL + p, location.href).href;

const pdfOptions = () => ({
  isEvalSupported: false,
  wasmUrl: assetUrl('pdfjs/wasm/'),
  iccUrl: assetUrl('pdfjs/iccs/'),
  cMapUrl: assetUrl('pdfjs/cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: assetUrl('pdfjs/standard_fonts/'),
  // Geen externe verbindingen; geen JavaScript uit de PDF uitvoeren.
  enableXfa: false,
});

export interface Source {
  numPages: number;
  /** Paginaformaat in punten (na rotatie). */
  sizes: { w: number; h: number }[];
  /** `display` = voor op het scherm; anders 'print'-modus, die ook in een verborgen tabblad doorloopt. */
  render(index: number, dpi: number, display?: boolean): Promise<HTMLCanvasElement>;
  destroy(): void;
}

export async function openPdfBytes(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({ data: bytes, ...pdfOptions() }).promise;
}

async function openPdf(file: File): Promise<Source> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await openPdfBytes(bytes);
  const sizes: { w: number; h: number }[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    sizes.push({ w: vp.width, h: vp.height });
  }
  return {
    numPages: pdf.numPages,
    sizes,
    async render(index, dpi, display = false) {
      const page = await pdf.getPage(index + 1);
      const vp = page.getViewport({ scale: dpi / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(vp.width));
      canvas.height = Math.max(1, Math.round(vp.height));
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // 'print' gebruikt geen requestAnimationFrame: werkt ook als het tabblad op de achtergrond staat.
      await page.render({ canvas, canvasContext: ctx, viewport: vp, intent: display ? 'display' : 'print', annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
      page.cleanup();
      return canvas;
    },
    destroy() {
      pdf.loadingTask.destroy();
    },
  };
}

/** Losse afbeeldingen (JPG/PNG) worden behandeld als PDF met één pagina. Aanname: 200 dpi. */
async function openImage(file: File): Promise<Source> {
  const bmp = await createImageBitmap(file);
  const assumedDpi = 200;
  const w = (bmp.width * 72) / assumedDpi;
  const h = (bmp.height * 72) / assumedDpi;
  return {
    numPages: 1,
    sizes: [{ w, h }],
    async render(_i, dpi) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round((w * dpi) / 72));
      canvas.height = Math.max(1, Math.round((h * dpi) / 72));
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      return canvas;
    },
    destroy() {
      bmp.close();
    },
  };
}

export function isSupported(file: File) {
  return /\.(pdf|png|jpe?g|webp|bmp|gif|tiff?)$/i.test(file.name) || /^(application\/pdf|image\/)/.test(file.type);
}

export async function openFile(file: File): Promise<Source> {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return openPdf(file);
  return openImage(file);
}

/** Maak een canvas vrij (helpt de browser met geheugen). */
export function release(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
}
