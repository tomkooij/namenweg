// Slank naamkader ("NAAM: …… Klas ……") bovenaan een voorblad: herkenning op vorm.
import { describe, expect, it } from 'vitest';
import { findSlimBoxes, slimBoxHasLabel, type OcrWord } from '../../src/detect-core';

const DPI = 200;
const MM = DPI / 25.4;
function page(w = 1650, h = 600) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  const fill = (x: number, y: number, fw: number, fh: number, v = 30) => {
    for (let j = Math.round(y); j < Math.round(y + fh); j++)
      for (let i = Math.round(x); i < Math.round(x + fw); i++) {
        const k = (j * w + i) * 4;
        data[k] = data[k + 1] = data[k + 2] = v;
      }
  };
  const frame = (x: number, y: number, fw: number, fh: number, t = 3) => {
    fill(x, y, fw, t);
    fill(x, y + fh - t, fw, t);
    fill(x, y, t, fh);
    fill(x + fw - t, y, t, fh);
  };
  return { img: { data, width: w, height: h }, fill, frame };
}

describe('slank naamkader', () => {
  it('vindt het kader, ook met handschrift door de rand', () => {
    const p = page();
    p.frame(300, 150, 130 * MM, 9 * MM);
    for (let i = 0; i < 12; i++) p.fill(420 + i * 18, 110 + (i % 3) * 10, 3, 90); // krabbels door de bovenrand
    const r = findSlimBoxes(p.img, DPI);
    expect(r).toHaveLength(1);
    expect(r[0].x0).toBeCloseTo(300, -1);
    expect(r[0].y1).toBeCloseTo(150 + 9 * MM, -1);
  });
  it('geen kader: te kort, te hoog (formulekader), of alleen losse lijnen', () => {
    const p = page();
    p.frame(100, 50, 40 * MM, 8 * MM); // te kort
    p.frame(700, 50, 60 * MM, 18 * MM); // verhouding < 4
    p.fill(100, 400, 140 * MM, 3); // losse lijn
    p.fill(100, 440, 140 * MM, 3); // tweede lijn, zonder zijkanten
    expect(findSlimBoxes(p.img, DPI)).toEqual([]);
  });
  it('bevestiging: "Naam"/"Klas" in of tegen het kader', () => {
    const box = { x0: 300, y0: 150, x1: 1300, y1: 220 };
    const w = (text: string, x: number, y: number, conf = 90): OcrWord => ({ text, conf, x0: x, y0: y, x1: x + 60, y1: y + 25, line: 1 });
    expect(slimBoxHasLabel(box, [w('NAA', 320, 170)], 20)).toBe(true);
    expect(slimBoxHasLabel(box, [w('Klas', 1200, 170)], 20)).toBe(true);
    expect(slimBoxHasLabel(box, [w('cijfer', 320, 170)], 20)).toBe(false);
    expect(slimBoxHasLabel(box, [w('Naam', 320, 500)], 20)).toBe(false);
  });
});
