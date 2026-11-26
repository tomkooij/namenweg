// Geprinte markeringen (dichte zwarte vierkantjes) rond een naamveld.
import { describe, expect, it } from 'vitest';
import { findMarkerSquares, markerFields } from '../../src/detect-core';

const DPI = 200;
const MM = DPI / 25.4;
function page(w = 1700, h = 2400) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  const fill = (x: number, y: number, fw: number, fh: number, v = 20) => {
    for (let j = Math.round(y); j < Math.round(y + fh); j++)
      for (let i = Math.round(x); i < Math.round(x + fw); i++) {
        const k = (j * w + i) * 4;
        data[k] = data[k + 1] = data[k + 2] = v;
      }
  };
  return { img: { data, width: w, height: h }, fill, sq: (x: number, y: number, mm = 5, v = 20) => fill(x, y, mm * MM, mm * MM, v) };
}
const fields = (img: Parameters<typeof findMarkerSquares>[0]) => markerFields(findMarkerSquares(img, DPI));

describe('markeringen', () => {
  it('twee vierkantjes linksboven en rechtsonder = één naamveld', () => {
    const p = page();
    p.sq(200, 300);
    p.sq(200 + 120 * MM, 300 + 17 * MM);
    // Handschrift ertussen en over de rand.
    for (let i = 0; i < 40; i++) p.fill(260 + i * 20, 330 + (i % 5) * 6, 3, 60);
    const f = fields(p.img);
    expect(f).toHaveLength(1);
    expect(f[0].vertical).toBe(false);
    expect(f[0].rect.x0).toBeCloseTo(200, -1);
    expect(f[0].rect.y1).toBeCloseTo(300 + 22 * MM, -1);
  });
  it('kleiner of groter afgedrukt (A4 ↔ A3) werkt ook', () => {
    for (const mm of [3.6, 7]) {
      const p = page();
      p.sq(200, 300, mm);
      p.sq(200 + 120 * MM, 300 + 17 * MM, mm);
      expect(fields(p.img)).toHaveLength(1);
    }
  });
  it('geen veld: los vierkantje, opsommingsteken, grijs vlak, foto, vierkant aan een lijn', () => {
    const p = page();
    p.sq(100, 100); // los
    p.sq(400, 400, 1.5); // opsommingsteken
    p.sq(400, 600, 5, 160);
    p.sq(400 + 60 * MM, 600 + 17 * MM, 5, 160); // lichtgrijs
    p.fill(900, 900, 400, 300); // foto
    p.sq(950, 950);
    p.fill(300, 1580, 620, 4); // lijn dwars door een vierkant
    p.sq(900, 1560);
    expect(findMarkerSquares(p.img, DPI)).toHaveLength(1); // alleen het losse vierkantje
    expect(fields(p.img)).toEqual([]);
  });
  it('twee velden onder elkaar worden goed gekoppeld', () => {
    const p = page();
    for (const y of [300, 300 + 40 * MM]) {
      p.sq(200, y);
      p.sq(200 + 120 * MM, y + 17 * MM);
    }
    const f = fields(p.img).sort((a, b) => a.rect.y0 - b.rect.y0);
    expect(f).toHaveLength(2);
    expect(f[0].rect.y1).toBeLessThan(f[1].rect.y0);
  });
  it('90° gedraaid gescand: andere diagonaal, staand veld', () => {
    const p = page();
    p.sq(200 + 17 * MM, 300);
    p.sq(200, 300 + 120 * MM);
    const f = fields(p.img);
    expect(f).toHaveLength(1);
    expect(f[0].vertical).toBe(true);
  });
});

describe('markeringen: drie blokken onder elkaar (zoals in het sjabloon)', () => {
  it('koppelt elke linksboven aan zijn eigen rechtsonder, ook gedraaid', () => {
    const p = page();
    const ys = [300, 300 + 40 * MM, 300 + 80 * MM];
    const widths = [140, 110, 140];
    const heights = [18, 18, 28];
    ys.forEach((y, i) => {
      p.sq(200, y);
      p.sq(200 + (widths[i] - 5) * MM, y + (heights[i] - 5) * MM);
    });
    const f = fields(p.img).sort((a, b) => a.rect.y0 - b.rect.y0);
    expect(f).toHaveLength(3);
    f.forEach((x, i) => expect((x.rect.x1 - x.rect.x0) / MM).toBeCloseTo(widths[i], 0));
  });
});

describe('markeringen: drie blokken, 90° gedraaid gescand', () => {
  it('vindt alle drie als staande velden', () => {
    const p = page(2400, 1700);
    const xs = [300, 300 + 40 * MM, 300 + 80 * MM];
    xs.forEach((x) => {
      // 90° met de klok mee: linksboven → rechtsboven, rechtsonder → linksonder.
      p.sq(x + 13 * MM, 200);
      p.sq(x, 200 + 135 * MM);
    });
    const f = fields(p.img);
    expect(f).toHaveLength(3);
    expect(f.every((x) => x.vertical)).toBe(true);
  });
});
