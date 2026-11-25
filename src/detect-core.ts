// Kern van de detectie zonder afhankelijkheid van de browser (testbaar in Node).
import type { Box, BoxKind, Rot, Settings } from './types';

export interface OcrWord {
  text: string;
  conf: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  line: number;
}

/** Minimale vorm van ImageData (RGBA). */
export interface ImageLike {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export type Kind = Exclude<BoxKind, 'handmatig'> | 'stop';

export interface Phrase {
  kind: Kind;
  tokens: string[];
  joined: string;
}

export interface Label {
  kind: Kind;
  text: string;
  conf: number;
  /** Robuuste regelhoogte van het label in pixels. */
  h: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PxRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface DetectResult {
  /** Rechtop staat duidelijk leesbare gedrukte tekst: pagina is zeker niet gedraaid. */
  upright?: boolean;
  /** Vingerafdruk van de rechtop gelezen gedrukte tekst (zie printedWords). */
  printed?: string[];
  boxes: Box[];
  note: string;
  rotation: Rot;
  labels: string[];
}

export function norm(s: string) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/rn/g, 'm')
    .replace(/[^a-z0-9]/g, '');
}

function lev(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    let rowMin = prev[0];
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
      rowMin = Math.min(rowMin, prev[j]);
    }
    if (rowMin > max) return max + 1;
  }
  return prev[b.length];
}

/**
 * Vergelijk een OCR-woord met een trefwoord. Exacte match altijd; kleine OCR-fouten alleen bij
 * langere woorden én voldoende zekerheid, zodat "nam!" of "Ame" niet als "naam" tellen.
 */
function fuzzy(word: string, tok: string, conf: number, loose: boolean) {
  if (word === tok) return true;
  if (!loose) return false;
  // Afgekapt woord ("kandid" voor "kandidaat") bij hoge zekerheid
  if (word.length >= 6 && tok.length - word.length <= 3 && tok.startsWith(word) && conf >= 80) return true;
  if (tok.length < 5 || conf < 55) return false;
  if (word.length < tok.length - 1) return false;
  const max = tok.length >= 10 ? 2 : 1;
  return lev(word, tok, max) <= max;
}

export function parsePhrases(s: Settings): Phrase[] {
  const out: Phrase[] = [];
  const add = (kind: Kind, list: string, enabled = true) => {
    if (!enabled) return;
    for (const raw of list.split(/[,;\n]/)) {
      const tokens = raw.trim().split(/\s+/).map(norm).filter(Boolean);
      if (tokens.length) out.push({ kind, tokens, joined: tokens.join('') });
    }
  };
  add('naam', s.kwNaam);
  add('nummer', s.kwNummer, s.detectNummer);
  add('klas', s.kwKlas, s.detectKlas);
  add('stop', s.kwStop);
  // Langste zinnen eerst, zodat "naam kandidaat" wint van "naam".
  out.sort((a, b) => b.tokens.length - a.tokens.length || b.joined.length - a.joined.length);
  return out;
}

/**
 * Regelhoogte van een label. Een woordvak kan opgeblazen zijn doordat de OCR er een lijn of
 * hokje bij trekt; daarom het kleinste woord, gecorrigeerd voor woorden zonder stokken.
 */
function labelHeight(ws: OcrWord[]) {
  const hs = ws.map((w) => {
    const hgt = w.y1 - w.y0;
    return /[A-Zbdfhklt0-9]/.test(w.text) ? hgt : hgt * 1.35;
  });
  return Math.max(8, Math.min(...hs));
}

