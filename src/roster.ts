// Leerlinglijst inlezen (CSV of Excel .xlsx) en snel zoeken op een paar letters.
// Alles in het geheugen; de lijst wordt nooit opgeslagen.
import { unzipSync, strFromU8 } from 'fflate';

export interface Student {
  id: string;
  /** Weergavenaam, bijv. "Sem de Vries". */
  name: string;
  /** Leerlingnummer (kan leeg zijn). */
  nr: string;
  klas: string;
  /** Plek in de lijst (1, 2, 3, …). */
  pos: number;
  /** Tijdens het koppelen toegevoegd (stond niet in het bestand). */
  extra?: boolean;
  norm: string;
  words: string[];
}

export interface Roster {
  students: Student[];
  /** Waar de lijst vandaan komt (bestandsnaam). */
  source: string;
  /** Welke kolommen gebruikt zijn (voor de gebruiker). */
  columns: string;
}

/** "Niet in lijst / onleesbaar". */
export const UNK = '?';

export const TUSSEN = new Set(['van', 'de', 'der', 'den', 'het', 'ter', 'ten', 'te', 'in', 'op', 'la', 'le', 'du', 'el', 'al', 'von', 't', 'd', 'l', 'da', 'dos', 'di', 'del', 'bin', 'ben', 'aan', 'uit', 'vd']);

/** Kleine letters, zonder accenten en leestekens; spaties blijven (één tussen elk woord). */
export function normName(s: string) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function makeStudent(name: string, id: string, pos: number, nr = '', klas = '', extra = false): Student {
  const n = name.trim().replace(/\s+/g, ' ');
  const norm = normName(n);
  return { id, name: n, nr: nr.trim(), klas: klas.trim(), pos, extra: extra || undefined, norm, words: norm.split(' ').filter(Boolean) };
}

// ───────────────────────── Bestanden lezen ─────────────────────────

/** Tekst uit een bestand: UTF-8, en anders Windows-1252 (oude Excel-CSV's). */
export function decodeText(bytes: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** CSV met puntkomma's, komma's of tabs (automatisch herkend). Aanhalingstekens mogen. */
export function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, '');
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 8);
  const count = (ch: string) => sample.reduce((a, l) => a + l.split(ch).length - 1, 0);
  const sep = [';', '\t', ','].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ';');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell.trim());
  rows.push(row);
  return rows.filter((r) => r.some((c) => c));
}

function xmlText(s: string) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Alle tekst in <t>-elementen (ook bij opgemaakte tekst met meerdere stukjes). */
function allT(xml: string) {
  let out = '';
  // Alleen <t> (ook in opgemaakte stukjes <r>), niet de uitspraak-hulp <rPh>.
  for (const m of xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += m[1];
  return xmlText(out);
}

function colIndex(ref: string) {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Het eerste werkblad van een Excel-bestand (.xlsx) als tabel met tekst. */
export function readXlsx(bytes: Uint8Array): string[][] {
  const files = unzipSync(bytes, { filter: (f) => f.name.startsWith('xl/') && /\.(xml|rels)$/.test(f.name) });
  const get = (name: string) => (files[name] ? strFromU8(files[name]) : '');
  // Eerste blad volgens het werkboek (de volgorde van de tabbladen).
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(get('xl/workbook.xml'))?.[1];
  if (rid) {
    const rel = new RegExp(`<Relationship\\b[^>]*\\bId="${rid}"[^>]*>`).exec(get('xl/_rels/workbook.xml.rels'))?.[0];
    const target = rel && /\bTarget="([^"]+)"/.exec(rel)?.[1];
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
  }
  const sheet = get(sheetPath) || get(Object.keys(files).find((f) => /^xl\/worksheets\/[^/]+\.xml$/.test(f)) ?? '');
  if (!sheet) throw new Error('Geen werkblad gevonden in dit Excel-bestand.');
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => allT(m[1]));
  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row: string[] = [];
    let next = 0;
    for (const cm of (rm[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const col = ref ? colIndex(ref) : next;
      next = col + 1;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const body = cm[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let val = '';
      if (type === 's') val = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') val = allT(body);
      else if (type === 'b') val = '';
      else if (v !== undefined) val = xmlText(v);
      while (row.length < col) row.push('');
      row[col] = val.trim();
    }
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c));
}

