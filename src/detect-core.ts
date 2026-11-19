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
  for (const line of byLine.values()) {
    line.sort((a, b) => a.x0 - b.x0);
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
      const conf = ws.reduce((a, w) => a + w.conf, 0) / ws.length;
      const lbl: Label = {
        kind: matched.p.kind,
        text: ws.map((w) => w.text).join(' '),
        conf,
        h: labelHeight(ws),
        x0: Math.min(...ws.map((w) => w.x0)),
        y0: Math.min(...ws.map((w) => w.y0)),
        x1: Math.max(...ws.map((w) => w.x1)),
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
          (b > r + 30 && b > g + 10 && lum < 215) || // blauwe pen
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
  const result: { kind: BoxKind; rect: PxRect; label: string; conf: number }[] = [];
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
      const base: PxRect = { x0: L.x1 + 0.15 * h, y0: L.y0 - 0.9 * h, x1: right, y1: L.y1 + 0.5 * h };
      // Handschrift mag een stukje over een volgend label heen doorlopen.
      const win: PxRect = { x0: L.x0 - 1 * h, y0: L.y0 - 2.6 * h, x1: Math.min(W, right + 6 * h), y1: L.y1 + 1.6 * h };
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
        const ink = grown ? Math.max(grown.x1 + 1.5 * h, L.x1 + 28 * h) : L.x1 + 28 * h;
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
      result.push({ kind: L.kind as BoxKind, rect: r, label: L.text, conf: L.conf });
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
    const predictions = new Map<BoxKind, { x0: number; y0: number; x1: number; y1: number; rot: Rot; n: number }>();
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
          let dx = qb.x - pb.x;
          const dy = qb.y - pb.y;
          if (Math.abs(dy) >= tol || Math.abs(dx) >= 2 * tol) continue;
          if (Math.abs(dx) >= tol) dx = 0;
          if (!best || Math.hypot(dx, dy) < Math.hypot(best.dx, best.dy)) best = { dx, dy };
        }
      if (!best) continue;
      for (const pb of pa) {
        const shifted = { x: pb.x + best.dx, y: pb.y + best.dy, w: pb.w, h: pb.h };
        // Bestaat er op q al een vak op die plek? Dan niets doen.
        if (q.boxes.some((b) => overlapArea(b, shifted) > 0.3 * shifted.w * shifted.h)) continue;
        const cur = predictions.get(pb.kind);
        const r = { x0: shifted.x, y0: shifted.y, x1: shifted.x + shifted.w, y1: shifted.y + shifted.h };
        if (!cur) predictions.set(pb.kind, { ...r, rot: pb.rot, n: 1 });
        else predictions.set(pb.kind, { x0: Math.min(cur.x0, r.x0), y0: Math.min(cur.y0, r.y0), x1: Math.max(cur.x1, r.x1), y1: Math.max(cur.y1, r.y1), rot: cur.rot, n: cur.n + 1 });
      }
    }
    for (const [kind, r0] of predictions) {
      // Onrealistisch grote voorspellingen negeren
      if (r0.x1 - r0.x0 > 0.4 || r0.y1 - r0.y0 > 0.25) continue;
      // Extra marge: een afgeleid vak is minder precies.
      const mx = (r0.x1 - r0.x0) * 0.15;
      const my = (r0.y1 - r0.y0) * 0.15;
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
 * meegenomen binnen een venster dat 60% groter is. Werkt in genormaliseerde coördinaten.
 */
export function refineWithInk(mask: InkMask, W: number, H: number, b: { x: number; y: number; w: number; h: number }) {
  const r: PxRect = { x0: b.x * W, y0: b.y * H, x1: (b.x + b.w) * W, y1: (b.y + b.h) * H };
  const ex = (r.x1 - r.x0) * 0.6;
  const ey = (r.y1 - r.y0) * 0.6;
  const win: PxRect = { x0: Math.max(0, r.x0 - ex), y0: Math.max(0, r.y0 - ey), x1: Math.min(W, r.x1 + ex), y1: Math.min(H, r.y1 + ey) };
  const g = mask.grow(r, win);
  const u = union(r, g)!;
  const pad = 0.01 * Math.min(W, H);
  const x0 = Math.max(0, u.x0 - (g && g.x0 < r.x0 ? pad : 0));
  const y0 = Math.max(0, u.y0 - (g && g.y0 < r.y0 ? pad : 0));
  const x1 = Math.min(W, u.x1 + (g && g.x1 > r.x1 ? pad : 0));
  const y1 = Math.min(H, u.y1 + (g && g.y1 > r.y1 ? pad : 0));
  return { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
}