/** Zoek labels in OCR-woorden. */
export function findLabels(words: OcrWord[], phrases: Phrase[]): Label[] {
  const byLine = new Map<number, OcrWord[]>();
  for (const w of words) {
    if (!w.text.trim()) continue;
    const arr = byLine.get(w.line) ?? [];
    arr.push(w);
    byLine.set(w.line, arr);
  }
  const labels: Label[] = [];
  for (const raw of byLine.values()) {
    raw.sort((a, b) => a.x0 - b.x0);
    // Label en waarde aan elkaar geplakt ("Naam:Fatima"): splits op de dubbele punt.
    const line: OcrWord[] = [];
    for (const w of raw) {
      const m = /^([^:]{3,}):(.+)$/.exec(w.text);
      if (m && norm(m[2]).length >= 2) {
        const cut = w.x0 + ((w.x1 - w.x0) * (m[1].length + 1)) / w.text.length;
        line.push({ ...w, text: m[1] + ':', x1: cut }, { ...w, text: m[2], x0: cut });
      } else line.push(w);
    }
    const n = line.map((w) => norm(w.text));
    let i = 0;
    while (i < line.length) {
      let matched: { p: Phrase; len: number } | null = null;
      // Eerst exacte treffers (zodat "Examen" niet als "Examenvak" telt), dan pas met OCR-fouten.
      for (const loose of [false, true]) {
        for (const p of phrases) {
          // Meerdere woorden achter elkaar
          if (i + p.tokens.length <= line.length && p.tokens.every((t, j) => fuzzy(n[i + j], t, line[i + j].conf, loose))) {
            matched = { p, len: p.tokens.length };
            break;
          }
          // Of aan elkaar geschreven ("Naamkandidaat:")
          if (p.tokens.length > 1 && fuzzy(n[i], p.joined, line[i].conf, loose)) {
            matched = { p, len: 1 };
            break;
          }
        }
        if (matched) break;
      }
      if (!matched) {
        i++;
        continue;
      }
      const ws = line.slice(i, i + matched.len);
      // Afgekapt herkend label ("kandid" i.p.v. "kandidaat:") doortrekken tot de volle lengte,
      // zodat het vak niet midden in het label begint.
      const lastWord = ws[ws.length - 1];
      const lastTok = matched.len === 1 && matched.p.tokens.length > 1 ? matched.p.joined : matched.p.tokens[matched.p.tokens.length - 1];
      const lastNorm = norm(lastWord.text);
      let extra = 0;
      if (lastNorm.length > 0 && lastTok.length > lastNorm.length) extra = ((lastWord.x1 - lastWord.x0) / lastNorm.length) * (lastTok.length - lastNorm.length + 0.5);
      const conf = ws.reduce((a, w) => a + w.conf, 0) / ws.length;
      const lbl: Label = {
        kind: matched.p.kind,
        text: ws.map((w) => w.text).join(' '),
        conf,
        h: labelHeight(ws),
        x0: Math.min(...ws.map((w) => w.x0)),
        y0: Math.min(...ws.map((w) => w.y0)),
        x1: Math.max(...ws.map((w) => w.x1)) + extra,
        y1: Math.max(...ws.map((w) => w.y1)),
      };
      // Een label moet "los" staan: eerste woord op de regel, of een duidelijk gat ervoor,
      // of eindigen op een dubbele punt. Zo voorkomen we treffers in lopende tekst
      // ("Geef de naam van de stof…").
      const h = Math.max(6, lbl.y1 - lbl.y0);
      const prev = line[i - 1];
      const standalone = !prev || lbl.x0 - prev.x1 > 1.5 * h || /[:.]$/.test(prev.text);
      const colon = /:\s*$/.test(ws[ws.length - 1].text) || (line[i + matched.len]?.text.trim() === ':');
      const ok = matched.p.kind === 'stop' || ((standalone || colon) && conf >= 35);
      if (ok) labels.push(lbl);
      i += matched.len;
    }
  }
  return labels;
}

/** Inktmasker (verkleind met factor s) voor snel zoeken naar handschrift en lijnen. */
export class InkMask {
  readonly w: number;
  readonly h: number;
  readonly m: Uint8Array;
  constructor(
    img: ImageLike,
    readonly s: number,
  ) {
    const W = img.width;
    const H = img.height;
    this.w = Math.ceil(W / s);
    this.h = Math.ceil(H / s);
    this.m = new Uint8Array(this.w * this.h);
    const d = img.data;
    // Inkt bepalen op een licht vervaagd beeld (gemiddelde van 2s×2s pixels): grijs gerasterde
    // voorgedrukte tekst valt dan weg, pen en potlood blijven donker.
    const k = s; // halve venstergrootte
    for (let my = 0; my < this.h; my++) {
      const yc = my * s;
      const ya = Math.max(0, yc - k + 1);
      const yb = Math.min(H - 1, yc + k);
      for (let mx = 0; mx < this.w; mx++) {
        const xc = mx * s;
        const xa = Math.max(0, xc - k + 1);
        const xb = Math.min(W - 1, xc + k);
        let r = 0,
          g = 0,
          b = 0,
          n = 0;
        for (let y = ya; y <= yb; y++) {
          let i = (y * W + xa) * 4;
          for (let x = xa; x <= xb; x++, i += 4) {
            r += d[i];
            g += d[i + 1];
            b += d[i + 2];
            n++;
          }
        }
        r /= n;
        g /= n;
        b /= n;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const ink =
          lum < 150 ||
          (b > r + 18 && b > g + 6 && lum < 232) || // blauwe pen (ook dunne, lichte streken)
          (r > g + 45 && r > b + 45 && lum < 210); // rode pen
        if (ink) this.m[my * this.w + mx] = 1;
      }
    }
  }