/** Tabel uit een geüpload bestand (CSV/TXT of XLSX). */
export function readTable(bytes: Uint8Array, fileName: string): string[][] {
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (zip) return readXlsx(bytes);
  if (/\.xls$/i.test(fileName) || (bytes[0] === 0xd0 && bytes[1] === 0xcf))
    throw new Error('Het oude Excel-formaat (.xls) wordt niet ondersteund. Sla het bestand in Excel op als .xlsx of .csv.');
  return parseCsv(decodeText(bytes));
}

// ───────────────────────── Kolommen herkennen ─────────────────────────

const H = (s: string) => normName(s).replace(/ /g, '');
const COLS: Record<'naam' | 'roep' | 'voor' | 'tv' | 'achter' | 'nr' | 'klas', RegExp> = {
  naam: /^(naam|volledigenaam|leerling|leerlingnaam|naamleerling|name|fullname|student|studentnaam|weergavenaam|naamkandidaat|kandidaat)$/,
  roep: /^(roepnaam|roepnaamleerling)$/,
  voor: /^(voornaam|voornamen|firstname|givenname)$/,
  tv: /^(tussenvoegsel|tussenvoegsels|tv|voorvoegsel|voorvoegsels|prefix)$/,
  achter: /^(achternaam|familienaam|lastname|surname|geslachtsnaam)$/,
  nr: /^(leerlingnummer|leerlingnr|llnr|llnnr|lnr|stamnummer|studentnummer|studentnr|examennummer|kandidaatnummer|nummer|nr|id)$/,
  klas: /^(klas|klassen|groep|stamgroep|class|basisgroep|stamklas)$/,
};

/** Zet "Vries, Sem de" om in "Sem de Vries". */
export function fixCommaName(s: string) {
  const m = /^([^,]+),\s*(.+)$/.exec(s.trim());
  if (!m) return s.trim();
  // Na de komma: voornaam, eventueel gevolgd door tussenvoegsels ("Sem de").
  return `${m[2].trim()} ${m[1].trim()}`.replace(/\s+/g, ' ');
}

/** Leerlingen uit een tabel: zoekt de kopregel (hoeft niet de eerste regel te zijn). */
export function rosterFromRows(rows: string[][], source = ''): Roster {
  type Col = keyof typeof COLS;
  let head = -1;
  let map: Partial<Record<Col, number>> = {};
  for (let r = 0; r < Math.min(rows.length, 15) && head < 0; r++) {
    const m: Partial<Record<Col, number>> = {};
    rows[r].forEach((c, i) => {
      const h = H(c);
      for (const k of Object.keys(COLS) as Col[]) if (m[k] === undefined && COLS[k].test(h)) m[k] = i;
    });
    const hasName = m.naam !== undefined || (m.achter !== undefined && (m.roep !== undefined || m.voor !== undefined));
    if (hasName) {
      head = r;
      map = m;
    }
  }
  let cols: string[];
  let start: number;
  if (head < 0) {
    // Geen kopregel: de kolom met de meeste namen (letters, geen e-mailadres).
    const width = Math.max(...rows.map((r) => r.length));
    let best = 0;
    let bestScore = -1;
    for (let i = 0; i < width; i++) {
      const score = rows.filter((r) => /[a-z]{2}/i.test(r[i] ?? '') && !/@/.test(r[i] ?? '')).length;
      if (score > bestScore) [best, bestScore] = [i, score];
    }
    map = { naam: best };
    start = 0;
    cols = [`kolom ${best + 1}`];
  } else {
    start = head + 1;
    const h = rows[head];
    const first = map.roep ?? map.voor;
    cols =
      map.achter !== undefined && first !== undefined
        ? [[first, map.tv, map.achter].filter((x) => x !== undefined).map((i) => h[i!]).join(' + ')]
        : [h[map.naam!]];
    if (map.nr !== undefined) cols.push(h[map.nr]);
    if (map.klas !== undefined) cols.push(h[map.klas]);
  }
  const at = (r: string[], i?: number) => (i === undefined ? '' : (r[i] ?? '').trim());
  const students: Student[] = [];
  for (let r = start; r < rows.length; r++) {
    const row = rows[r];
    const first = at(row, map.roep) || at(row, map.voor);
    let name = '';
    if (map.achter !== undefined && first) name = [first, at(row, map.tv), at(row, map.achter)].filter(Boolean).join(' ');
    else if (map.naam !== undefined) name = fixCommaName(at(row, map.naam));
    else if (map.achter !== undefined) name = [at(row, map.tv), at(row, map.achter)].filter(Boolean).join(' ');
    if (!/[a-z]/i.test(normName(name))) continue;
    if (/^(totaal|aantal|gemiddelde)\b/i.test(name)) continue;
    students.push(makeStudent(name, `s${students.length + 1}`, students.length + 1, at(row, map.nr), at(row, map.klas)));
  }
  return { students, source, columns: cols.join(', ') };
}

