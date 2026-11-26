// Automatische detectie van vakken met persoonsgegevens.
//
// Werkwijze:
// 1. OCR (lokaal) zoekt voorgedrukte labels zoals "Naam kandidaat", "Examen no.", "Klas".
// 2. Per label wordt een basisvak bepaald (rechts van het label, en bij nummer/klas ook eronder).
// 3. Het vak groeit mee met de inkt (handschrift, invulhokjes) die het basisvak raakt,
//    begrensd door een maximaal venster rond het label.
// 4. Vindt de OCR niets, dan wordt de pagina gedraaid (90°, 270°, 180°) en opnieuw gezocht.
import type { Box, Rot, Settings } from './types';
import { recognize, type OcrWord } from './ocr';
import { rotateCanvas } from './pdfio';
import { uid } from './util';
import { type DetectResult, findKop, findMarkerSquares, findNameWords, findLabels, kopStrip, kopWords, markerFields, InkMask, mergeBoxes, norm, parsePhrases, printedAnchors, printedWords, regionsFor, unrotate } from './detect-core';

export { norm };
export type { DetectResult };

/**
 * Maak voorgedrukte, lichtgrijze (gerasterde) labels leesbaar voor de OCR:
 * licht vervagen sluit het raster, daarna het contrast oprekken.
 */
/** Kopie van het canvas waarin gekleurde inkt (blauwe/rode pen) wit is gemaakt. */
function dropColoredInk(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    if (b - Math.max(r, g) > 22 || r - Math.max(g, b) > 40 || g - Math.max(r, b) > 40) d[i] = d[i + 1] = d[i + 2] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

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


/**
 * Detectie van één pagina: geprinte markeringen (vorm, zonder OCR) en labels (OCR). Een vak
 * tussen markeringen is exact; vakken van labels die erbinnen vallen, vervallen.
 */
export async function detectPage(canvas: HTMLCanvasElement, settings: Settings, names: string[] = [], only?: Rot[]): Promise<DetectResult> {
  const W = canvas.width;
  const H = canvas.height;
  let marks: Box[] = [];
  if (settings.detectMarkers) {
    const img = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H);
    // Iets marge: de vierkantjes zelf en een paar pixels eromheen verdwijnen ook.
    const pad = (0.6 * settings.ocrDpi) / 25.4;
    // Van boven naar beneden: de vervangende tekst komt in het bovenste veld.
    marks = markerFields(findMarkerSquares(img, settings.ocrDpi))
      .sort((a, b) => a.rect.y0 - b.rect.y0 || a.rect.x0 - b.rect.x0)
      .map((f, i) => {
        const x0 = Math.max(0, f.rect.x0 - pad);
        const y0 = Math.max(0, f.rect.y0 - pad);
        const x1 = Math.min(W, f.rect.x1 + pad);
        const y1 = Math.min(H, f.rect.y1 + pad);
        return {
          id: uid(),
          x: x0 / W,
          y: y0 / H,
          w: (x1 - x0) / W,
          h: (y1 - y0) / H,
          kind: 'naam',
          source: 'auto',
          rot: f.vertical ? 90 : 0,
          text: i === 0,
          label: 'markering',
          ax: x0 / W,
          ay: y0 / H,
        } as Box;
      });
  }
  // Eerst het logo: een snelle OCR-ronde op alleen de bovenste kwart van de pagina, onbewerkt
  // (de voorbewerking laat de lichtgrijze logotekst op ruitjes- of lijntjespapier verdwijnen).
  let kop: DetectResult['kop'];
  const kw = kopWords(settings);
  // Alleen in de rechtop-ronde (niet in de achtergrondronde voor gedraaide pagina's).
  if (kw.length && (!only || only.includes(0))) {
    const top = document.createElement('canvas');
    top.width = W;
    top.height = Math.round(H * 0.25);
    top.getContext('2d')!.drawImage(canvas, 0, 0);
    const k = findKop(await recognize(top), kw, W, top.height);
    top.width = top.height = 0;
    if (k) kop = { x: k.x, y: (k.y * Math.round(H * 0.25)) / H, w: k.w, h: (k.h * Math.round(H * 0.25)) / H };
  }
  const res0 = await detectLabels(canvas, settings, names, only, marks.length > 0 || !!kop);
  const res = { ...res0, kop: kop ?? res0.kop };
  if (settings.kopStrook && res.kop) {
    const r = kopStrip(res.kop, W, H, res.boxes);
    if (r)
      marks.unshift({
        id: uid(),
        x: r.x0 / W,
        y: r.y0 / H,
        w: (r.x1 - r.x0) / W,
        h: (r.y1 - r.y0) / H,
        kind: 'naam',
        source: 'auto',
        rot: 0,
        text: true,
        label: 'kopstrook',
        ax: r.x0 / W,
        ay: r.y0 / H,
      } as Box);
    marks.forEach((m, i) => (m.text = i === 0));
  }
  if (!marks.length) return res;
  const inside = (b: Box) =>
    marks.some((m) => {
      const ix = Math.max(0, Math.min(b.x + b.w, m.x + m.w) - Math.max(b.x, m.x));
      const iy = Math.max(0, Math.min(b.y + b.h, m.y + m.h) - Math.max(b.y, m.y));
      return ix * iy >= 0.5 * b.w * b.h;
    });
  const rest = res.boxes.filter((b) => !inside(b)).map((b) => ({ ...b, text: false }));
  return {
    ...res,
    upright: res.upright || res.rotation === 0,
    boxes: [...marks, ...rest],
    note:
      [
        marks.some((m) => m.label === 'kopstrook') ? 'bovenkant weg (logo)' : '',
        marks.filter((m) => m.label === 'markering').length ? `${marks.filter((m) => m.label === 'markering').length} naamveld(en) met markeringen` : '',
      ]
        .filter(Boolean)
        .join(', ') + (rest.length ? `; ${res.note}` : ''),
  };
}