  /** Aantal inktpixels in rechthoek (pixels van het originele canvas). */
  count(r: PxRect) {
    const s = this.s;
    let c = 0;
    const x0 = Math.max(0, Math.floor(r.x0 / s));
    const x1 = Math.min(this.w - 1, Math.floor(r.x1 / s));
    const y0 = Math.max(0, Math.floor(r.y0 / s));
    const y1 = Math.min(this.h - 1, Math.floor(r.y1 / s));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) c += this.m[y * this.w + x];
    return c;
  }

  /** Fractie inkt op een horizontale (dir 'h') of verticale lijn, beste van een smalle band. */
  private lineDensity(fixed: number, from: number, to: number, dir: 'h' | 'v', band: number) {
    const s = this.s;
    const f0 = Math.floor(fixed / s);
    const a = Math.max(0, Math.floor(from / s));
    const b = Math.min((dir === 'h' ? this.w : this.h) - 1, Math.floor(to / s));
    if (b <= a) return 0;
    let best = 0;
    for (let k = -band; k <= band; k++) {
      const f = f0 + k;
      if (f < 0 || f >= (dir === 'h' ? this.h : this.w)) continue;
      let c = 0;
      for (let t = a; t <= b; t++) c += dir === 'h' ? this.m[f * this.w + t] : this.m[t * this.w + f];
      best = Math.max(best, c / (b - a + 1));
    }
    return best;
  }

  /** Meest linkse kolom (in pixels) met inkt binnen de rechthoek, of null. */
  firstInkX(r: PxRect): number | null {
    const s = this.s;
    const x0 = Math.max(0, Math.floor(r.x0 / s));
    const x1 = Math.min(this.w - 1, Math.floor(r.x1 / s));
    const y0 = Math.max(0, Math.floor(r.y0 / s));
    const y1 = Math.min(this.h - 1, Math.floor(r.y1 / s));
    for (let x = x0; x <= x1; x++) {
      let c = 0;
      for (let y = y0; y <= y1; y++) c += this.m[y * this.w + x];
      if (c >= 2) return x * s;
    }
    return null;
  }

  /** Lijkt de rechthoek op een getekend invulhokje (inkt langs minstens 3 van de 4 randen)? */
  isFrame(r: PxRect, h: number) {
    if (r.x1 - r.x0 < 2.5 * h || r.y1 - r.y0 < 1.2 * h) return false;
    const band = 3;
    const edges = [
      this.lineDensity(r.y0 + this.s, r.x0, r.x1, 'h', band),
      this.lineDensity(r.y1 - this.s, r.x0, r.x1, 'h', band),
      this.lineDensity(r.x0 + this.s, r.y0, r.y1, 'v', band),
      this.lineDensity(r.x1 - this.s, r.y0, r.y1, 'v', band),
    ];
    return edges.filter((d) => d >= 0.35).length >= 3;
  }

  /**
   * Flood-fill vanaf alle inktpixels in `seed`, alleen binnen `win`.
   * Geeft de omsluitende rechthoek van alle bereikte inkt, of null.
   */
  grow(seed: PxRect, win: PxRect): PxRect | null {
    const s = this.s;
    const wx0 = Math.max(0, Math.floor(win.x0 / s));
    const wx1 = Math.min(this.w - 1, Math.floor(win.x1 / s));
    const wy0 = Math.max(0, Math.floor(win.y0 / s));
    const wy1 = Math.min(this.h - 1, Math.floor(win.y1 / s));
    const sx0 = Math.max(wx0, Math.floor(seed.x0 / s));
    const sx1 = Math.min(wx1, Math.floor(seed.x1 / s));
    const sy0 = Math.max(wy0, Math.floor(seed.y0 / s));
    const sy1 = Math.min(wy1, Math.floor(seed.y1 / s));
    if (sx1 < sx0 || sy1 < sy0) return null;
    const ww = wx1 - wx0 + 1;
    const seen = new Uint8Array(ww * (wy1 - wy0 + 1));
    const stack: number[] = [];
    for (let y = sy0; y <= sy1; y++)
      for (let x = sx0; x <= sx1; x++)
        if (this.m[y * this.w + x]) {
          const k = (y - wy0) * ww + (x - wx0);
          if (!seen[k]) {
            seen[k] = 1;
            stack.push(x, y);
          }
        }
    if (!stack.length) return null;
    let bx0 = Infinity,
      by0 = Infinity,
      bx1 = -Infinity,
      by1 = -Infinity;
    while (stack.length) {
      const y = stack.pop()!;
      const x = stack.pop()!;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < wx0 || nx > wx1 || ny < wy0 || ny > wy1) continue;
          if (!this.m[ny * this.w + nx]) continue;
          const k = (ny - wy0) * ww + (nx - wx0);
          if (seen[k]) continue;
          seen[k] = 1;
          stack.push(nx, ny);
        }
    }
    return { x0: bx0 * s, y0: by0 * s, x1: (bx1 + 1) * s, y1: (by1 + 1) * s };
  }
}

/**
 * Groei vanaf `seed` en blijf daarna naar rechts (en links) uitbreiden zolang er binnen
 * `gap` pixels nieuwe inkt staat: zo worden losse woorden van een naam samen gepakt.
 */
function growChain(mask: InkMask, seed: PxRect, win: PxRect, gap: number, limitX = win.x1): PxRect | null {
  const first = mask.grow(seed, win);
  if (!first) return null;
  let acc: PxRect = first;
  for (let iter = 0; iter < 30; iter++) {
    const yMid0 = seed.y0;
    const yMid1 = seed.y1;
    const nextR: PxRect = { x0: acc.x1, y0: yMid0, x1: Math.min(limitX, acc.x1 + gap), y1: yMid1 };
    const nextL: PxRect = { x0: Math.max(win.x0, acc.x0 - gap), y0: yMid0, x1: acc.x0, y1: yMid1 };
    const more = union(nextR.x1 > nextR.x0 ? mask.grow(nextR, win) : null, nextL.x1 > nextL.x0 && nextL.x0 >= seed.x0 ? mask.grow(nextL, win) : null);
    const u: PxRect = union(acc, more)!;
    if (u.x0 === acc.x0 && u.x1 === acc.x1 && u.y0 === acc.y0 && u.y1 === acc.y1) break;
    acc = u;
  }
  return acc;
}

