// Detectiemethoden: voorinstellingen, naamkader leren van de stapel, ruim lezen.
import { describe, expect, it } from 'vitest';
import { completeFromFrames, looksLikeLabel } from '../../src/detect-core';
import { DEFAULT_SETTINGS, PRESETS, strategyOf, type Box, type SlimFrame } from '../../src/types';

describe('strategie = voorinstelling van de methoden', () => {
  it('standaard is Schoollogo', () => {
    expect(strategyOf(DEFAULT_SETTINGS)).toBe('logo');
  });
  it('Volledig, en Eigen zodra er één vinkje afwijkt', () => {
    expect(strategyOf({ ...DEFAULT_SETTINGS, ...PRESETS.volledig })).toBe('volledig');
    expect(strategyOf({ ...DEFAULT_SETTINGS, detectMarkers: true })).toBe('eigen');
    expect(strategyOf({ ...DEFAULT_SETTINGS, ...PRESETS.volledig, kopKaderVorm: false })).toBe('eigen');
  });
});

describe('naamkader ruim lezen', () => {
  it('gewoon: begin van naam/klas', () => {
    for (const t of ['NAAM:', 'Naam', 'NAA', 'Klas', 'klas2']) expect(looksLikeLabel(t, false)).toBe(true);
    for (const t of ['KIas', 'Kias', 'cijfer']) expect(looksLikeLabel(t, false)).toBe(false);
  });
  it('ruim: één OCR-fout mag', () => {
    for (const t of ['NAAN', 'KIas', 'Naarn', 'NAAM']) expect(looksLikeLabel(t, true)).toBe(true);
    for (const t of ['cijfer', 'vak', 'datum', 'toets']) expect(looksLikeLabel(t, true)).toBe(false);
  });
});

describe('naamkader leren van de stapel', () => {
  const A3 = { wPt: 1191, hPt: 842 };
  const frame = (ok: boolean, dx = 0, dy = 0): SlimFrame => ({ x: 0.218 + dx, y: 0.066 + dy, w: 0.247, h: 0.034, ok });
  const strip: Box = { id: 's', x: 0, y: 0, w: 0.5, h: 0.114, kind: 'naam', source: 'auto', rot: 0, text: true, label: 'kopstrook' };
  it('kader zonder leesbaar woord telt als het elders bevestigd is', () => {
    const a = { ...A3, boxes: [strip], frames: [frame(true)] };
    const b = { ...A3, boxes: [] as Box[], frames: [frame(false, 0.005, -0.003)] };
    const adds = completeFromFrames([a, b]);
    expect(adds).toHaveLength(1);
    expect(adds[0].page).toBe(b);
    expect(adds[0].box).toMatchObject({ x: 0, w: 0.5, y: 0, kind: 'naam', text: true });
    expect(adds[0].box.h).toBeGreaterThan(0.1);
  });
  it('niet bij een kader van een andere maat of plek, of zonder bevestigd voorbeeld', () => {
    const a = { ...A3, boxes: [strip], frames: [frame(true)] };
    expect(completeFromFrames([a, { ...A3, boxes: [], frames: [{ ...frame(false), w: 0.12 }] }])).toEqual([]);
    expect(completeFromFrames([a, { ...A3, boxes: [], frames: [frame(false, 0, 0.3)] }])).toEqual([]);
    expect(completeFromFrames([{ ...A3, boxes: [], frames: [frame(false)] }, { ...A3, boxes: [], frames: [frame(false)] }])).toEqual([]);
  });
});