async function detectLabels(canvas: HTMLCanvasElement, settings: Settings, names: string[], only: Rot[] | undefined, hasMarks: boolean): Promise<DetectResult> {
  const phrases = parsePhrases(settings);
  const W = canvas.width;
  const H = canvas.height;
  const rotations: Rot[] = only ?? (settings.searchRotated ? [0, 90, 270, 180] : [0]);
  let upright = false;
  let words0: OcrWord[] = [];

  /** Losse naamwoorden (bestandsnaam / namenlijst) die buiten de gevonden vakken staan. */
  const nameBoxes = (words: OcrWord[], r: Rot, existing: Box[]): Box[] => {
    if (!names.length) return [];
    const cw = r % 180 ? H : W;
    const ch = r % 180 ? W : H;
    const out: Box[] = [];
    for (const f of findNameWords(words, names)) {
      const rc = { x0: Math.max(0, f.rect.x0), y0: Math.max(0, f.rect.y0), x1: Math.min(cw, f.rect.x1), y1: Math.min(ch, f.rect.y1) };
      const p = unrotate(rc, r, W, H);
      const b: Box = {
        id: uid(),
        x: p.x0 / W,
        y: p.y0 / H,
        w: (p.x1 - p.x0) / W,
        h: (p.y1 - p.y0) / H,
        kind: 'naam',
        source: 'auto',
        rot: ((360 - r) % 360) as Rot,
        text: false,
        label: `gezochte naam ("${f.text}")`,
      };
      // Valt het woord grotendeels (≥ 60%) in een bestaand vak, dan is het al afgedekt.
      const covered = [...existing, ...out].some((e) => {
        const ix = Math.max(0, Math.min(b.x + b.w, e.x + e.w) - Math.max(b.x, e.x));
        const iy = Math.max(0, Math.min(b.y + b.h, e.y + e.h) - Math.max(b.y, e.y));
        return ix * iy >= 0.6 * b.w * b.h;
      });
      if (!covered) out.push(b);
    }
    return out;
  };

  for (const r of rotations) {
    const c = r ? rotateCanvas(canvas, r) : canvas;
    const enhanced = enhanceForOcr(c, settings.ocrDpi);
    const words = await recognize(enhanced);
    enhanced.width = enhanced.height = 0;
    if (r === 0) words0 = words;
    let labels = findLabels(words, phrases);
    // Andere labels gevonden maar geen naamlabel? Dan stoort het handschrift ernaast vaak de
    // OCR. Tweede ronde zonder gekleurde inkt, alleen om labels te vinden: eerst op het
    // onbewerkte beeld (het vervagen van enhanceForOcr laat handschrift dat tegen het label aan
    // staat ermee versmelten), en alleen als dat niets oplevert ook voorbewerkt (lichtgrijze,
    // gerasterde labels).
    if (labels.length && !labels.some((l) => l.kind === 'naam')) {
      const clean = dropColoredInk(c);
      const addNew = (found: typeof labels) =>
        found.filter((l) => !labels.some((o) => o.kind === l.kind && Math.abs(o.x0 - l.x0) < 3 * (l.y1 - l.y0) && Math.abs(o.y0 - l.y0) < 2 * (l.y1 - l.y0)));
      labels = [...labels, ...addNew(findLabels(await recognize(clean), phrases))];
      if (!labels.some((l) => l.kind === 'naam')) {
        const enh2 = enhanceForOcr(clean, settings.ocrDpi);
        labels = [...labels, ...addNew(findLabels(await recognize(enh2), phrases))];
        enh2.width = enh2.height = 0;
      }
      clean.width = clean.height = 0;
    }
    const personal = labels.filter((l) => l.kind !== 'stop');
    if (!personal.length) {
      if (r) c.width = c.height = 0;
      // Staat er al veel goed leesbare tekst rechtop, dan is de pagina niet gedraaid:
      // verder draaien heeft geen zin (bespaart veel tijd).
      if (r === 0) {
        // Markeringen gevonden: de pagina staat goed genoeg; niet gedraaid zoeken.
        if (hasMarks) {
          upright = true;
          break;
        }
        const confident = words.filter((w) => w.conf >= 85 && norm(w.text).length >= 4).length;
        if (confident >= 12) {
          upright = true;
          break;
        }
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
    const extra = nameBoxes(words, r, boxes);
    boxes = [...boxes, ...extra];
    return {
      upright: r === 0,
      printed: r === 0 ? printedWords(words0) : undefined,
      printedPos: r === 0 ? printedAnchors(words0, W, H) : undefined,
      kop: r === 0 ? findKop(words0, kopWords(settings), W, H) : undefined,
      boxes,
      rotation: r,
      labels: personal.map((l) => l.text),
      note:
        `${boxes.length} vak(ken) gevonden${r ? ` (pagina ${r}° gedraaid)` : ''}: ${[...new Set(personal.map((l) => l.text))].join(', ')}` +
        (extra.length ? ` + ${extra.length}× naam elders op de pagina` : ''),
    };
  }
  const extra = nameBoxes(words0, 0, []);
  // Losse naamtreffers krijgen geen vervangende tekst: die hoort bij een echt naamvak.
  if (extra.length) {
    return { upright, printed: printedWords(words0), printedPos: printedAnchors(words0, W, H), kop: findKop(words0, kopWords(settings), W, H), boxes: extra, rotation: 0, labels: [], note: `Geen labels, wel ${extra.length}× een gezochte naam gevonden` };
  }
  return { upright, printed: printedWords(words0), printedPos: printedAnchors(words0, W, H), kop: findKop(words0, kopWords(settings), W, H), boxes: [], rotation: 0, labels: [], note: 'Geen labels gevonden' };
}