const union = (a: PxRect | null, b: PxRect | null): PxRect | null =>
  !a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };

const overlapY = (a: PxRect, b: PxRect) => Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** Bepaal de te verwijderen gebieden (in pixels) bij de gevonden labels. */
export function regionsFor(labels: Label[], mask: InkMask, W: number, H: number, pad: number) {
  const result: { kind: BoxKind; rect: PxRect; label: string; conf: number; anchor: { x: number; y: number } }[] = [];
  const personal = labels.filter((l) => l.kind !== 'stop');
  for (const L of personal) {
    const h = L.h;
    const maxRight = L.kind === 'naam' ? 36 * h : L.kind === 'nummer' ? 16 * h : 12 * h;
    // Rechtergrens: volgend label op dezelfde regel.
    let right = Math.min(W, L.x1 + maxRight);
    for (const o of labels) {
      if (o === L) continue;
      if (o.x0 > L.x1 && overlapY(o, L) > 0.4 * h) right = Math.min(right, o.x0 - 0.3 * h);
    }
    const parts: PxRect[] = [];

    // Onder het label: invulhokje (bv. "Examen no." met een kader eronder).
    let below: PxRect | null = null;
    if (L.kind !== 'naam') {
      const win: PxRect = { x0: L.x0 - 1.5 * h, y0: L.y1 + 0.1 * h, x1: L.x0 + 14 * h, y1: L.y1 + 5 * h };
      // Niet verder dan het volgende label op die hoogte (bv. "Datum:").
      for (const o of labels) {
        if (o === L) continue;
        if (o.x0 > L.x0 + 2 * h && overlapY(o, win) > 0.3 * (o.y1 - o.y0)) win.x1 = Math.min(win.x1, o.x0 - 0.3 * h);
      }
      const base: PxRect = { x0: L.x0 - 0.3 * h, y0: L.y1 + 0.3 * h, x1: Math.min(win.x1, Math.max(L.x1, L.x0 + 6 * h)), y1: L.y1 + 3.5 * h };
      if (base.x1 > base.x0 && mask.count(base) > 6) below = growChain(mask, base, win, 2 * h);
    }

    if (below && mask.isFrame(below, h)) {
      parts.push(below);
    } else if (right - L.x1 > 1.5 * h) {
      // Rechts van het label
      const base: PxRect = { x0: L.x1 + 0.15 * h, y0: L.y0 - (L.kind === 'naam' ? 1.5 : 1.2) * h, x1: right, y1: L.y1 + 0.5 * h };
      // Handschrift mag een stukje over een volgend label heen doorlopen, en hoge
      // hoofdletters/krullen steken vaak ver boven de regel uit.
      const win: PxRect = { x0: L.x0 - 1 * h, y0: L.y0 - 4 * h, x1: Math.min(W, right + 6 * h), y1: L.y1 + 1.6 * h };
      // Een ingevulde waarde begint vlak na het label; inkt verderop hoort bij iets anders.
      // Bij een naam mag het gat groter zijn (label half herkend, naam ver naar rechts geschreven).
      let seed: PxRect = { ...base, x1: Math.min(right, L.x1 + 4 * h) };
      if (L.kind === 'naam') {
        const first = mask.firstInkX({ ...base, x1: Math.min(right, L.x1 + 18 * h) });
        if (first !== null) seed = { ...base, x0: first, x1: Math.min(right, first + 2 * h) };
      }
      const grown = growChain(mask, seed, win, (L.kind === 'naam' ? 6 : 2.5) * h, right);
      if (L.kind === 'naam') {
        // Naamveld altijd verwijderen (ook als leeg), inclusief uitlopend handschrift.
        // Basisvak tot waar inkt staat + marge, maar minstens 22×h breed (ruim: een leeg
        // stuk kopregel wegpoetsen kan geen kwaad, een half naamvak wel).
        const ink = grown ? Math.max(grown.x1 + 1.5 * h, L.x1 + 24 * h) : L.x1 + 24 * h;
        // Basisvak loopt van label tot (ruim) einde naam, zodat ook iets tussen label en naam weg is.
        parts.push(union({ ...base, x1: Math.min(right, ink) }, grown)!);
      } else if (grown && mask.count(seed) > 4) {
        parts.push(union({ ...base, x1: Math.min(right, grown.x1 + h) }, grown)!);
      }
    }
    // Rechts niets gevonden: dan toch wat er onder staat.
    if (!parts.length && below) parts.push(below);

    for (const p of parts) {
      const r: PxRect = {
        x0: Math.max(0, p.x0 - pad * h),
        y0: Math.max(0, p.y0 - pad * h),
        x1: Math.min(W, p.x1 + pad * h),
        y1: Math.min(H, p.y1 + pad * h),
      };
      result.push({ kind: L.kind as BoxKind, rect: r, label: L.text, conf: L.conf, anchor: { x: L.x0, y: L.y0 } });
    }
  }
  return result;
}

