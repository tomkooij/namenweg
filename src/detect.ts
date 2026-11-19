// Automatische detectie van vakken met persoonsgegevens.
//
// Werkwijze:
// 1. OCR (lokaal) zoekt voorgedrukte labels zoals "Naam kandidaat", "Examen no.", "Klas".
// 2. Per label wordt een basisvak bepaald (rechts van het label, en bij nummer/klas ook eronder).
// 3. Het vak groeit mee met de inkt (handschrift, invulhokjes) die het basisvak raakt,
//    begrensd door een maximaal venster rond het label.
// 4. Vindt de OCR niets, dan wordt de pagina gedraaid (90°, 270°, 180°) en opnieuw gezocht.
import type { Box, Rot, Settings } from './types';
import { recognize } from './ocr';
import { uid } from './util';
import { type DetectResult, findLabels, InkMask, mergeBoxes, norm, parsePhrases, regionsFor, unrotate } from './detect-core';

export { norm };
export type { DetectResult };

/**
 * Maak voorgedrukte, lichtgrijze (gerasterde) labels leesbaar voor de OCR:
 * licht vervagen sluit het raster, daarna het contrast oprekken.
 */
export function enhanceForOcr(src: HTMLCanvasElement, dpi: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const radius = (1.5 * dpi) / 200;
  const canFilter = typeof ctx.filter === 'string';
  if (canFilter) ctx.filter = `blur(${radius.toFixed(2)}px)`;
  ctx.drawImage(src, 0, 0);
  ctx.filter = 'none';
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const W = c.width;
  const H = c.height;
  const g = new Uint8ClampedArray(W * H);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  let src2 = g;
  if (!canFilter) {
    // Terugval: 3×3 gemiddelde (browsers zonder canvas-filter)
    src2 = new Uint8ClampedArray(W * H);
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const k = y * W + x;
        src2[k] = (g[k - W - 1] + g[k - W] + g[k - W + 1] + g[k - 1] + g[k] + g[k + 1] + g[k + W - 1] + g[k + W] + g[k + W + 1]) / 9;
      }
  }
  const lo = 120;
  const hi = 240;
  for (let i = 0, j = 0; j < src2.length; i += 4, j++) {
    const v = ((src2[j] - lo) * 255) / (hi - lo);
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function rotateCanvas(src: HTMLCanvasElement, r: Rot): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const W = src.width;
  const H = src.height;
  c.width = r % 180 ? H : W;
  c.height = r % 180 ? W : H;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  if (r === 90) ctx.translate(H, 0);
  else if (r === 180) ctx.translate(W, H);
  else if (r === 270) ctx.translate(0, W);
  ctx.rotate((r * Math.PI) / 180);
  ctx.drawImage(src, 0, 0);
  return c;
}

export async function detectPage(canvas: HTMLCanvasElement, settings: Settings): Promise<DetectResult> {
  const phrases = parsePhrases(settings);
  const W = canvas.width;
  const H = canvas.height;
  const rotations: Rot[] = settings.searchRotated ? [0, 90, 270, 180] : [0];

  for (const r of rotations) {
    const c = r ? rotateCanvas(canvas, r) : canvas;
    const enhanced = enhanceForOcr(c, settings.ocrDpi);
    const words = await recognize(enhanced);
    enhanced.width = enhanced.height = 0;
    const labels = findLabels(words, phrases);
    const personal = labels.filter((l) => l.kind !== 'stop');
    if (!personal.length) {
      if (r) c.width = c.height = 0;
      // Staat er al veel goed leesbare tekst rechtop, dan is de pagina niet gedraaid:
      // verder draaien heeft geen zin (bespaart veel tijd).
      if (r === 0) {
        const confident = words.filter((w) => w.conf >= 85 && norm(w.text).length >= 4).length;
        if (confident >= 12) break;
      }
      continue;
    }
    const mask = new InkMask(c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height), 2);
    const regions = regionsFor(labels, mask, c.width, c.height, settings.padding);
    if (r) c.width = c.height = 0;
    const textRot = ((360 - r) % 360) as Rot;
    let boxes: Box[] = regions.map((g) => {
      const p = unrotate(g.rect, r, W, H);
      const a = unrotate({ x0: g.anchor.x, y0: g.anchor.y, x1: g.anchor.x, y1: g.anchor.y }, r, W, H);
      return {
        id: uid(),
        x: p.x0 / W,
        y: p.y0 / H,
        w: (p.x1 - p.x0) / W,
        h: (p.y1 - p.y0) / H,
        kind: g.kind,
        source: 'auto',
        rot: textRot,
        text: false,
        label: g.label,
        conf: g.conf,
        ax: a.x0 / W,
        ay: a.y0 / H,
      } as Box & { conf: number };
    });
    boxes = mergeBoxes(boxes);
    // Vervangende tekst in het naamvak met het zekerst herkende label.
    const naam = boxes
      .filter((b) => b.kind === 'naam')
      .sort((a, b) => ((b as Box & { conf?: number }).conf ?? 0) - ((a as Box & { conf?: number }).conf ?? 0))[0];
    if (naam) naam.text = true;
    return {
      boxes,
      rotation: r,
      labels: personal.map((l) => l.text),
      note: `${boxes.length} vak(ken) gevonden${r ? ` (pagina ${r}° gedraaid)` : ''}: ${[...new Set(personal.map((l) => l.text))].join(', ')}`,
    };
  }
  return { boxes: [], rotation: 0, labels: [], note: 'Geen labels gevonden' };
}
