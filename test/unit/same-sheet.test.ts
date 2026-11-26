// Vangnet "zelfde blad" en strenger zoeken naar losse namen. Alleen verzonnen namen.
import { describe, expect, it } from 'vitest';
import { completeFromSameSheet, findNameWords, isNameHit, printedAnchors, sheetOffset, type OcrWord, type SheetPage } from '../../src/detect-core';
import type { Box, PrintedAnchor } from '../../src/types';

const WORDS = ['natuurkunde', 'toets', 'beweging', 'versie', 'opgave', 'meetinstrumenten', 'significantie', 'berekening'];
/** Gedrukte tekst van een blad, verschoven met (dx, dy). */
const sheet = (dx = 0, dy = 0): PrintedAnchor[] => WORDS.map((t, i) => ({ t, x: 0.1 + 0.05 * (i % 4) + dx, y: 0.2 + 0.08 * i + dy }));
const naamBox = (x: number, y: number, extra: Partial<Box> = {}): Box => ({ id: 'n', x, y, w: 0.25, h: 0.04, kind: 'naam', source: 'auto', rot: 0, text: true, label: 'NAAM', ax: x, ay: y, ...extra });
const page = (pos: PrintedAnchor[], boxes: Box[] = [], extra: Partial<SheetPage> = {}): SheetPage => ({ wPt: 1191, hPt: 842, boxes, printed: pos.map((p) => p.t), printedPos: pos, ...extra });

describe('zelfde blad', () => {
  it('neemt het naamvak over van hetzelfde blad, verschoven met de gedrukte tekst', () => {
    const a = page(sheet(), [naamBox(0.3, 0.05)]);
    const b = page(sheet(0.01, -0.005)); // label onleesbaar: geen vakken
    const adds = completeFromSameSheet([a, b]);
    expect(adds).toHaveLength(1);
    expect(adds[0].page).toBe(b);
    const box = adds[0].box;
    expect(box.kind).toBe('naam');
    expect(box.text).toBe(true);
    // Midden van het vak schuift mee.
    expect(box.x + box.w / 2).toBeCloseTo(0.3 + 0.125 + 0.01, 3);
    expect(box.y + box.h / 2).toBeCloseTo(0.05 + 0.02 - 0.005, 3);
    expect(box.label).toMatch(/zelfde blad/);
  });
  it('niet bij een ander blad', () => {
    const other = WORDS.map((_, i) => ({ t: `ander${'abcdefgh'[i]}woord`, x: 0.5, y: 0.1 * i }));
    expect(completeFromSameSheet([page(sheet(), [naamBox(0.3, 0.05)]), page(other)])).toEqual([]);
  });
  it('niet als het vak er al is, of de pagina gecontroleerd is', () => {
    const a = page(sheet(), [naamBox(0.3, 0.05)]);
    expect(completeFromSameSheet([a, page(sheet(), [naamBox(0.3, 0.05)])])).toEqual([]);
    expect(completeFromSameSheet([a, page(sheet(), [], { checked: true })])).toEqual([]);
  });
  it('alleen vakken bij een gelezen label tellen als bron, geen losse naamtreffers', () => {
    const hit = naamBox(0.3, 0.05, { ax: undefined, label: 'gezochte naam ("x")' });
    expect(isNameHit(hit)).toBe(true);
    expect(completeFromSameSheet([page(sheet(), [hit]), page(sheet())])).toEqual([]);
  });
  it('een losse naamtreffer op de pagina zelf houdt het vangnet niet tegen', () => {
    const hit = naamBox(0.5, 0.6, { ax: undefined, label: 'gezochte naam ("x")', text: false });
    const adds = completeFromSameSheet([page(sheet(), [naamBox(0.3, 0.05)]), page(sheet(), [hit])]);
    expect(adds).toHaveLength(1);
  });
  it('verschuiving: alleen als de meeste woorden kloppen', () => {
    expect(sheetOffset(sheet(), sheet(0.02, 0.01))).toEqual({ dx: expect.closeTo(0.02, 5), dy: expect.closeTo(0.01, 5) });
    const scrambled = sheet().map((p, i) => ({ ...p, x: (i * 0.37) % 1, y: (i * 0.53) % 1 }));
    expect(sheetOffset(sheet(), scrambled)).toBeNull();
  });
  it('printedAnchors: alleen zekere, unieke woorden', () => {
    const w = (text: string, x: number, conf = 95): OcrWord => ({ text, conf, x0: x, y0: 10, x1: x + 40, y1: 30, line: 1 });
    const a = printedAnchors([w('Opgave', 0), w('Opgave', 100), w('Toets', 200), w('Naam', 300, 50), w('E1', 400)], 1000, 100);
    expect(a.map((p) => p.t)).toEqual(['toets']);
    expect(a[0].x).toBeCloseTo(0.22);
  });
});

describe('losse namen zoeken', () => {
  const w = (text: string, conf = 90): OcrWord => ({ text, conf, x0: 0, y0: 0, x1: 40, y1: 20, line: 1 });
  it('korte namen alleen exact', () => {
    expect(findNameWords([w('voor'), w('door'), w('dan')], ['noor', 'daan'])).toEqual([]);
    expect(findNameWords([w('Noor')], ['noor'])).toHaveLength(1);
  });
  it('langere namen met één tikfout', () => {
    expect(findNameWords([w('Visscr')], ['visser'])).toHaveLength(1);
    expect(findNameWords([w('Vissor')], ['hendriks'])).toEqual([]);
  });
});