/** Rechthoek uit gedraaid canvas terugrekenen naar het origineel (W×H). */
export function unrotate(rc: PxRect, r: Rot, W: number, H: number): PxRect {
  switch (r) {
    case 90:
      return { x0: rc.y0, x1: rc.y1, y0: H - rc.x1, y1: H - rc.x0 };
    case 270:
      return { x0: W - rc.y1, x1: W - rc.y0, y0: rc.x0, y1: rc.x1 };
    case 180:
      return { x0: W - rc.x1, x1: W - rc.x0, y0: H - rc.y1, y1: H - rc.y0 };
    default:
      return rc;
  }
}

export function mergeBoxes(boxes: Box[]): Box[] {
  // Overlappende vakken van dezelfde soort samenvoegen.
  const out: Box[] = [];
  for (const b of boxes) {
    const hit = out.find(
      (o) => o.kind === b.kind && o.x < b.x + b.w && b.x < o.x + o.w && o.y < b.y + b.h && b.y < o.y + o.h,
    );
    if (hit) {
      const x0 = Math.min(hit.x, b.x);
      const y0 = Math.min(hit.y, b.y);
      hit.w = Math.max(hit.x + hit.w, b.x + b.w) - x0;
      hit.h = Math.max(hit.y + hit.h, b.y + b.h) - y0;
      hit.x = x0;
      hit.y = y0;
    } else out.push({ ...b });
  }
  return out;
}


const overlapArea = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

export interface PeerPage {
  wPt: number;
  hPt: number;
  boxes: Box[];
}

/**
 * Vangnet: op formulieren met een vaste kop (naam, nummer, …) mist de OCR soms één label.
 * Als een pagina minstens één automatisch vak heeft dat op dezelfde plek staat als op een andere
 * pagina, worden de vakken die daar wél gevonden zijn (verschoven met hetzelfde verschil) aangevuld.
 * Geeft de toegevoegde vakken terug (nog zonder id).
 */
export function completeFromPeers(pages: PeerPage[], tol = 0.03): { page: PeerPage; box: Omit<Box, 'id'> }[] {
  const added: { page: PeerPage; box: Omit<Box, 'id'> }[] = [];
  const auto = (p: PeerPage) => p.boxes.filter((b) => b.source === 'auto' && b.kind !== 'handmatig');
  const sameShape = (a: PeerPage, b: PeerPage) => Math.abs(a.wPt / a.hPt - b.wPt / b.hPt) < 0.02;
  for (const q of pages) {
    const qa = auto(q);
    if (!qa.length) continue;
    // Per ontbrekende soort: vereniging van voorspellingen uit alle passende andere pagina's.
    const collected = new Map<BoxKind, { x0: number; y0: number; x1: number; y1: number; rot: Rot }[]>();
    for (const p of pages) {
      if (p === q || !sameShape(p, q)) continue;
      const pa = auto(p);
      if (pa.length < 2) continue;
      // Ankers: zelfde soort, ongeveer zelfde positie (linkerbovenhoek)
      let best: { dx: number; dy: number } | null = null;
      for (const qb of qa)
        for (const pb of pa) {
          if (qb.kind !== pb.kind || qb.rot !== pb.rot) continue;
          // Verticaal moet het kloppen; horizontaal mag het vak anders beginnen (label half
          // herkend). Bij een groot horizontaal verschil niet horizontaal verschuiven.
          // Liefst verankeren op het gedrukte label (stabiel), anders op het vak zelf.
          const useLabel = qb.ax !== undefined && qb.ay !== undefined && pb.ax !== undefined && pb.ay !== undefined;
          // Anders gelezen label ("kandid" vs "Naam kandidaat") begint op een andere x: dan alleen verticaal.
          let dx = useLabel ? (norm(qb.label ?? '') === norm(pb.label ?? '') ? qb.ax! - pb.ax! : 0) : qb.x - pb.x;
          const dy = useLabel ? qb.ay! - pb.ay! : qb.y - pb.y;
          if (Math.abs(dy) >= tol || Math.abs(dx) >= 2 * tol) continue;
          if (Math.abs(dx) >= tol) dx = 0;
          if (!best || Math.hypot(dx, dy) < Math.hypot(best.dx, best.dy)) best = { dx, dy };
        }
      if (!best) continue;
      for (const pb of pa) {
        // Alleen soorten die op deze pagina nog helemaal ontbreken.
        if (qa.some((b) => b.kind === pb.kind)) continue;
        const shifted = { x: pb.x + best.dx, y: pb.y + best.dy, w: pb.w, h: pb.h };
        // Bestaat er op q al een vak op die plek? Dan niets doen.
        if (q.boxes.some((b) => overlapArea(b, shifted) > 0.3 * shifted.w * shifted.h)) continue;
        const list = collected.get(pb.kind) ?? [];
        list.push({ x0: shifted.x, y0: shifted.y, x1: shifted.x + shifted.w, y1: shifted.y + shifted.h, rot: pb.rot });
        collected.set(pb.kind, list);
      }
    }
    // Horizontaal de vereniging (namen verschillen in lengte), verticaal de mediaan (één lange
    // staart of krul moet het vak niet de antwoorden in laten lopen).
    const median = (a: number[]) => {
      const b = [...a].sort((x, y) => x - y);
      return b[Math.floor((b.length - 1) / 2)];
    };
    const predictions = new Map<BoxKind, { x0: number; y0: number; x1: number; y1: number; rot: Rot; n: number }>();
    for (const [kind, list] of collected)
      predictions.set(kind, {
        x0: Math.min(...list.map((r) => r.x0)),
        x1: Math.max(...list.map((r) => r.x1)),
        y0: median(list.map((r) => r.y0)),
        y1: median(list.map((r) => r.y1)),
        rot: list[0].rot,
        n: list.length,
      });
    for (const [kind, r0] of predictions) {
      // Onrealistisch grote voorspellingen negeren
      if (r0.x1 - r0.x0 > 0.4 || r0.y1 - r0.y0 > 0.25) continue;
      // Extra marge: een afgeleid vak is minder precies.
      const mx = (r0.x1 - r0.x0) * 0.12;
      const my = (r0.y1 - r0.y0) * 0.1;
      const r = { ...r0, x0: r0.x0 - mx, x1: r0.x1 + mx, y0: r0.y0 - my, y1: r0.y1 + my };
      const box: Omit<Box, 'id'> = {
        x: Math.max(0, r.x0),
        y: Math.max(0, r.y0),
        w: Math.min(1, r.x1) - Math.max(0, r.x0),
        h: Math.min(1, r.y1) - Math.max(0, r.y0),
        kind,
        source: 'auto',
        rot: r.rot,
        text: kind === 'naam' && !q.boxes.some((b) => b.text),
        label: `afgeleid van ${r.n} andere pagina('s)`,
      };
      added.push({ page: q, box });
    }
  }
  return added;
}

