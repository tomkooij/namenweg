// Kopwoord (bijv. de schoolnaam in het logo) als ankerpunt voor het naamvak.
import { describe, expect, it } from 'vitest';
import { completeFromHeader, findKop, kopWords, type KopPage, type OcrWord } from '../../src/detect-core';
import { DEFAULT_SETTINGS, type Box } from '../../src/types';

const W = 1191;
const H = 842;
const kop = (x: number, y: number) => ({ x, y, w: 0.1, h: 0.015 });
const label = (kind: Box['kind'], x: number, y: number, w = 0.15, h = 0.03): Box => ({ id: kind, x, y, w, h, kind, source: 'auto', rot: 0, text: kind === 'naam', label: kind, ax: x, ay: y });
const page = (k: ReturnType<typeof kop> | undefined, boxes: Box[] = [], extra: Partial<KopPage> = {}): KopPage => ({ wPt: W, hPt: H, kop: k, boxes, ...extra });

describe('findKop', () => {
  const w = (text: string, conf = 90): OcrWord => ({ text, conf, x0: 100, y0: 50, x1: 300, y1: 80, line: 1 });
  it('vindt het kopwoord, ook met één OCR-fout', () => {
    const k = kopWords(DEFAULT_SETTINGS);
    expect(findKop([w('Opgave'), w('COORNHERT')], k, 1000, 500)).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.06 });
    expect(findKop([w('C0ORNHERT')], k, 1000, 500)).toBeDefined();
    expect(findKop([w('COORNHERT', 30)], k, 1000, 500)).toBeUndefined();
    expect(findKop([w('Opgave')], k, 1000, 500)).toBeUndefined();
  });
});

describe('vangnet kopwoord', () => {
  it('leert de plek van het naamvak van een andere pagina met hetzelfde kopwoord', () => {
    const a = page(kop(0.5, 0.05), [label('naam', 0.65, 0.06), label('klas', 0.82, 0.11, 0.05)]);
    const b = page(kop(0.52, 0.06)); // label onleesbaar
    const adds = completeFromHeader([a, b]);
    expect(adds.map((x) => x.box.kind).sort()).toEqual(['klas', 'naam']);
    const naam = adds.find((x) => x.box.kind === 'naam')!.box;
    // Zelfde verhouding tot het kopwoord, verschoven met het kopwoord.
    expect(naam.x).toBeCloseTo(0.67, 3);
    expect(naam.y).toBeCloseTo(0.06 + 0.01, 3);
    expect(naam.text).toBe(true);
    expect(naam.label).toMatch(/geleerd van 1/);
  });
  it('zonder voorbeeld: naamvak op de standaardplek naast een kopwoord bovenaan', () => {
    const adds = completeFromHeader([page(kop(0.5, 0.05))]);
    expect(adds).toHaveLength(1);
    expect(adds[0].box.kind).toBe('naam');
    expect(adds[0].box.x).toBeGreaterThan(0.6);
    expect(adds[0].box.label).toMatch(/standaardplek/);
  });
  it('niet bij een kopwoord midden in de tekst, of als het vak er al is', () => {
    expect(completeFromHeader([page(kop(0.3, 0.6))])).toEqual([]);
    expect(completeFromHeader([page(kop(0.5, 0.05), [label('naam', 0.65, 0.06)])])).toEqual([]);
    expect(completeFromHeader([page(kop(0.5, 0.05), [], { checked: true })])).toEqual([]);
    expect(completeFromHeader([page(undefined)])).toEqual([]);
  });
  it('vakken ver van het kopwoord zijn geen voorbeeld', () => {
    const a = page(kop(0.1, 0.05), [label('naam', 0.1, 0.8)]);
    const adds = completeFromHeader([a, page(kop(0.1, 0.05))]);
    // Alleen de standaardplek, niet onderaan de pagina.
    expect(adds.every((x) => x.box.y < 0.2)).toBe(true);
  });
});
