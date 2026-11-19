import { describe, expect, it } from 'vitest';
import {
  completeFromPeers,
  findLabels,
  findNameWords,
  InkMask,
  nameTokensFromFileName,
  norm,
  parsePhrases,
  refineWithInk,
  regionsFor,
  unrotate,
  type OcrWord,
  type PeerPage,
} from '../../src/detect-core';
import { DEFAULT_SETTINGS, type Box } from '../../src/types';

const S = DEFAULT_SETTINGS;
const phrases = parsePhrases(S);

/** Hulpje: een regel OCR-woorden met vaste hoogte. */
function line(n: number, y: number, ...ws: [string, number, number?][]): OcrWord[] {
  return ws.map(([text, x, conf = 95]) => ({ text, conf, x0: x, y0: y, x1: x + text.length * 10, y1: y + 20, line: n }));
}

/** Wit RGBA-beeld met zwarte rechthoeken ("inkt"). */
function image(W: number, H: number, rects: [number, number, number, number][]) {
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  for (const [x0, y0, x1, y1] of rects)
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
  return { data, width: W, height: H };
}

describe('norm', () => {
  it('maakt kleine letters, verwijdert leestekens en accenten', () => {
    expect(norm('Naam:')).toBe('naam');
    expect(norm('Élève')).toBe('eleve');
  });
  it('corrigeert de OCR-verwarring rn → m', () => {
    expect(norm('Naarn')).toBe('naam');
  });
});

describe('findLabels', () => {
  it('vindt "Naam kandidaat:" en "Examen no." als labels', () => {
    const words = [...line(1, 100, ['Naam', 100], ['kandidaat:', 150]), ...line(2, 160, ['Examen', 100], ['no.', 170])];
    const labels = findLabels(words, phrases);
    expect(labels.map((l) => [l.kind, l.text])).toEqual([
      ['naam', 'Naam kandidaat:'],
      ['nummer', 'Examen no.'],
    ]);
  });

  it('ziet "naam" in lopende tekst niet als label', () => {
    const words = line(1, 100, ['Geef', 100], ['de', 145], ['naam', 170], ['van', 215], ['de', 250], ['stof', 275]);
    expect(findLabels(words, phrases).filter((l) => l.kind !== 'stop')).toEqual([]);
  });

  it('accepteert kleine OCR-fouten alleen bij voldoende zekerheid', () => {
    expect(findLabels(line(1, 100, ['Examer', 100, 90]), phrases)[0]?.kind).toBe('nummer');
    expect(findLabels(line(1, 100, ['Examer', 100, 30]), phrases)).toEqual([]);
    // "nam!" en "Ame" zijn géén naam
    expect(findLabels(line(1, 100, ['nam!', 100, 90]), phrases)).toEqual([]);
    expect(findLabels(line(1, 100, ['Ame', 100, 90]), phrases)).toEqual([]);
  });

  it('laat "Examen" niet als stoplabel "Examenvak" tellen', () => {
    const l = findLabels(line(1, 100, ['Examen', 100]), phrases);
    expect(l[0].kind).toBe('nummer');
  });

  it('trekt een afgekapt label door tot de volle lengte', () => {
    const [l] = findLabels(line(1, 100, ['kandid', 100]), phrases);
    expect(l.kind).toBe('naam');
    expect(l.x1).toBeGreaterThan(160);
  });
});

describe('regionsFor', () => {
  it('neemt het handschrift rechts van het naamlabel mee, ook over woordgaten', () => {
    const W = 1200;
    const H = 300;
    // label op y 100-120, x 100-250; naam in twee woorden met gat
    const img = image(W, H, [
      [270, 90, 400, 125],
      [440, 92, 600, 128],
    ]);
    const labels = findLabels(line(1, 100, ['Naam:', 100]), phrases);
    const mask = new InkMask(img, 2);
    const [r] = regionsFor(labels, mask, W, H, 0.3);
    expect(r.kind).toBe('naam');
    expect(r.rect.x0).toBeLessThanOrEqual(270);
    expect(r.rect.x1).toBeGreaterThanOrEqual(600);
    expect(r.rect.y0).toBeLessThanOrEqual(90);
    expect(r.rect.y1).toBeGreaterThanOrEqual(128);
  });

  it('pakt bij een nummer het ingevulde hokje onder het label', () => {
    const W = 800;
    const H = 300;
    const img = image(W, H, [
      [110, 140, 150, 180], // cijfers in het hokje
    ]);
    const words = [...line(1, 100, ['Examen', 100], ['no.', 170]), ...line(1, 100, ['Examenvak:', 240])];
    const labels = findLabels(words, phrases);
    const regs = regionsFor(labels, new InkMask(img, 2), W, H, 0.3);
    const nr = regs.find((g) => g.kind === 'nummer')!;
    expect(nr.rect.y0).toBeGreaterThan(110);
    expect(nr.rect.x0).toBeLessThanOrEqual(110);
    expect(nr.rect.y1).toBeGreaterThanOrEqual(180);
  });
});