/**
 * Verfijn een (afgeleid) vak met de inkt op de pagina: alle inkt die het vak raakt, wordt
 * meegenomen binnen een venster dat 25% breder is. Geeft null als er geen inkt in het vak staat. Werkt in genormaliseerde coördinaten.
 */
export function refineWithInk(mask: InkMask, W: number, H: number, b: { x: number; y: number; w: number; h: number }) {
  const r: PxRect = { x0: b.x * W, y0: b.y * H, x1: (b.x + b.w) * W, y1: (b.y + b.h) * H };
  // Staat er niets in het voorspelde vak, dan is er ook niets te verbergen.
  if (mask.count(r) < 6) return null;
  const ex = (r.x1 - r.x0) * 0.25;
  const ey = (r.y1 - r.y0) * 0.25;
  // Alleen opzij uitbreiden: boven/onder liggen vaak andere velden of de antwoorden.
  const win: PxRect = { x0: Math.max(0, r.x0 - ex), y0: r.y0, x1: Math.min(W, r.x1 + ex), y1: r.y1 };
  void ey;
  const g = mask.grow(r, win);
  const u = union(r, g)!;
  const pad = 0.01 * Math.min(W, H);
  const x0 = Math.max(0, u.x0 - (g && g.x0 < r.x0 ? pad : 0));
  const y0 = Math.max(0, u.y0 - (g && g.y0 < r.y0 ? pad : 0));
  const x1 = Math.min(W, u.x1 + (g && g.x1 > r.x1 ? pad : 0));
  const y1 = Math.min(H, u.y1 + (g && g.y1 > r.y1 ? pad : 0));
  return { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
}

/** Woorden uit een bestandsnaam die als (deel van een) naam kunnen dienen. */
export function nameTokensFromFileName(fileName: string, s: Settings): string[] {
  const skip = new Set(
    [s.kwNaam, s.kwNummer, s.kwKlas, s.kwStop]
      .join(',')
      .split(/[,\s]+/)
      .map(norm)
      .concat(['scan', 'toets', 'pdf', 'kopie', 'copy', 'page', 'pagina', 'versie', 'final', 'def', 'uitwerking', 'antwoorden', 'herkansing', 'proefwerk', 'examen', 'natuurkunde', 'wiskunde', 'scheikunde', 'biologie', 'engels', 'frans', 'duits', 'nederlands', 'geschiedenis', 'aardrijkskunde', 'economie']),
  );
  return [
    ...new Set(
      fileName
        .replace(/\.[^.]+$/, '')
        .split(/[\s_\-.,()]+/)
        .map(norm)
        .filter((t) => t.length >= 4 && !/\d/.test(t) && !skip.has(t)),
    ),
  ];
}

/**
 * Zoek OCR-woorden die (bijna) gelijk zijn aan een naam uit de bestandsnaam, waar ook op de
 * pagina. Geeft rechthoeken (pixels) terug met wat marge.
 */
export function findNameWords(words: OcrWord[], names: string[]): { rect: PxRect; text: string }[] {
  const out: { rect: PxRect; text: string }[] = [];
  if (!names.length) return out;
  for (const w of words) {
    const n = norm(w.text);
    if (n.length < 3 || w.conf < 45) continue;
    const hit = names.some((name) => {
      if (n === name) return true;
      const max = name.length >= 7 ? 2 : 1;
      return Math.abs(n.length - name.length) <= max && lev(n, name, max) <= max;
    });
    if (!hit) continue;
    const h = Math.max(8, w.y1 - w.y0);
    out.push({ rect: { x0: w.x0 - 0.5 * h, y0: w.y0 - 0.6 * h, x1: w.x1 + 0.5 * h, y1: w.y1 + 0.6 * h }, text: w.text });
  }
  return out;
}

export interface SplitPage {
  boxes: { kind: BoxKind }[];
  printed?: string[];
}

export interface SplitResult {
  /** Pagina's (0-based) waar een nieuwe leerling begint, zonder 0. */
  starts: number[];
  /** Zeker genoeg om automatisch te splitsen; anders alleen voorstellen. */
  sure: boolean;
  /** ritme = vast aantal pagina's per leerling; voorblad = bij elk blad gelijk aan pagina 1. */
  method: 'ritme' | 'voorblad';
}

/** Uitkomst plus een leesbaar logboek van de afwegingen (voor het analysevenster). */
export interface SplitAnalysis {
  result: SplitResult | null;
  log: string[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Herken een scan van een hele klas in één bestand en bepaal waar elke leerling begint.
 *
 * 1. Ritme: elk vast aantal pagina's per leerling (1, 2, 3, …) wordt geprobeerd, de kleinste
 *    eerst. Een ritme past als pagina 1 een naamvak heeft, bij ≥ 60% van de leerlingen het
 *    naamvak op hun eerste pagina gevonden is (een gemist naamvak wordt zo opgevangen) en de
 *    gedrukte tekst niet laat zien dat de beginpagina's verschillende bladen zijn. Naamvakken
 *    op andere pagina's (bijv. een antwoordblad met naam) mogen.
 * 2. Voorblad: hebben leerlingen niet allemaal evenveel pagina's (bijv. 4, 6 of 8), dan begint
 *    een leerling bij elke pagina die volgens de gedrukte tekst hetzelfde blad is als pagina 1.
 *
 * Alleen als de gedrukte tekst het bevestigt is de uitkomst `sure`; anders wordt splitsen
 * alleen voorgesteld.
 */
export function analyzeClassSplit(pages: SplitPage[], minParts = 3): SplitAnalysis {
  const log: string[] = [];
  const n = pages.length;
  const named = (i: number) => pages[i].boxes.some((b) => b.kind === 'naam');
  const sim0 = (i: number) => printedSimilarity(pages[0].printed, pages[i].printed);
  if (n < minParts) {
    log.push(`Maar ${n} pagina('s): te weinig voor ${minParts} of meer leerlingen.`);
    return { result: null, log };
  }
  if (!named(0)) {
    log.push('Pagina 1 heeft geen naamvak: niet als klassenscan behandeld.');
    return { result: null, log };
  }

  // 1. Vast ritme
  let fixed: SplitResult | null = null;
  for (let period = 1; n / period >= minParts; period++) {
    if (n % period) continue;
    const parts = n / period;
    const starts = Array.from({ length: parts - 1 }, (_, k) => (k + 1) * period);
    const cover = (1 + starts.filter(named).length) / parts;
    const head = `${period} p. per leerling (${parts} leerlingen):`;
    if (cover < 0.6) {
      log.push(`${head} naamvak op ${pct(cover)} van de beginpagina's → past niet.`);
      continue;
    }
    // Zijn de beginpagina's echt hetzelfde voorblad (klas), of verschillende bladen van één
    // leerling met overal de naam erop? Vergelijk de gedrukte tekst met die van pagina 1.
    let same = 0;
    let compared = 0;
    for (const st of starts) {
      const sim = sim0(st);
      if (sim === null) continue;
      compared++;
      // Hetzelfde voorblad scoort in de praktijk ~0,9–1; verschillende bladen met dezelfde kop
      // (naam, klas, titel) blijven daar ruim onder.
      if (sim >= SAME_SHEET) same++;
    }
    const cmp = compared ? `${same} van ${compared} vergeleken beginpagina's gelijk aan pagina 1` : 'gedrukte tekst niet te vergelijken';
    if (compared >= 2 && same / compared < 0.5) {
      log.push(`${head} naamvak op ${pct(cover)}, maar ${cmp} → verschillende bladen, past niet.`);
      continue;
    }
    // Staat er midden in een deel een voorblad (zelfde blad als pagina 1), dan begint daar een
    // leerling: het aantal pagina's per leerling is dan niet vast.
    const startSet = new Set(starts);
    const inside = [];
    for (let i = 1; i < n; i++) if (!startSet.has(i) && (sim0(i) ?? 0) >= SAME_SHEET) inside.push(i + 1);
    if (inside.length) {
      log.push(`${head} naamvak op ${pct(cover)}, maar voorblad midden in een deel (p. ${inside.join(', ')}) → past niet.`);
      continue;
    }
    const sure = compared >= Math.max(2, 0.6 * starts.length) && same / compared >= 0.8;
    log.push(`${head} naamvak op ${pct(cover)}, ${cmp} → past${sure ? ' (zeker)' : ' (niet zeker)'}.`);
    fixed = { starts, sure, method: 'ritme' };
    break;
  }
  const done = (result: SplitResult | null): SplitAnalysis => {
    if (!result) log.push('Conclusie: geen klassenscan herkend, niet gesplitst.');
    else
      log.push(
        `Conclusie: ${result.starts.length + 1} leerlingen via ${result.method === 'ritme' ? 'vast ritme' : 'voorblad'}; ${result.sure ? 'automatisch splitsen' : 'alleen voorstellen'}.`,
      );
    return { result, log };
  };
  if (fixed?.sure) return done(fixed);

  // 2. Wisselend aantal pagina's: elke pagina die hetzelfde blad is als pagina 1.
  let byCover: SplitResult | null = null;
  if ((pages[0].printed?.length ?? 0) < MIN_PRINTED) {
    log.push('Voorblad-methode: te weinig gedrukte tekst op pagina 1 om te vergelijken.');
  } else {
    const v = [0];
    for (let i = 1; i < n; i++) if ((sim0(i) ?? 0) >= SAME_SHEET) v.push(i);
    // Gemist voorblad herstellen: staat midden in een deel weer het 2e blad van leerling 1,
    // dan is de pagina ervoor waarschijnlijk een (slecht gelezen) voorblad.
    const repaired: number[] = [];
    if (v.length >= 2 && v[1] > 1) {
      for (let i = 2; i < n; i++) {
        if (v.includes(i) || v.includes(i - 1) || !named(i - 1)) continue;
        const prevStart = Math.max(...v.filter((st) => st < i));
        if (i - 1 - prevStart < 2) continue; // vlak na een voorblad: gewoon blad 2 van die leerling
        if ((printedSimilarity(pages[1].printed, pages[i].printed) ?? 0) >= SAME_SHEET) repaired.push(i - 1);
      }
      v.push(...repaired);
      v.sort((a, b) => a - b);
    }
    if (v.length < minParts) {
      log.push(`Voorblad-methode: maar ${v.length} pagina('s) gelijk aan pagina 1 → geen klassenscan.`);
    } else {
      const lengths = v.map((st, k) => (v[k + 1] ?? n) - st);
      const namedShare = v.filter(named).length / v.length;
      const sorted = [...lengths].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      // Veel langer dan gewoonlijk: misschien is daar een voorblad gemist (twee leerlingen in één deel).
      const long = lengths.filter((l) => l >= 1.8 * median).length;
      const head =
        `Voorblad-methode: ${v.length} beginpagina's (p. ${v.map((i) => i + 1).join(', ')}), lengtes ${lengths.join(', ')}` +
        (repaired.length ? `; voorblad op p. ${repaired.map((i) => i + 1).join(', ')} niet goed gelezen, afgeleid uit het blad erna` : '');
      if (namedShare < 0.6) {
        log.push(`${head}; maar naamvak op slechts ${pct(namedShare)} daarvan → past niet.`);
      } else {
        const sure = namedShare >= 0.8 && !long;
        log.push(
          `${head}; naamvak op ${pct(namedShare)}` +
            (long ? `; ${long} deel/delen opvallend lang (misschien een gemist voorblad)` : '') +
            ` → past${sure ? ' (zeker)' : ' (niet zeker)'}.`,
        );
        byCover = { starts: v.slice(1), sure, method: 'voorblad' };
      }
    }
  }
  return done(byCover?.sure ? byCover : (fixed ?? byCover));
}

/** Kortweg: waar beginnen de leerlingen (of null). Zie analyzeClassSplit. */
export function classSplitStarts(pages: SplitPage[], minParts = 3): SplitResult | null {
  return analyzeClassSplit(pages, minParts).result;
}

/** Vanaf deze overlap (0..1) geldt een pagina als hetzelfde blad. */
export const SAME_SHEET = 0.7;

/** Minimaal aantal gedrukte woorden om twee pagina's betrouwbaar te vergelijken. */
export const MIN_PRINTED = 6;

/**
 * Vingerafdruk van een pagina: goed leesbare woorden (OCR-zekerheid ≥ 85, ≥ 4 letters, zonder
 * cijfers). Handschrift wordt zelden zo zeker gelezen, dus dit is vooral de gedrukte tekst.
 */
export function printedWords(words: OcrWord[]): string[] {
  return [...new Set(words.filter((w) => w.conf >= 85).map((w) => norm(w.text)).filter((t) => t.length >= 4 && !/\d/.test(t)))];
}

/**
 * Overlap van twee vingerafdrukken: gedeelde woorden / grootte van de kleinste (0..1).
 * null als er te weinig tekst is om iets te zeggen.
 */
export function printedSimilarity(a?: string[], b?: string[]): number | null {
  if (!a || !b || Math.min(a.length, b.length) < MIN_PRINTED) return null;
  const set = new Set(a);
  return b.filter((w) => set.has(w)).length / Math.min(a.length, b.length);
}