// ───────────────────────── Zoeken ─────────────────────────

export interface Match {
  s: Student;
  score: number;
  toks: string[];
}

/**
 * Leerlingen die passen bij wat er getypt is: begin van voor- of achternaam, meerdere stukjes
 * ("s bak"), initialen ("lv", "tvdb" of "tb"), cijfers van het leerlingnummer. Wie al een toets
 * heeft (`taken`), zakt iets in de volgorde. Een volledig uitgetypte naam wint altijd.
 */
export function search(students: Student[], query: string, taken: (s: Student) => boolean = () => false): Match[] {
  const raw = normName(query);
  const toks = raw.split(' ').filter(Boolean);
  if (!toks.length) return students.map((s) => ({ s, score: 0, toks }));
  const out: Match[] = [];
  for (const s of students) {
    let score = 0;
    for (const t of toks) {
      let best = -1;
      if (/^\d+$/.test(t) && s.nr && normName(s.nr).replace(/ /g, '').startsWith(t)) best = 100;
      s.words.forEach((w, wi) => {
        // Een heel woord ("mila") gaat vóór een langer woord ("milan").
        if (w.startsWith(t)) best = Math.max(best, (wi === 0 ? 100 : 80 - Math.min(wi, 5)) + (w === t ? 5 : 0));
        else if (t.length > 2 && w.includes(t)) best = Math.max(best, 30);
      });
      if (best < 0 && t.length > 2 && s.norm.replace(/ /g, '').includes(t)) best = 20;
      if (best < 0) {
        score = -1;
        break;
      }
      score += best;
    }
    // Initialen: "lv" = Lieke Visser, "tvdb" of "tb" = Tess van den Berg
    if (toks.length === 1 && toks[0].length >= 2 && toks[0].length <= 5 && /^[a-z]+$/.test(toks[0])) {
      const t = toks[0];
      const all = s.words.map((w) => w[0]).join('');
      const main = s.words.filter((w) => !TUSSEN.has(w)).map((w) => w[0]).join('');
      const ini = t === all || t === main ? 90 : all.startsWith(t) || main.startsWith(t) ? 55 : -1;
      if (ini > score) score = ini;
    }
    if (score >= 0) {
      if (taken(s)) score -= 15;
      out.push({ s, score, toks });
    }
  }
  out.sort((a, b) => b.score - a.score || a.s.pos - b.s.pos);
  const exact = out.filter((m) => m.s.norm === raw);
  return exact.length ? exact : out;
}

/**
 * Leerling waarvan de naam in de bestandsnaam staat (bijv. "jansen piet.pdf"), als dat er
 * precies één is. Alleen woorden van minstens 2 letters die geen tussenvoegsel zijn tellen.
 */
export function suggestFromFileName(students: Student[], fileName: string): Student | null {
  const toks = new Set(normName(fileName.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/\(deel \d+\)/gi, '')).split(' '));
  const hits = students.filter((s) => {
    const main = s.words.filter((w) => !TUSSEN.has(w) && w.length >= 2);
    return main.length >= 2 && main.every((w) => toks.has(w));
  });
  return hits.length === 1 ? hits[0] : null;
}

/** Sleutel om een leerling in een nieuwe versie van de lijst terug te vinden. */
export const studentKey = (s: Student) => (s.nr ? `nr:${s.nr}` : `naam:${s.norm}`);