describe('unrotate', () => {
  it('rekent rechthoeken uit een gedraaid beeld terug', () => {
    const W = 200;
    const H = 100;
    // 90° gedraaid beeld is 100 × 200; punt (10..20, 30..40) daarin
    const r = unrotate({ x0: 10, y0: 30, x1: 20, y1: 40 }, 90, W, H);
    expect(r).toEqual({ x0: 30, x1: 40, y0: 80, y1: 90 });
    const r2 = unrotate(unrotate({ x0: 10, y0: 30, x1: 20, y1: 40 }, 180, W, H), 180, W, H);
    expect(r2).toEqual({ x0: 10, y0: 30, x1: 20, y1: 40 });
  });
});

describe('namen uit bestandsnaam', () => {
  it('haalt bruikbare naamwoorden uit een bestandsnaam', () => {
    expect(nameTokensFromFileName('jansen piet.pdf', S)).toEqual(['jansen', 'piet']);
    expect(nameTokensFromFileName('berg lotte van den.pdf', S)).toEqual(['berg', 'lotte']);
    expect(nameTokensFromFileName('scan_0012 toets natuurkunde.pdf', S)).toEqual([]);
  });
  it('vindt die woorden met kleine OCR-fouten', () => {
    const hits = findNameWords(line(1, 100, ['Bakkes', 100, 80], ['zout', 200, 95]), ['bakker', 'pieter']);
    expect(hits.map((h) => h.text)).toEqual(['Bakkes']);
  });
});

describe('completeFromPeers', () => {
  const box = (kind: Box['kind'], x: number, y: number, label = 'x'): Box => ({ id: kind + x, x, y, w: 0.05, h: 0.03, kind, source: 'auto', rot: 0, text: false, label, ax: x - 0.02, ay: y });
  const pg = (...boxes: Box[]): PeerPage => ({ wPt: 1190, hPt: 842, boxes });

  it('vult een gemist nummervak aan op basis van andere pagina’s', () => {
    const a = pg(box('naam', 0.59, 0.06, 'Naam kandidaat'), box('nummer', 0.54, 0.11, 'Examen no'));
    const b = pg(box('naam', 0.59, 0.065, 'Naam kandidaat'), box('nummer', 0.54, 0.115, 'Examen no'));
    const q = pg(box('naam', 0.59, 0.062, 'Naam kandidaat'));
    const adds = completeFromPeers([a, b, q]);
    expect(adds).toHaveLength(1);
    expect(adds[0].page).toBe(q);
    expect(adds[0].box.kind).toBe('nummer');
    expect(adds[0].box.y).toBeGreaterThan(0.1);
  });

  it('vult geen soort aan die al op de pagina staat', () => {
    const a = pg(box('naam', 0.59, 0.06), box('klas', 0.8, 0.06));
    const b = pg(box('naam', 0.59, 0.06), box('klas', 0.85, 0.06));
    expect(completeFromPeers([a, b])).toHaveLength(0);
  });

  it('negeert pagina’s met een ander formaat', () => {
    const a = pg(box('naam', 0.59, 0.06), box('nummer', 0.54, 0.11));
    const q: PeerPage = { wPt: 595, hPt: 842, boxes: [box('naam', 0.59, 0.06)] };
    expect(completeFromPeers([a, q])).toHaveLength(0);
  });
});

describe('refineWithInk', () => {
  it('geeft null als er geen inkt in het vak staat', () => {
    const img = image(400, 200, []);
    expect(refineWithInk(new InkMask(img, 2), 400, 200, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 })).toBeNull();
  });
  it('breidt opzij (max. 25%) uit naar inkt die het vak raakt', () => {
    // vak x 40..120; inkt loopt door tot 135 (binnen 25% extra) en 200 (daarbuiten)
    const img = image(400, 200, [[50, 40, 200, 60]]);
    const r = refineWithInk(new InkMask(img, 2), 400, 200, { x: 0.1, y: 0.15, w: 0.2, h: 0.2 })!;
    expect(r.x + r.w).toBeGreaterThan(0.3);
    expect(r.x + r.w).toBeLessThanOrEqual(0.36 + 1e-9);
    expect(r.y).toBeCloseTo(0.15, 5);
  });
});
