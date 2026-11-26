import './styles.css';
import { zipSync } from 'fflate';
import { DEFAULT_SETTINGS, type Box, type BoxKind, type PageState, type Rot, type Settings } from './types';
import { openFile, isSupported, release, withRotation, type Source } from './pdfio';
import { detectPage, norm } from './detect';
import { analyzeClassSplit, completeFromPeers, printedSimilarity, SAME_SHEET, InkMask, nameTokensFromFileName, refineWithInk } from './detect-core';
import { setWorkerCount, defaultWorkerCount, onOcrStatus } from './ocr';
import { applyRedactions, exportDocument, verifyOutput, combineDocuments, type VerifyResult } from './redact';
import { el, uid, uniqueNumber, fillTemplate, safeFileName, download, toCsv, fmtBytes } from './util';
import { openMatcher, matchState, matchChip, rosterNames, studentById } from './match';
import { UNK } from './roster';
import { openQuickFix } from './quickfix';

// ───────────────────────── State ─────────────────────────

interface Doc {
  id: string;
  name: string;
  file: File;
  src: Source | null;
  pages: PageState[];
  num: number;
  status: 'laden' | 'klaar' | 'fout';
  error?: string;
  exported?: boolean;
  /** Per pagina: uit welk geopend bestand en welke pagina daarin (splitsen/samenvoegen). */
  parts?: { raw: Raw; idx: number }[];
  /** Gemiddelde bestandsgrootte per pagina van het origineel (voor automatische kwaliteit). */
  bpp?: number;
  /** Al bekeken of dit een scan van de hele klas is (niet nog eens automatisch splitsen). */
  splitChecked?: boolean;
  /** Lijkt een klassenscan, maar niet zeker genoeg: voorgestelde splitspunten. */
  splitSuggest?: number[];
  /** Waar dit deel vandaan komt en waarom zo gesplitst (voor het analysevenster). */
  splitInfo?: SplitInfo;
  /** Gekoppelde leerling uit de leerlinglijst (id), of UNK = niet in lijst. Alleen in het geheugen. */
  student?: string;
}

interface SplitInfo {
  /** Naam van het oorspronkelijke bestand. */
  from: string;
  /** Delen uit dezelfde splitsing hebben dezelfde batch (om de splitsing later aan te passen). */
  batch: string;
  /** Hoe er gesplitst is, bijv. "automatisch (voorblad)" of "handmatig". */
  how: string;
  /** Afwegingen van de splitsheuristiek. */
  log: string[];
  part: number;
  total: number;
  /** Paginanummers (1-based) in het oorspronkelijke bestand. */
  first: number;
  last: number;
}

/** Een geopend bronbestand; kan door meerdere documenten gedeeld worden. */
interface Raw {
  src: Source;
  refs: number;
  bpp: number;
}

function makeView(d: Doc): Source {
  const parts = d.parts!;
  const view: Source = {
    numPages: parts.length,
    sizes: parts.map((p) => p.raw.src.sizes[p.idx]),
    render: (i, dpi, display) => parts[i].raw.src.render(parts[i].idx, dpi, display),
    destroy: () => {},
  };
  return withRotation(view, (i) => d.pages[i]?.userRot ?? 0);
}

/** Maak een document dat (een deel van) bestaande bronnen gebruikt. */
function attachParts(d: Doc, parts: { raw: Raw; idx: number }[]) {
  d.parts = parts;
  for (const r of new Set(parts.map((p) => p.raw))) r.refs++;
  d.bpp = parts.reduce((a, p) => a + p.raw.bpp, 0) / Math.max(1, parts.length);
  d.src = makeView(d);
}

function releaseDoc(d: Doc) {
  for (const r of new Set((d.parts ?? []).map((p) => p.raw))) if (--r.refs <= 0) r.src.destroy();
  d.parts = undefined;
}

interface ExportResult {
  doc: Doc;
  fileName: string;
  bytes: Uint8Array;
  verify: VerifyResult;
}

const SKEY = 'namenweg.settings.v1';
function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SKEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  try {
    localStorage.setItem(SKEY, JSON.stringify(S));
  } catch {
    /* privévenster: niet erg */
  }
}

const S: Settings = loadSettings();
setWorkerCount(S.ocrWorkers);
const docs: Doc[] = [];
let cur: Doc | null = null;
let curPage = 0;
let selBox: string | null = null;
let zoom: number | 'fit' = 'fit';
let preview = false;
let lastExport: ExportResult[] = [];
/** Extra namen om te zoeken (bijv. een klassenlijst). Alleen in het geheugen, nooit opgeslagen. */
let extraNames = '';

function namesFor(d: Doc): string[] {
  const own = S.searchFileNames ? nameTokensFromFileName(d.name, S) : [];
  const extra = [extraNames, ...rosterNames()]
    .join('\n')
    .split(/[\n,;]+/)
    .flatMap((line) => nameTokensFromFileName(line.trim() + '.x', S));
  return [...new Set([...own, ...extra])];
}

type Snap = { doc: Doc; page: number; boxes: Box[] };
const undoStack: Snap[] = [];
const redoStack: Snap[] = [];

const docText = (d: Doc) => fillTemplate(S.template, d.num);
const page = () => cur?.pages[curPage] ?? null;

function snapshot() {
  const p = page();
  if (!cur || !p) return;
  undoStack.push({ doc: cur, page: curPage, boxes: structuredClone(p.boxes) });
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}
function undo(redo = false) {
  const from = redo ? redoStack : undoStack;
  const to = redo ? undoStack : redoStack;
  const s = from.pop();
  if (!s) return;
  const p = s.doc.pages[s.page];
  to.push({ doc: s.doc, page: s.page, boxes: structuredClone(p.boxes) });
  p.boxes = s.boxes;
  cur = s.doc;
  curPage = s.page;
  selBox = null;
  renderAll();
}

// ───────────────────────── Layout ─────────────────────────

const app = document.getElementById('app')!;
const fileInput = el('input', { type: 'file', multiple: true, accept: 'application/pdf,.pdf,image/*', hidden: true });
const docList = el('div', { class: 'doclist' });
let onlyAttention = false;
const attentionToggle = el('label', { class: 'check filter', hidden: true }, el('input', { type: 'checkbox', onchange: (e: Event) => {
  onlyAttention = (e.target as HTMLInputElement).checked;
  renderDocList();
} }), el('span', {}, 'Alleen documenten met aandachtspunten'));

/** Heeft dit document iets dat de gebruiker moet bekijken? */
function needsAttention(d: Doc) {
  if (d.status === 'fout') return true;
  if (d.status !== 'klaar') return false;
  const anyDone = d.pages.some((p) => p.detect === 'klaar');
  const hasNaam = d.pages.some((p) => p.boxes.some((b) => b.kind === 'naam' || b.text));
  return (anyDone && !hasNaam) || suspiciousPages(d).length > 0 || d.pages.some((p) => p.detect === 'fout');
}
const toolbar = el('div', { class: 'toolbar' });
const editor = el('div', { class: 'editor', tabindex: '0' });
const strip = el('div', { class: 'strip' });
const inspector = el('aside', { class: 'right' });
const statusMsg = el('span', {}, 'Klaar. Voeg PDF-bestanden toe om te beginnen.');
const offlineBadge = el(
  'button',
  { class: 'offline-badge', hidden: true, onclick: () => openHelp('privacy'), title: 'Alle onderdelen zijn op deze computer opgeslagen: de app werkt nu ook zonder internet.' },
  '✓ werkt offline',
);
const progressBar = el('div');
const progress = el('div', { class: 'progress', hidden: true }, progressBar);
const btnStop = el('button', { class: 'btn small', hidden: true, onclick: () => stopDetect(), title: 'Automatische detectie stoppen' }, '⏹ Stop');
/** Goed zichtbare melding boven de pagina zolang er iets verwerkt wordt (inlezen, OCR, exporteren). */
const busyMsg = el('span', { class: 'busy-msg' });
const busyBanner = el('div', { class: 'busy-banner', hidden: true, role: 'status', 'aria-live': 'polite' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), busyMsg, progress, btnStop);

/** Menu-item (knop in een uitklapmenu). */
const mi = (label: string, onclick: () => void, title = '', cls = '') => el('button', { class: 'mi ' + cls, onclick, title, role: 'menuitem' }, label);
/** Uitklapmenu: een knop die een lijst met minder vaak gebruikte acties toont. */
function menu(key: string, label: string, title: string, items: (HTMLElement | null)[], cls = '') {
  const d = el(
    'details',
    { class: 'menu ' + cls, 'data-key': key },
    el('summary', { class: 'btn', title, 'aria-label': title }, label),
    el('div', { class: 'menu-list', role: 'menu' }, ...items),
  ) as HTMLDetailsElement;
  d.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.menu-list button')) d.open = false;
  });
  return d;
}
const menuHead = (t: string) => el('div', { class: 'mh' }, t);
document.addEventListener('pointerdown', (e) => {
  for (const d of document.querySelectorAll<HTMLDetailsElement>('details.menu[open]')) if (!d.contains(e.target as Node)) d.open = false;
});
/** Bij opnieuw opbouwen van een paneel: open menu's en uitklapblokken open laten. */
function keepOpen(root: HTMLElement, build: () => void) {
  const open = new Set([...root.querySelectorAll<HTMLElement>('details[open][data-key]')].map((d) => d.dataset.key));
  build();
  for (const d of root.querySelectorAll<HTMLDetailsElement>('details[data-key]')) if (open.has(d.dataset.key)) d.open = true;
}

const themeBtn = mi('', cycleTheme);
const btnDetectAll = mi('🔍 Alles opnieuw detecteren', () => detectAll(true));
const btnExportAll = el('button', { class: 'btn primary', onclick: () => exportAll() }, '⬇ Exporteer alles');
const btnKey = mi('🗝 Sleutelbestand (CSV)', downloadKey, 'Welke kandidaat is wie (blijft op je computer)');
const btnRenumber = mi('🎲 Alle nummers opnieuw', renumberAll, 'Geef alle documenten nieuwe willekeurige nummers');
const btnOverview = el('button', { class: 'btn', onclick: () => openOverview(), title: "Alle pagina's in één overzicht controleren" }, '🔎 Controle-overzicht');
const btnMatch = el('button', { class: 'btn', onclick: () => startMatcher(), title: 'Koppel elke toets aan een leerling uit de leerlinglijst (CSV/Excel); de koppeling komt in het sleutelbestand' }, '👥 Leerlingen koppelen');
const miMatch = mi('👥 Leerlingen koppelen…', () => startMatcher(), 'Toetsen koppelen aan een leerlinglijst (CSV/Excel)');
const quickFix = () => openQuickFix(S, (m) => toast(m));
const miQuick = mi('✏️ Snel wissen in een PDF…', quickFix, 'Iets gemist in een geëxporteerde PDF? Vak tekenen en opslaan, zonder tekstherkenning of splitsen');
const btnTemplates = mi('📐 Sjablonen…', () => openTemplates(), 'Vaklayout opslaan of toepassen');
const btnClear = mi('🗑 Alles wissen', clearAll, '', 'danger');

function commitLink(): HTMLElement | string {
  if (!__COMMIT__) return '';
  return el('a', {
    class: 'commit',
    href: `https://github.com/tomkooij/namenweg/commit/${__COMMIT__}`,
    target: '_blank',
    rel: 'noopener noreferrer',
    title: 'Deze versie op GitHub bekijken',
  }, __COMMIT__.slice(0, 7));
}

app.append(
  el(
    'header',
    { class: 'top' },
    el('div', { class: 'brand' }, el('img', { src: './favicon.svg', alt: '' }), 'NamenWeg', commitLink(), el('small', {}, 'toetsen anonimiseren')),
    el('button', { class: 'privacy', onclick: () => openHelp('privacy'), title: 'Hoe wordt mijn privacy beschermd?' }, '🔒 100% lokaal – er wordt niets geüpload'),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn', onclick: () => openHelp() }, '❓ Help'),
    menu('main', '☰ Menu', 'Meer opties', [
      miQuick,
      el('hr'),
      menuHead('Alle documenten'),
      btnDetectAll,
      btnTemplates,
      miMatch,
      btnKey,
      btnRenumber,
      btnClear,
      el('hr'),
      mi('⚙ Instellingen…', openSettings),
      themeBtn,
    ], 'right'),
  ),
  el(
    'main',
    { class: 'layout' },
    el(
      'aside',
      {},
      el(
        'div',
        { class: 'section' },
        el(
          'div',
          { class: 'drop', onclick: () => fileInput.click(), id: 'drop' },
          el('strong', {}, 'PDF\'s of scans toevoegen'),
          'Sleep bestanden hierheen of klik om te kiezen',
        ),
        fileInput,
      ),
      attentionToggle,
      docList,
      el('div', { class: 'actions' }, btnOverview, btnMatch, btnExportAll),
    ),
    el('section', { class: 'center' }, toolbar, el('div', { class: 'editor-wrap' }, editor, busyBanner), strip),
    inspector,
  ),
  el('footer', { class: 'status' }, statusMsg, el('span', { class: 'spacer' }), offlineBadge),
);

fileInput.addEventListener('change', () => {
  if (fileInput.files) addFiles([...fileInput.files]);
  fileInput.value = '';
});

// Slepen en neerzetten op het hele venster
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) addFiles(files);
});

window.addEventListener('beforeunload', (e) => {
  if (docs.some((d) => !d.exported) || matchState.dirty) {
    e.preventDefault();
  }
});

// ───────────────────────── Status ─────────────────────────

function setStatus(msg: string) {
  statusMsg.textContent = msg;
  busyMsg.textContent = msg;
}
let busyLoad = false;
let busyExport = false;
/** Toon/verberg de verwerkingsmelding boven de pagina. */
function updateBusy() {
  const det = detectQueue.length > 0 || detectRunning > 0;
  btnStop.hidden = !det;
  busyBanner.hidden = !(det || busyLoad || busyExport);
  markScan();
}
/** Pagina die nu door de OCR gaat (of in de wachtrij staat) zichtbaar markeren. */
const scanning = new Set<PageState>();
function markScan() {
  const p = page();
  if (!stage) return;
  const state = p && scanning.has(p) ? 'bezig' : p?.detect === 'bezig' ? 'wacht' : '';
  if (!state) {
    delete stage.dataset.scan;
    delete stage.dataset.scanmsg;
    return;
  }
  stage.dataset.scan = state;
  stage.dataset.scanmsg = state === 'bezig' ? 'Tekst op deze pagina wordt herkend…' : 'In de wachtrij voor tekstherkenning…';
}
function setProgress(done: number, total: number) {
  progress.hidden = total === 0 || done >= total;
  progressBar.style.width = total ? `${(100 * done) / total}%` : '0';
}
onOcrStatus((m) => m && setStatus(m));

let toastTimer = 0;
type ToastAction = { label: string; run: () => void };
function toast(msg: string, action?: ToastAction | ToastAction[]) {
  document.querySelector('.toast')?.remove();
  const actions = action ? (Array.isArray(action) ? action : [action]) : [];
  const t = el(
    'div',
    { class: 'toast', role: 'status' },
    el('span', {}, msg),
    ...actions.map((a) => el('button', { class: 'toast-btn', onclick: () => { t.remove(); a.run(); } }, a.label)),
  );
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.remove(), actions.length ? 20000 : 3500);
}

// ───────────────────────── Bestanden ─────────────────────────

function usedNumbers(except?: Doc) {
  return new Set(docs.filter((d) => d !== except).map((d) => d.num));
}

async function addFiles(files: File[]) {
  const ok = files.filter(isSupported);
  if (ok.length < files.length) toast(`${files.length - ok.length} bestand(en) overgeslagen: alleen PDF en afbeeldingen.`);
  if (!ok.length) return;
  ok.sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  const added: Doc[] = [];
  for (const f of ok) {
    const d: Doc = { id: uid(), name: f.name, file: f, src: null, pages: [], num: uniqueNumber(S.numMin, S.numMax, usedNumbers()), status: 'laden' };
    docs.push(d);
    added.push(d);
  }
  if (!cur) {
    cur = added[0];
    curPage = 0;
  }
  renderAll();
  busyLoad = true;
  updateBusy();
  let i = 0;
  for (const d of added) {
    setStatus(`Inlezen: ${++i}/${added.length}…`);
    setProgress(i - 1, added.length);
    try {
      const src = await openFile(d.file);
      const raw: Raw = { src, refs: 0, bpp: d.file.size / Math.max(1, src.numPages) };
      attachParts(d, Array.from({ length: src.numPages }, (_, idx) => ({ raw, idx })));
      d.pages = src.sizes.map((s, index) => ({ index, wPt: s.w, hPt: s.h, boxes: [], detect: 'nog niet' }));
      d.status = 'klaar';
    } catch (e) {
      d.status = 'fout';
      d.error = e instanceof Error ? e.message : String(e);
    }
    renderDocList();
    if (d === cur) renderAll();
    else renderInspector();
    makeThumbs(d);
  }
  setProgress(0, 0);
  busyLoad = false;
  updateBusy();
  setStatus(`${added.length} document(en) ingelezen.`);
  if (S.autoDetect) detectDocs(added.filter((d) => d.status === 'klaar'));
}

async function makeThumbs(d: Doc) {
  if (!d.src) return;
  for (const p of d.pages) {
    if (p.thumb) continue;
    try {
      const c = await d.src.render(p.index, 16);
      p.thumb = c.toDataURL('image/jpeg', 0.7);
      release(c);
    } catch {
      /* geen miniatuur */
    }
    if (d === cur) renderStrip();
  }
}

function removeDoc(d: Doc) {
  const i = docs.indexOf(d);
  if (i < 0) return;
  releaseDoc(d);
  docs.splice(i, 1);
  dropFromQueue(d);
  if (cur === d) {
    cur = docs[Math.min(i, docs.length - 1)] ?? null;
    curPage = 0;
    selBox = null;
  }
  renderAll();
}

function clearAll() {
  if (!docs.length) return;
  if (!confirm('Alle documenten uit het geheugen verwijderen? Niet-geëxporteerd werk gaat verloren.')) return;
  for (const d of [...docs]) releaseDoc(d);
  docs.length = 0;
  detectQueue.length = 0;
  cur = null;
  curPage = 0;
  selBox = null;
  lastExport = [];
  undoStack.length = redoStack.length = 0;
  canvasCache.clear();
  renderAll();
  setStatus('Alles gewist.');
}

// ───────────────────────── Splitsen ─────────────────────────

/** Deel een document op in meerdere documenten (bijv. één scan van de hele klas). */
function splitDoc(d: Doc, starts: number[], quiet = false, how = 'handmatig', log: string[] = []): Doc[] {
  const s = [...new Set(starts.filter((i) => i > 0 && i < d.pages.length))].sort((a, b) => a - b);
  if (!s.length || !d.parts) return [];
  const bounds = [0, ...s, d.pages.length];
  const used = usedNumbers(d);
  const batch = uid();
  const parts: Doc[] = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const idx = Array.from({ length: bounds[k + 1] - bounds[k] }, (_, j) => bounds[k] + j);
    const num = k === 0 ? d.num : uniqueNumber(S.numMin, S.numMax, used);
    used.add(num);
    const nd: Doc = {
      id: uid(),
      name: `${d.name} (deel ${k + 1})`,
      file: d.file,
      src: null,
      pages: idx.map((i, j) => ({ ...structuredClone(d.pages[i]), index: j, boxes: d.pages[i].boxes.map((b) => ({ ...b, id: uid() })) })),
      num,
      // Het eerste deel houdt de koppeling met de leerling; de rest moet opnieuw gekoppeld worden.
      student: k === 0 ? d.student : undefined,
      status: 'klaar',
      splitChecked: true,
      splitInfo: { from: d.splitInfo?.from ?? d.name, batch, how, log, part: k + 1, total: bounds.length - 1, first: idx[0] + 1, last: idx[idx.length - 1] + 1 },
    };
    attachParts(nd, idx.map((i) => d.parts![i]));
    parts.push(nd);
  }
  releaseDoc(d); // d zelf verdwijnt; de delen houden de bron vast
  dropFromQueue(d);
  const at = docs.indexOf(d);
  docs.splice(at, 1, ...parts);
  if (cur === d) {
    cur = parts[0];
    curPage = 0;
    selBox = null;
  }
  undoStack.length = redoStack.length = 0;
  if (!quiet) toast(`Opgesplitst in ${parts.length} documenten.`);
  renderAll();
  return parts;
}

/** Plak documenten achter elkaar (bijv. een apart gescande uitwerkbijlage). */
function mergeDocs(list: Doc[], name = list.map((d) => d.name).join(' + '), quiet = false): Doc | null {
  if (list.length < 2 || list.some((d) => !d.parts)) return null;
  const nd: Doc = {
    id: uid(),
    name,
    file: list[0].file,
    src: null,
    pages: list.flatMap((d) => d.pages).map((p, j) => ({ ...structuredClone(p), index: j, boxes: p.boxes.map((x) => ({ ...x, id: uid() })) })),
    num: list[0].num,
    student: list.find((d) => d.student !== undefined)?.student,
    status: 'klaar',
    splitChecked: true,
  };
  attachParts(nd, list.flatMap((d) => d.parts!));
  for (const d of list) {
    releaseDoc(d);
    dropFromQueue(d);
  }
  docs.splice(docs.indexOf(list[0]), 1, nd);
  for (const d of list.slice(1)) docs.splice(docs.indexOf(d), 1);
  cur = nd;
  curPage = 0;
  selBox = null;
  undoStack.length = redoStack.length = 0;
  if (!quiet) toast(`Samengevoegd: ${nd.pages.length} pagina's.`);
  renderAll();
  return nd;
}

/** De documenten die samen uit één splitsing komen (of alleen d zelf). */
function splitGroup(d: Doc): Doc[] {
  const b = d.splitInfo?.batch;
  return b ? docs.filter((x) => x.splitInfo?.batch === b) : [d];
}

/** Splitsing (opnieuw) toepassen op een groep documenten; kandidaatnummers zoveel mogelijk behouden. */
function applySplitEdit(list: Doc[], starts: number[], how: string, log: string[] = []) {
  const oldNums = list.map((d) => d.num);
  const oldStudents = list.map((d) => d.student);
  const name = list[0].splitInfo?.from ?? list[0].name;
  const base = list.length > 1 ? mergeDocs(list, name, true) : list[0];
  if (!base) return;
  base.splitSuggest = undefined;
  if (!starts.length) {
    base.splitInfo = undefined;
    toast(`Niet gesplitst: "${name}" is één document (${base.pages.length} pagina's).`);
    renderAll();
    return;
  }
  const parts = splitDoc(base, starts, true, how, log);
  const keep = oldNums.slice(0, parts.length);
  const taken = new Set([...docs.filter((x) => !parts.includes(x)).map((x) => x.num), ...keep]);
  parts.forEach((p, k) => {
    p.student = oldStudents[k];
    if (k < keep.length) p.num = keep[k];
    else if (taken.has(p.num)) p.num = uniqueNumber(S.numMin, S.numMax, taken);
    taken.add(p.num);
  });
  toast(`Opgesplitst in ${parts.length} documenten.`);
  renderAll();
}

const SR_SIZE_KEY = 'namenweg.splitsvenster.grootte';
const SR_FULL_KEY = 'namenweg.splitsvenster.vol';
const SR_SHOW_KEY = 'namenweg.splitsvenster.weergave';
/** vakken = scan met de weg te halen vakken erover; uitvoer = zoals de export; origineel = alleen de scan. */
type SrShow = 'vakken' | 'uitvoer' | 'origineel';
function srPref(key: string, def: string) {
  try {
    return localStorage.getItem(key) ?? def;
  } catch {
    return def;
  }
}
function srSave(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* privévenster: niet erg */
  }
}

/**
 * Venster met het splitsresultaat: alle pagina's van het oorspronkelijke bestand, één rij per
 * kandidaat (standaard schermvullend). Aanpassen kan door:
 * - op ✂ tussen twee pagina's te klikken (daar begint een nieuwe kandidaat);
 * - een pagina naar een andere rij te slepen (de grens schuift mee; de volgorde blijft gelijk);
 * - "Samenvoegen met vorige" of een van de snelknoppen.
 * Klik op een pagina voor een grote weergave. Pas bij "Toepassen" verandert er iets.
 */
function openSplitReview(list: Doc[], initial?: number[], onDone?: () => void) {
  if (list.some((d) => detectQueue.some((j) => j.doc === d) || d.pages.some((p) => p.detect === 'bezig'))) {
    toast('Wacht tot de detectie van dit document klaar is.');
    return;
  }
  const pages = list.flatMap((d) => d.pages);
  // Per pagina: uit welk document en welke pagina daarin (om scherper te kunnen renderen).
  const where = list.flatMap((d) => d.pages.map((_, j) => ({ d, j })));
  const n = pages.length;
  const from = list[0].splitInfo?.from ?? list[0].name;
  const bounds: number[] = [];
  list.reduce((a, d) => (bounds.push(a), a + d.pages.length), 0);
  let starts = new Set(initial ?? bounds.slice(1));
  const naam = (i: number) => pages[i].boxes.some((b) => b.kind === 'naam');
  const voorblad = (i: number) => i > 0 && (printedSimilarity(pages[0].printed, pages[i].printed) ?? 0) >= SAME_SHEET;
  const analysis = analyzeClassSplit(pages);
  const nums = list.map((d) => d.num);
  const sorted = () => [...starts].sort((a, b) => a - b);
  const groupBounds = () => [0, ...sorted(), n];
  const groupOf = (i: number) => {
    const b = groupBounds();
    return b.findIndex((x, idx) => i >= x && i < b[idx + 1]);
  };

  // ── Beeld: scherper renderen, pas als de pagina in beeld komt ──
  let size = Math.max(80, Math.min(900, Number(srPref(SR_SIZE_KEY, '320')) || 320));
  let show: SrShow = (['vakken', 'uitvoer', 'origineel'] as const).find((m) => m === srPref(SR_SHOW_KEY, 'vakken')) ?? 'vakken';
  /** Vervangende tekst voor pagina i, volgens de huidige indeling (rij = kandidaat). */
  const textFor = (i: number) => {
    const k = groupOf(i);
    return k < nums.length ? fillTemplate(S.template, nums[k]) : S.template.replace(/\{n+\}/g, '?');
  };
  /** Beste beeld dat al klaarstaat per pagina en weergave (voorkomt flikkeren bij opnieuw opbouwen). */
  const best = new Map<string, { url: string; dpi: number }>();
  const TIERS = [20, 40, 70, 110, 160];
  const tierFor = (hPx: number, i: number) => {
    const need = (hPx * (window.devicePixelRatio || 1)) / (pages[i].hPt / 72);
    return TIERS.find((t) => t >= need) ?? TIERS[TIERS.length - 1];
  };
  const imgCache = new Map<string, string>();
  let alive = true;
  /** Pagina i op `dpi`; met `redact` (de vervangende tekst) precies zoals in de export. */
  async function imageFor(i: number, dpi: number, redact?: string): Promise<string | undefined> {
    const key = `${i}:${dpi}:${redact ?? ''}`;
    const hit = imgCache.get(key);
    if (hit) return hit;
    const { d, j } = where[i];
    if (!d.src) return pages[i].thumb;
    try {
      const c = await d.src.render(j, dpi, true);
      if (redact !== undefined) applyRedactions(c, pages[i].boxes, redact, S);
      const url = c.toDataURL('image/jpeg', 0.82);
      release(c);
      imgCache.set(key, url);
      return url;
    } catch {
      return pages[i].thumb;
    }
  }
  // Eén voor één renderen (wat in beeld is), zodat het venster vlot blijft.
  const want = new Map<HTMLImageElement, number>();
  let pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    while (alive && want.size) {
      const [img, i] = want.entries().next().value as [HTMLImageElement, number];
      want.delete(img);
      if (!img.isConnected) continue;
      // Hoogte waarop deze afbeelding getoond wordt (ingezoomde rij is groter).
      const dpi = tierFor(Number(img.dataset.h) || size, i);
      const redact = show === 'uitvoer' ? textFor(i) : undefined;
      const mode = redact === undefined ? 'scan' : `uit:${redact}`;
      if (img.dataset.mode === mode && Number(img.dataset.dpi) >= dpi) continue;
      const url = await imageFor(i, dpi, redact);
      if (url && img.isConnected) {
        img.src = url;
        img.dataset.dpi = String(dpi);
        img.dataset.mode = mode;
        img.parentElement?.classList.toggle('done', mode !== 'scan');
        const b = best.get(`${i}|${mode}`);
        if (!b || b.dpi < dpi) best.set(`${i}|${mode}`, { url, dpi });
      }
    }
    pumping = false;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const img = e.target as HTMLImageElement;
        if (e.isIntersecting) want.set(img, Number(img.dataset.i));
        else want.delete(img);
      }
      pump();
    },
    { rootMargin: '400px' },
  );

  // ── Opbouw ──
  const dlg = el('dialog', { class: 'sr' + (srPref(SR_FULL_KEY, '1') === '1' ? ' full' : '') });
  const summary = el('div', { class: 'sr-summary' });
  const rowsEl = el('div', { class: 'sr-rows' });
  const nIn = el('input', { type: 'number', min: '1', max: String(n), value: String(Math.max(1, list[0].pages.length)), class: 'sr-n' }) as HTMLInputElement;
  const sizeIn = el('input', { type: 'range', min: '80', max: '900', step: '10', value: String(size), title: "Grootte van de pagina's", 'aria-label': "Grootte van de pagina's" }) as HTMLInputElement;
  const setStarts = (xs: number[]) => {
    starts = new Set(xs.filter((i) => i > 0 && i < n));
    render();
  };
  const toggle = (i: number) => {
    if (i <= 0 || i >= n) return;
    if (starts.has(i)) starts.delete(i);
    else starts.add(i);
    render();
  };
  /** Pagina i naar kandidaat (rij) tg verplaatsen: de grens(en) ertussen schuiven mee. */
  function movePage(i: number, tg: number) {
    const b = groupBounds();
    const k = groupOf(i);
    if (tg === k || tg < 0 || tg >= b.length - 1) return;
    if (tg < k) {
      // Pagina's vanaf het begin van rij tg+1 t/m i gaan naar rij tg.
      for (const st of [...starts]) if (st > b[tg] && st <= i) starts.delete(st);
      if (i + 1 < n && i + 1 < b[k + 1]) starts.add(i + 1);
    } else {
      // Pagina's vanaf i t/m het begin van rij tg gaan naar rij tg.
      for (const st of [...starts]) if (st > i && st <= b[tg]) starts.delete(st);
      if (i > 0) starts.add(i);
    }
    render();
  }

  /** Ingezoomde kandidaat (rij index), of null. */
  let focusK: number | null = null;
  /** Hoogte van de andere rijen tijdens inzoomen: klein, maar nog herkenbaar. */
  const SMALL = 120;
  /** Zo hoog mogelijk, maar met ruimte voor de kandidaat erboven en eronder. */
  function focusHeight() {
    const body = dlg.querySelector('.dbody') as HTMLElement | null;
    const h = body?.clientHeight || window.innerHeight;
    return Math.max(260, Math.round(h - 2 * (SMALL + 64) - 120));
  }
  const label = (k: number) => (k < nums.length ? fillTemplate(S.template, nums[k]) : 'Nieuwe kandidaat');

  function render(scrollTo?: { k: number; page?: number }) {
    io.disconnect();
    want.clear();
    const b = groupBounds();
    const lengths = b.slice(1).map((x, k) => x - b[k]);
    if (focusK !== null && focusK >= lengths.length) focusK = lengths.length - 1;
    const zoomed = focusK !== null;
    const bigH = zoomed ? focusHeight() : 0;
    dlg.classList.toggle('zoomed', zoomed);
    dlg.style.setProperty('--sr-h', `${zoomed ? SMALL : size}px`);
    dlg.style.setProperty('--sr-zh', `${bigH}px`);
    const uneven = new Set(lengths).size > 1;
    summary.replaceChildren(
      el('strong', {}, `${lengths.length} ${lengths.length === 1 ? 'kandidaat' : 'kandidaten'}`),
      ` · pagina's per kandidaat: ${lengths.join(', ')}`,
      ...(uneven ? [el('div', { class: 'note warn' }, "Niet elke kandidaat heeft evenveel pagina's. Controleer of de grenzen kloppen: elke rij moet met een voorblad beginnen.")] : []),
    );
    rowsEl.replaceChildren(
      ...lengths.map((len, k) => {
        const first = b[k];
        const isF = k === focusK;
        // Voorblad midden in de rij: daar begint waarschijnlijk een andere leerling.
        const innerVb = Array.from({ length: len - 1 }, (_, j) => first + 1 + j).filter(voorblad);
        const rowPages = pages.slice(first, first + len);
        const nBox = rowPages.reduce((a, p) => a + p.boxes.length, 0);
        // Geen naamvak bij deze kandidaat: dan blijft de naam waarschijnlijk staan!
        const noName = !rowPages.some((p) => p.boxes.some((bx) => bx.kind === 'naam' || bx.text));
        const warnRow = (k > 0 && !voorblad(first)) || innerVb.length > 0 || noName;
        const items: HTMLElement[] = [];
        for (let i = first; i < first + len; i++) {
          if (i > first)
            items.push(el('button', { class: 'sr-cut', title: `Hier splitsen: pagina ${i + 1} wordt het begin van een nieuwe kandidaat`, 'aria-label': `Splitsen vóór pagina ${i + 1}`, onclick: () => toggle(i) }, '✂'));
          const p = pages[i];
          const mode = show === 'uitvoer' ? `uit:${textFor(i)}` : 'scan';
          const ready = best.get(`${i}|${mode}`);
          const img = el('img', { src: ready?.url ?? p.thumb ?? '', alt: `Pagina ${i + 1}`, draggable: 'false', 'data-i': String(i), 'data-h': String(isF ? bigH : zoomed ? SMALL : size) }) as HTMLImageElement;
          if (ready) {
            img.dataset.dpi = String(ready.dpi);
            img.dataset.mode = mode;
          }
          img.style.aspectRatio = `${p.wPt} / ${p.hPt}`;
          // De vakken die weggehaald worden, over de scan heen.
          const boxesEl = el(
            'div',
            { class: 'sr-boxes' },
            ...p.boxes.map((bx) => {
              const e = el('div', { class: `sr-box ${bx.kind}` });
              e.style.cssText = `left:${bx.x * 100}%;top:${bx.y * 100}%;width:${bx.w * 100}%;height:${bx.h * 100}%`;
              return e;
            }),
          );
          io.observe(img);
          items.push(
            el(
              'div',
              {
                class: 'sr-page' + (voorblad(i) || i === 0 ? ' vb' : '') + (ready && mode !== 'scan' ? ' done' : ''),
                'data-i': String(i),
                title: `Pagina ${i + 1}${naam(i) ? ' · naamvak' : ''}${voorblad(i) ? ' · zelfde blad als pagina 1' : ''}\n${isF ? 'Klik: uitzoomen' : 'Klik: inzoomen op deze kandidaat'} · sleep naar een andere kandidaat`,
              },
              img,
              boxesEl,
              el('span', { class: 'n' }, String(i + 1)),
              naam(i) ? el('span', { class: 'sr-naam' }, 'naam') : null,
            ),
          );
        }
        const pagesTxt = `${len} pagina${len === 1 ? '' : "'s"} (p. ${len === 1 ? first + 1 : `${first + 1}–${first + len}`})`;
        return el(
          'div',
          { class: `sr-row c${k % 6}` + (warnRow ? ' odd' : '') + (isF ? ' focus' : ''), 'data-k': String(k) },
          el(
            'div',
            { class: 'sr-head' },
            el('span', { class: 'sr-label' }, label(k)),
            isF ? el('span', { class: 'sr-of' }, `kandidaat ${k + 1} van ${lengths.length}`) : null,
            el('span', {}, pagesTxt),
            el('span', { class: 'note' }, `· ${nBox} vak${nBox === 1 ? '' : 'ken'} weg`),
            noName ? el('span', { class: 'sr-noname' }, '⚠ geen naamvak – de naam blijft staan!') : null,
            k > 0 && !voorblad(first) ? el('span', { class: 'note warn' }, '· begint niet met een voorblad') : null,
            innerVb.length ? el('span', { class: 'note warn' }, `· bevat nog een voorblad (p. ${innerVb.map((i) => i + 1).join(', ')})`) : null,
            el('span', { class: 'spacer' }),
            isF
              ? el('span', { class: 'inline' },
                  el('button', { class: 'btn small', disabled: k === 0, onclick: () => zoomTo(k - 1), title: 'Vorige kandidaat (↑)' }, '↑'),
                  el('button', { class: 'btn small', disabled: k === lengths.length - 1, onclick: () => zoomTo(k + 1), title: 'Volgende kandidaat (↓)' }, '↓'),
                  el('button', { class: 'btn small', onclick: () => zoomTo(null, first), title: 'Uitzoomen (Esc)' }, '⤡ Uitzoomen'))
              : el('button', { class: 'btn small', onclick: () => zoomTo(k), title: 'Op deze kandidaat inzoomen' }, '🔍 Inzoomen'),
            k > 0 ? el('button', { class: 'btn small', onclick: () => toggle(first), title: 'Deze rij bij de vorige kandidaat voegen' }, '↥ Samenvoegen met vorige') : null,
          ),
          el('div', { class: 'sr-strip' }, ...items),
        );
      }),
    );
    // Ingezoomde rij in het midden, zodat de kandidaat erboven en eronder ook zichtbaar is.
    const target = scrollTo ?? (focusK !== null ? { k: focusK } : null);
    if (target)
      requestAnimationFrame(() => {
        const row = rowsEl.querySelector(`.sr-row[data-k="${target.k}"]`) as HTMLElement | null;
        row?.scrollIntoView({ block: 'center' });
        if (target.page !== undefined) rowsEl.querySelector(`.sr-page[data-i="${target.page}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
      });
  }
  function zoomTo(k: number | null, page?: number) {
    const prev = focusK;
    focusK = k;
    render({ k: k ?? prev ?? 0, page });
  }

  // ── Slepen: pagina naar een andere rij ──
  let drag: { i: number; x: number; y: number; ghost?: HTMLElement; over?: HTMLElement | null } | null = null;
  rowsEl.addEventListener('pointerdown', (e) => {
    const pg = (e.target as HTMLElement).closest('.sr-page') as HTMLElement | null;
    if (!pg || e.button !== 0) return;
    drag = { i: Number(pg.dataset.i), x: e.clientX, y: e.clientY };
    rowsEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  rowsEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.ghost) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      const src = rowsEl.querySelector(`.sr-page[data-i="${drag.i}"] img`) as HTMLImageElement | null;
      drag.ghost = el('div', { class: 'sr-ghost' }, el('img', { src: src?.src ?? '', alt: '' }), el('span', {}, `Pagina ${drag.i + 1}`));
      dlg.append(drag.ghost);
      dlg.classList.add('dragging');
    }
    drag.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
    const row = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('.sr-row') as HTMLElement | null;
    if (row !== drag.over) {
      drag.over?.classList.remove('drop');
      drag.over = row;
      if (row && Number(row.dataset.k) !== groupOf(drag.i)) row.classList.add('drop');
    }
    // Automatisch scrollen bij de rand.
    const body = dlg.querySelector('.dbody') as HTMLElement;
    const r = body.getBoundingClientRect();
    if (e.clientY < r.top + 40) body.scrollTop -= 20;
    else if (e.clientY > r.bottom - 40) body.scrollTop += 20;
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.ghost?.remove();
    d.over?.classList.remove('drop');
    dlg.classList.remove('dragging');
    if (!d.ghost) {
      // Gewone klik: inzoomen op deze kandidaat (of uitzoomen als die al ingezoomd is).
      if (e.type === 'pointerup') {
        const k = groupOf(d.i);
        zoomTo(focusK === k ? null : k, d.i);
      }
      return;
    }
    if (d.over && e.type === 'pointerup') movePage(d.i, Number(d.over.dataset.k));
  };
  rowsEl.addEventListener('pointerup', endDrag);
  rowsEl.addEventListener('pointercancel', endDrag);

  // ── Toetsen tijdens inzoomen: ↑↓ andere kandidaat, ←→ door de pagina's, Esc uitzoomen ──
  dlg.addEventListener('keydown', (e) => {
    if (focusK === null || (e.target as HTMLElement).closest('input, select, textarea')) return;
    const last = groupBounds().length - 2;
    const strip = rowsEl.querySelector('.sr-row.focus .sr-strip') as HTMLElement | null;
    const step = (strip?.querySelector('.sr-page') as HTMLElement | null)?.offsetWidth ?? 300;
    if (e.key === 'ArrowDown' && focusK < last) zoomTo(focusK + 1);
    else if (e.key === 'ArrowUp' && focusK > 0) zoomTo(focusK - 1);
    else if (e.key === 'ArrowRight') strip?.scrollBy({ left: step + 22, behavior: 'smooth' });
    else if (e.key === 'ArrowLeft') strip?.scrollBy({ left: -(step + 22), behavior: 'smooth' });
    else return;
    e.preventDefault();
  });
  // Esc zoomt eerst uit, en sluit pas daarna het venster.
  dlg.addEventListener('cancel', (e) => {
    if (focusK !== null) {
      e.preventDefault();
      zoomTo(null);
    }
  });
  // Ander schermformaat: ingezoomde rij opnieuw passend maken.
  const onResize = () => focusK !== null && render();
  window.addEventListener('resize', onResize);

  sizeIn.addEventListener('input', () => {
    size = Number(sizeIn.value);
    dlg.style.setProperty('--sr-h', `${size}px`);
  });
  sizeIn.addEventListener('change', () => {
    srSave(SR_SIZE_KEY, String(size));
    render(); // scherper renderen voor de nieuwe grootte
  });

  const vbStarts = pages.map((_, i) => i).filter(voorblad);
  const naamStarts = pages.map((_, i) => i).filter((i) => i > 0 && naam(i));
  const every = () => {
    const k = Math.max(1, Math.floor(Number(nIn.value) || 1));
    return Array.from({ length: Math.ceil(n / k) - 1 }, (_, j) => (j + 1) * k);
  };
  const close = () => dlg.close();
  const apply = (xs: number[], how: string) => {
    close();
    applySplitEdit(list, xs, how, analysis.log);
  };
  const SHOWS: [SrShow, string, string][] = [
    ['vakken', 'Vakken', 'Scan met de vakken die weggehaald worden'],
    ['uitvoer', 'Zoals de uitvoer', 'Precies zoals het na het exporteren wordt: weggehaald en vervangen door de kandidaattekst'],
    ['origineel', 'Origineel', 'Alleen de scan, zonder vakken'],
  ];
  const showBtns = SHOWS.map(([m, l, t]) => el('button', { class: 'btn small' + (show === m ? ' active' : ''), title: t, 'data-m': m, onclick: () => setShow(m) }, l));
  function setShow(m: SrShow) {
    show = m;
    srSave(SR_SHOW_KEY, m);
    for (const b of showBtns) b.classList.toggle('active', b.dataset.m === m);
    dlg.classList.remove('m-vakken', 'm-uitvoer', 'm-origineel');
    dlg.classList.add(`m-${m}`);
    render();
  }
  dlg.classList.add(`m-${show}`);
  dlg.style.setProperty('--sr-fill', S.fill === 'zwart' ? '#000' : '#fff');
  const fullBtn = el('button', { class: 'btn icon', title: 'Schermvullend aan/uit' }, dlg.classList.contains('full') ? '⤡' : '⤢');
  fullBtn.addEventListener('click', () => {
    const on = dlg.classList.toggle('full');
    fullBtn.textContent = on ? '⤡' : '⤢';
    srSave(SR_FULL_KEY, on ? '1' : '0');
  });
  dlg.append(
    el('div', { class: 'dhead' }, el('h2', {}, `✂ Splitsresultaat – ${from}`), fullBtn, el('button', { class: 'btn icon', onclick: close, title: 'Sluiten' }, '✕')),
    el(
      'div',
      { class: 'dbody' },
      el(
        'p',
        { class: 'note', style: 'margin-top:0' },
        `${n} pagina's. Elke rij is één kandidaat met een eigen nummer. Klik op een pagina om in te zoomen op die kandidaat (↑ ↓ andere kandidaat, ← → bladeren, Esc uitzoomen), sleep een pagina naar een andere kandidaat, of klik op ✂ tussen twee pagina's om daar te splitsen. Blauwe rand = hetzelfde blad als pagina 1 (voorblad).`,
      ),
      el(
        'div',
        { class: 'sr-tools' },
        el('span', { class: 'seg', role: 'group', 'aria-label': 'Weergave' }, ...showBtns),
        el('span', { class: 'sep' }),
        el('label', { class: 'inline' }, 'Grootte', sizeIn),
        el('span', { class: 'sep' }),
        'Opnieuw indelen:',
        analysis.result ? el('button', { class: 'btn small', onclick: () => setStarts(analysis.result!.starts) }, 'Automatisch voorstel') : null,
        el('button', { class: 'btn small', disabled: !vbStarts.length, onclick: () => setStarts(vbStarts) }, `Bij elk voorblad (${vbStarts.length + 1})`),
        el('button', { class: 'btn small', disabled: !naamStarts.length, onclick: () => setStarts(naamStarts) }, `Bij elk naamvak (${naamStarts.length + 1})`),
        el('span', { class: 'inline' }, el('button', { class: 'btn small', onclick: () => setStarts(every()) }, 'Elke'), nIn, "pagina's"),
      ),
      summary,
      rowsEl,
    ),
    el(
      'div',
      { class: 'dfoot' },
      el('button', { class: 'btn', onclick: () => apply([], 'niet gesplitst'), title: 'Alles één document laten' }, 'Niet splitsen'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn', onclick: close }, list.length > 1 ? 'Sluiten (zo laten)' : 'Annuleren'),
      el('button', { class: 'btn primary', onclick: () => apply(sorted(), 'aangepast in het splitsvenster') }, 'Toepassen'),
    ),
  );
  render();
  document.body.append(dlg);
  dlg.addEventListener('close', () => {
    alive = false;
    window.removeEventListener('resize', onResize);
    io.disconnect();
    imgCache.clear();
    dlg.remove();
    onDone?.();
  });
  dlg.showModal();
}

function renumberAll() {
  if (!docs.length) return;
  if (!confirm('Alle documenten nieuwe willekeurige kandidaatnummers geven? Een eerder gedownload sleutelbestand klopt dan niet meer.')) return;
  const used = new Set<number>();
  for (const d of docs) {
    d.num = uniqueNumber(S.numMin, S.numMax, used);
    used.add(d.num);
    d.exported = false;
  }
  renderAll();
}

// ───────────────────────── Detectie ─────────────────────────

type Phase = 'rechtop' | 'gedraaid';
const detectQueue: { doc: Doc; page: PageState; phase: Phase }[] = [];
let detectRunning = 0;
let detectTotal = 0;
let detectDone = 0;

function dropFromQueue(d: Doc) {
  for (let i = detectQueue.length - 1; i >= 0; i--) if (detectQueue[i].doc === d) detectQueue.splice(i, 1);
}

function enqueue(doc: Doc, pages: PageState[]) {
  for (const p of pages) {
    if (detectQueue.some((j) => j.page === p && j.phase === 'rechtop')) continue;
    p.detect = 'bezig';
    p.detectNote = 'In de wachtrij…';
    p.rotChecked = false;
    // Vóór eventuele achtergrondcontroles op gedraaide pagina's
    const firstRot = detectQueue.findIndex((j) => j.phase === 'gedraaid');
    detectQueue.splice(firstRot < 0 ? detectQueue.length : firstRot, 0, { doc, page: p, phase: 'rechtop' });
    detectTotal++;
  }
  pumpDetect();
  markScan();
  renderDocList();
  renderStrip();
  renderInspector();
}

function detectDocs(list: Doc[]) {
  for (const d of list) enqueue(d, d.pages);
}

function detectAll(force: boolean) {
  const list = docs.filter((d) => d.status === 'klaar');
  if (!list.length) return;
  if (force && list.some((d) => d.pages.some((p) => p.boxes.some((b) => b.source === 'auto'))))
    if (!confirm('Automatisch gevonden vakken worden opnieuw bepaald. Handmatig getekende vakken blijven staan. Doorgaan?')) return;
  detectDocs(list);
}

function stopDetect() {
  for (const j of detectQueue) {
    if (j.phase === 'gedraaid') continue;
    j.page.detect = 'nog niet';
    j.page.detectNote = 'Detectie gestopt';
  }
  detectTotal -= detectQueue.length;
  detectQueue.length = 0;
  setStatus("Detectie gestopt (pagina's die al bezig waren worden nog afgemaakt).");
  updateBusy();
  renderDocList();
  renderStrip();
  renderInspector();
}

function pumpDetect() {
  updateBusy();
  const max = S.ocrWorkers > 0 ? S.ocrWorkers : defaultWorkerCount();
  while (detectRunning < max && detectQueue.length) {
    const job = detectQueue.shift()!;
    detectRunning++;
    runDetect(job.doc, job.page, job.phase).finally(() => {
      detectRunning--;
      detectDone++;
      const mainLeft = detectQueue.some((j) => j.phase === 'rechtop');
      if (!detectQueue.length && !detectRunning) {
        updateBusy();
        const n = detectDone;
        detectDone = detectTotal = 0;
        setProgress(0, 0);
        void n;
        completeMissing().then((added) => {
          const ok = docs.filter((x) => x.status === 'klaar');
          const nBoxes = ok.reduce((a, x) => a + x.pages.reduce((b, p) => b + p.boxes.length, 0), 0);
          setStatus(
            `Detectie klaar: ${ok.length} document(en), ${nBoxes} vak(ken)${added ? `, waarvan ${added} aangevuld op basis van andere pagina's` : ''}. Controleer en exporteer.`,
          );
          // Eén melding, zodat de knop "Terugdraaien" niet door een waarschuwing verdrongen wordt.
          const split = autoSplitClasses();
          const warn = missingNameWarning();
          if (split) {
            toast(warn ? `${split.msg} ${warn}` : split.msg, split.actions);
            openReviews(split.review);
          } else if (warn) toast(warn);
          queueRotationChecks();
        });
      } else if (!mainLeft && detectQueue.every((j) => j.phase === 'gedraaid') && job.phase === 'rechtop' && !detectRunningMain()) {
        // Fase 1 klaar: alvast aanvullen, gedraaide controles lopen op de achtergrond door.
        completeMissing();
        setStatus(`Rechtop klaar; nu controleren op gedraaide pagina's… ${detectDone}/${detectTotal}`);
        setProgress(detectDone, detectTotal);
      } else {
        setStatus(`${mainLeft || job.phase === 'rechtop' ? 'Detecteren' : "Controleren op gedraaide pagina's"}… ${detectDone}/${detectTotal}`);
        setProgress(detectDone, detectTotal);
      }
      pumpDetect();
    });
  }
}

let runningMain = 0;
const detectRunningMain = () => runningMain > 0;

/**
 * Na de snelle eerste ronde (rechtop): pagina's zonder vakken, waarop ook geen duidelijk
 * leesbare gedrukte tekst rechtop stond, alsnog gedraaid doorzoeken (op de achtergrond).
 */
function queueRotationChecks() {
  if (!S.searchRotated) return;
  let n = 0;
  for (const d of docs) {
    if (d.status !== 'klaar') continue;
    for (const p of d.pages) {
      if (p.rotChecked || p.boxes.length || p.checked || p.detect !== 'klaar') continue;
      if (detectQueue.some((j) => j.page === p)) continue;
      detectQueue.push({ doc: d, page: p, phase: 'gedraaid' });
      detectTotal++;
      n++;
    }
  }
  if (n) {
    setStatus(`Controleren op gedraaide pagina's (${n})…`);
    pumpDetect();
  }
}

async function runDetect(doc: Doc, p: PageState, phase: Phase) {
  if (!doc.src || !docs.includes(doc)) return;
  if (phase === 'gedraaid') {
    if (p.rotChecked || p.boxes.length || p.checked) return;
    scanning.add(p);
    markScan();
    try {
      const canvas = await doc.src.render(p.index, S.ocrDpi);
      const res = await detectPage(canvas, S, namesFor(doc), [90, 270, 180]);
      release(canvas);
      p.rotChecked = true;
      if (res.boxes.length && !p.boxes.length) {
        p.boxes = [...p.boxes, ...res.boxes];
        if (!p.boxes.some((b) => b.text)) {
          const t = p.boxes.find((b) => b.kind === 'naam');
          if (t) t.text = true;
        }
        p.detectNote = res.note;
        doc.exported = false;
      }
    } catch (e) {
      console.error(e);
    }
    scanning.delete(p);
    markScan();
    renderDocList();
    if (doc === cur) {
      renderStrip();
      if (p.index === curPage) {
        renderOverlay();
        renderInspector();
        renderToolbar();
        refreshPreview();
      }
    }
    return;
  }
  runningMain++;
  scanning.add(p);
  markScan();
  p.detectNote = 'Bezig met tekstherkenning…';
  if (doc === cur && p.index === curPage) renderInspector();
  try {
    const canvas = await doc.src.render(p.index, S.ocrDpi);
    const res = await detectPage(canvas, S, namesFor(doc), [0]);
    release(canvas);
    // Duidelijk rechtop (gedrukte tekst leesbaar) of al iets gevonden: niet gedraaid zoeken.
    p.rotChecked = !!res.upright || res.boxes.length > 0;
    p.boxes = [...p.boxes.filter((b) => b.source === 'handmatig'), ...res.boxes];
    if (!p.boxes.some((b) => b.text)) {
      const t = p.boxes.find((b) => b.kind === 'naam');
      if (t) t.text = true;
    }
    p.detect = 'klaar';
    p.detectNote = res.note;
    p.printed = res.printed;
  } catch (e) {
    p.detect = 'fout';
    p.detectNote = 'Fout bij detectie: ' + (e instanceof Error ? e.message : String(e));
    console.error(e);
  } finally {
    runningMain--;
    scanning.delete(p);
    markScan();
  }
  doc.exported = false;
  renderDocList();
  if (doc === cur) {
    renderStrip();
    if (p.index === curPage) {
      renderOverlay();
      renderInspector();
      renderToolbar();
      refreshPreview();
    }
  }
}

/**
 * Vangnet: vakken die op vergelijkbare pagina's wél gevonden zijn (bijv. "Examen no."), maar hier
 * door de OCR gemist werden, worden aangevuld en daarna aangepast aan de inkt op deze pagina.
 */
async function completeMissing(): Promise<number> {
  const pages = docs.filter((d) => d.status === 'klaar').flatMap((d) => d.pages);
  const adds = completeFromPeers(pages);
  let added = 0;
  for (const { page: pg, box } of adds) {
    const doc = docs.find((d) => (d.pages as unknown[]).includes(pg));
    const p = pg as PageState;
    if (!doc?.src) continue;
    let refined: { x: number; y: number; w: number; h: number } | null = { x: box.x, y: box.y, w: box.w, h: box.h };
    try {
      const c = await doc.src.render(p.index, 100);
      const img = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height);
      refined = refineWithInk(new InkMask(img, 1), c.width, c.height, box);
      release(c);
    } catch {
      /* dan het ruwe vak */
    }
    if (!refined) continue; // leeg: niets te verbergen
    added++;
    p.boxes.push({ ...box, ...refined, id: uid() });
    p.detectNote = (p.detectNote ?? '') + ` + ${KIND_LABEL[box.kind].toLowerCase()} aangevuld (afgeleid van andere pagina's)`;
    doc.exported = false;
  }
  if (added) {
    renderDocList();
    renderStrip();
    renderToolbar();
    renderOverlay();
    renderInspector();
    refreshPreview();
  }
  return added;
}

/**
 * Scan van een hele klas in één PDF? Dan automatisch per leerling opdelen, zodat elke leerling
 * een eigen kandidaatnummer krijgt. Eén keer per document; terug te draaien via de melding.
 */
function autoSplitClasses(): { msg: string; actions: ToastAction[]; review: Doc[][] } | null {
  const splits: { name: string; parts: Doc[]; per: string }[] = [];
  const maybe: Doc[] = [];
  for (const d of [...docs]) {
    if (d.status !== 'klaar' || d.splitChecked) continue;
    if (d.pages.some((p) => p.detect === 'bezig' || p.detect === 'nog niet')) continue;
    d.splitChecked = true;
    if (!S.autoSplit) continue;
    const { result: res, log } = analyzeClassSplit(d.pages);
    if (!res) continue;
    if (!res.sure) {
      // Twijfel (bijv. weinig gedrukte tekst om te vergelijken): voorstellen, niet zelf doen.
      d.splitSuggest = res.starts;
      maybe.push(d);
      continue;
    }
    const name = d.name;
    const parts = splitDoc(d, res.starts, true, `automatisch (${res.method === 'ritme' ? 'vast ritme' : 'bij elk voorblad'})`, log);
    if (parts.length) {
      const ls = parts.map((p) => p.pages.length);
      const lo = Math.min(...ls);
      const hi = Math.max(...ls);
      splits.push({ name, parts, per: lo === hi ? `${lo} pagina${lo === 1 ? '' : "'s"}` : `${lo} tot ${hi} pagina's` });
    }
  }
  if (maybe.length) renderDocList();
  if (!splits.length && !maybe.length) return null;
  const maybeMsg = maybe.length
    ? maybe.length === 1
      ? `"${maybe[0].name}" lijkt ${maybe[0].splitSuggest!.length + 1} toetsen te bevatten, maar dat is niet zeker.`
      : `${maybe.length} bestanden lijken meerdere toetsen te bevatten, maar dat is niet zeker.`
    : '';
  if (!splits.length)
    return {
      msg: `${maybeMsg} Bekijk het voorstel (ook via de knop bij het document in de lijst).`,
      actions: [],
      // Twijfel: het splitsvenster gaat vanzelf open met het voorstel.
      review: maybe.map((d) => [d]),
    };
  const total = splits.reduce((a, s) => a + s.parts.length, 0);
  const msg =
    (splits.length === 1
      ? `"${splits[0].name}" bevat ${total} toetsen (${splits[0].per} per leerling) en is opgedeeld; elke toets krijgt een eigen nummer.`
      : `${splits.length} bestanden met een hele klas zijn opgedeeld in samen ${total} toetsen (${splits.map((s) => `${s.parts.length}× ${s.per}`).join(', ')}); elke toets krijgt een eigen nummer.`) +
    (maybeMsg ? ` ${maybeMsg} Zie de lijst.` : '');
  // Ongelijke verdeling (niet elke kandidaat evenveel pagina's) of twijfel: venster vanzelf openen.
  const uneven = splits.filter((s) => new Set(s.parts.map((p) => p.pages.length)).size > 1).map((s) => s.parts);
  return {
    msg,
    review: [...uneven, ...maybe.map((d) => [d])],
    actions: [
      { label: 'Bekijken', run: () => { const g = splits[0].parts.filter((x) => docs.includes(x)); if (g.length) openSplitReview(g); } },
      { label: 'Leerlingen koppelen', run: () => startMatcher() },
    {
      label: 'Terugdraaien',
      run: () => {
        const restored: Doc[] = [];
        for (const s of splits) {
          const nd = s.parts.every((x) => docs.includes(x)) ? mergeDocs(s.parts, s.name, true) : null;
          if (nd) restored.push(nd);
        }
        if (restored.length) {
          cur = restored[0];
          curPage = 0;
          renderAll();
        }
        const failed = splits.length - restored.length;
        toast(
          `${restored.length} bestand(en) teruggedraaid naar één document.` +
            (failed ? ` ${failed} bestand(en) niet: de delen zijn intussen gewijzigd.` : ''),
        );
      },
    },
    ],
  };
}

/** Splitsvensters na elkaar openen (bijv. meerdere bestanden met een ongelijke verdeling). */
function openReviews(groups: Doc[][]) {
  const g = groups.shift();
  if (!g) return;
  const live = g.filter((x) => docs.includes(x));
  if (!live.length) return openReviews(groups);
  openSplitReview(live, live.length === 1 ? live[0].splitSuggest : undefined, () => openReviews(groups));
}

function missingNameWarning(): string | null {
  const missing = docs.filter((d) => d.status === 'klaar' && !d.pages.some((p) => p.boxes.some((b) => b.kind === 'naam' || b.text)));
  return missing.length ? `Let op: bij ${missing.length} document(en) is geen naamvak gevonden. Teken dat handmatig.` : null;
}

// ───────────────────────── Rendering: lijst ─────────────────────────

function docChips(d: Doc) {
  const chips: HTMLElement[] = [];
  if (d.status === 'laden') return [el('span', { class: 'chip busy' }, 'inlezen…')];
  if (d.status === 'fout') return [el('span', { class: 'chip err', title: d.error ?? '' }, 'kan niet lezen')];
  chips.push(el('span', { class: 'chip' }, `${d.pages.length} p.`));
  const busy = d.pages.filter((p) => p.detect === 'bezig').length;
  const nBoxes = d.pages.reduce((a, p) => a + p.boxes.length, 0);
  const hasNaam = d.pages.some((p) => p.boxes.some((b) => b.kind === 'naam' || b.text));
  const anyDone = d.pages.some((p) => p.detect === 'klaar');
  if (busy) chips.push(el('span', { class: 'chip busy' }, `detecteren ${d.pages.length - busy}/${d.pages.length}`));
  else if (nBoxes) chips.push(el('span', { class: hasNaam ? 'chip ok' : 'chip warn' }, `${nBoxes} vak${nBoxes === 1 ? '' : 'ken'}`));
  if (!busy && anyDone && !hasNaam) chips.push(el('span', { class: 'chip err' }, 'geen naam gevonden'));
  const odd = suspiciousPages(d);
  if (!busy && odd.length)
    chips.push(
      el('span', { class: 'chip warn', title: "Op deze pagina('s) staat geen vak, terwijl dezelfde pagina bij de meeste andere documenten wél vakken heeft." }, `controleer p. ${odd.map((i) => i + 1).join(', ')}`),
    );
  if (d.splitSuggest)
    chips.push(
      el('button', {
        class: 'chip warn act',
        title: 'Dit bestand lijkt meerdere toetsen te bevatten. Klik om het per leerling op te delen.',
        onclick: (e: Event) => {
          e.stopPropagation();
          openSplitReview([d], d.splitSuggest);
        },
      }, `✂ ${d.splitSuggest.length + 1} toetsen? Bekijken`),
    );
  if (d.splitInfo) {
    // Deel van een gesplitste scan: één klik naar de splitsweergave.
    const g = splitGroup(d);
    chips.push(
      el('button', {
        class: 'chip split act',
        title: `Deel van "${d.splitInfo.from}". Klik om de splitsing te bekijken of aan te passen.`,
        onclick: (e: Event) => {
          e.stopPropagation();
          openSplitReview(g);
        },
      }, `✂ ${g.indexOf(d) + 1} van ${g.length} uit ${d.splitInfo.from}`),
    );
  }
  const mc = matchChip(d, docs);
  if (mc)
    chips.push(
      el('button', {
        class: `chip act ${mc.cls}`,
        title: `${mc.title}. Klik om te koppelen.`,
        onclick: (e: Event) => {
          e.stopPropagation();
          startMatcher(d);
        },
      }, mc.text),
    );
  if (d.exported) chips.push(el('span', { class: 'chip ok' }, '✓ geëxporteerd'));
  return chips;
}

/** Pagina's zonder vakken terwijl dezelfde pagina bij ≥ 60% van de andere documenten vakken heeft. */
function suspiciousPages(d: Doc): number[] {
  const others = docs.filter((o) => o !== d && o.status === 'klaar');
  if (others.length < 2) return [];
  return d.pages
    .filter((p) => !p.boxes.length && p.detect !== 'bezig' && !p.checked)
    .filter((p) => {
      const withBoxes = others.filter((o) => o.pages[p.index]?.boxes.length).length;
      return withBoxes / others.length >= 0.6;
    })
    .map((p) => p.index);
}

function renderDocList() {
  attentionToggle.hidden = docs.length < 4;
  const shown = onlyAttention ? docs.filter((d) => needsAttention(d) || d === cur) : docs;
  docList.replaceChildren(
    ...(docs.length
      ? shown.map((d) =>
          el(
            'div',
            {
              class: 'doc' + (d === cur ? ' sel' : ''),
              onclick: () => {
                if (cur === d) return;
                cur = d;
                curPage = 0;
                selBox = null;
                renderAll();
              },
            },
            el(
              'div',
              { class: 'row' },
              el('span', { class: 'anon' }, docText(d)),
              el('span', { class: 'spacer' }),
              el('button', {
                class: 'x',
                title: 'Verwijderen uit lijst',
                onclick: (e: Event) => {
                  e.stopPropagation();
                  removeDoc(d);
                },
              }, '×'),
            ),
            el('div', { class: 'row' }, el('span', { class: 'orig', title: d.name }, d.name)),
            el('div', { class: 'chips' }, ...docChips(d)),
          ),
        )
      : [el('div', { class: 'note', style: 'padding:8px' }, 'Nog geen documenten.')]),
  );
  const any = docs.some((d) => d.status === 'klaar');
  btnExportAll.disabled = !any;
  btnDetectAll.disabled = !any;
  btnKey.disabled = !any;
  btnRenumber.disabled = !any;
  btnOverview.disabled = !any;
  btnMatch.disabled = !any;
  miMatch.disabled = !any;
  btnClear.disabled = !docs.length;
  btnExportAll.textContent = docs.length > 1 ? `⬇ Exporteer alles (${docs.length})` : '⬇ Exporteer';
}

// ───────────────────────── Rendering: editor ─────────────────────────

const canvasCache = new Map<string, HTMLCanvasElement>();
function cacheGet(key: string) {
  const c = canvasCache.get(key);
  if (c) {
    canvasCache.delete(key);
    canvasCache.set(key, c);
  }
  return c;
}
function cachePut(key: string, c: HTMLCanvasElement) {
  canvasCache.set(key, c);
  while (canvasCache.size > 8) {
    const [k, v] = canvasCache.entries().next().value as [string, HTMLCanvasElement];
    release(v);
    canvasCache.delete(k);
  }
}

let stage: HTMLDivElement | null = null;
let displayCanvas: HTMLCanvasElement | null = null;
let overlay: HTMLDivElement | null = null;
let baseCanvas: HTMLCanvasElement | null = null;
let renderToken = 0;

function stageSize(p: PageState) {
  const aspect = p.hPt / p.wPt;
  if (zoom === 'fit') {
    const w = Math.max(200, Math.min(editor.clientWidth - 32, (editor.clientHeight - 32) / aspect));
    return { w, h: w * aspect };
  }
  const w = p.wPt * zoom * (96 / 72);
  return { w, h: w * aspect };
}

async function renderEditor() {
  const p = page();
  if (!cur || !p || !cur.src) {
    stage = displayCanvas = overlay = baseCanvas = null;
    editor.replaceChildren(emptyState());
    return;
  }
  const { w, h } = stageSize(p);
  stage = el('div', { class: 'stage' + (preview ? ' preview' : '') + (S.showLabels ? '' : ' hidelabels') }) as HTMLDivElement;
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  displayCanvas = el('canvas');
  overlay = el('div', { class: 'overlay' }) as HTMLDivElement;
  stage.append(displayCanvas, overlay);
  editor.replaceChildren(stage);
  attachOverlayEvents(overlay);
  renderOverlay();
  markScan();

  const dpr = window.devicePixelRatio || 1;
  const dpi = Math.min(220, Math.max(40, Math.round(((w * dpr) / p.wPt) * 72 / 10) * 10));
  const key = `${cur.id}:${p.index}:${p.userRot ?? 0}:${dpi}`;
  const token = ++renderToken;
  let c = cacheGet(key);
  if (!c) {
    try {
      c = await cur.src.render(p.index, dpi, true);
    } catch (e) {
      setStatus('Pagina kan niet worden weergegeven: ' + (e instanceof Error ? e.message : String(e)));
      return;
    }
    cachePut(key, c);
  }
  if (token !== renderToken) return;
  baseCanvas = c;
  refreshPreview();
}

function refreshPreview() {
  const p = page();
  if (!displayCanvas || !baseCanvas || !p || !cur) return;
  displayCanvas.width = baseCanvas.width;
  displayCanvas.height = baseCanvas.height;
  const ctx = displayCanvas.getContext('2d')!;
  ctx.drawImage(baseCanvas, 0, 0);
  if (preview) applyRedactions(displayCanvas, p.boxes, docText(cur), S);
}

const KIND_LABEL: Record<BoxKind, string> = { naam: 'Naam', nummer: 'Nummer', klas: 'Klas', handmatig: 'Handmatig' };

function renderOverlay() {
  const p = page();
  if (!overlay || !p) return;
  overlay.replaceChildren(
    ...p.boxes.map((b) => {
      const e = el(
        'div',
        { class: `box ${b.kind}${b.id === selBox ? ' sel' : ''}`, 'data-id': b.id, title: b.label ? `Gevonden bij label "${b.label}"` : '' },
        el('span', { class: 'tag', title: 'Klik om te selecteren, sleep om te verplaatsen' }, `${KIND_LABEL[b.kind]}${b.text ? ' · tekst' : ''}${originTag(b)}`),
      );
      positionBox(e, b);
      if (b.id === selBox) for (const h of ['nw', 'ne', 'sw', 'se']) e.append(el('div', { class: `handle ${h}`, 'data-h': h }));
      return e;
    }),
  );
}

function originTag(b: Box) {
  if (b.label?.startsWith('afgeleid')) return ' · afgeleid';
  if (b.label?.startsWith('gezochte naam')) return ' · gezochte naam';
  if (b.label === 'sjabloon') return ' · sjabloon';
  return b.source === 'auto' ? ' · auto' : '';
}

function positionBox(e: HTMLElement, b: Box) {
  e.style.left = `${b.x * 100}%`;
  e.style.top = `${b.y * 100}%`;
  e.style.width = `${b.w * 100}%`;
  e.style.height = `${b.h * 100}%`;
}

function attachOverlayEvents(ov: HTMLDivElement) {
  let mode: 'none' | 'move' | 'resize' | 'draw' = 'none';
  let start = { x: 0, y: 0 };
  let orig: Box | null = null;
  let handle = '';
  let draft: HTMLDivElement | null = null;
  let moved = false;

  const pos = (e: PointerEvent) => {
    const r = ov.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };

  ov.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const p = page();
    if (!p) return;
    const t = e.target as HTMLElement;
    const boxEl = t.closest('.box') as HTMLElement | null;
    start = pos(e);
    moved = false;
    ov.setPointerCapture(e.pointerId);
    if (boxEl) {
      const b = p.boxes.find((x) => x.id === boxEl.dataset.id)!;
      if (selBox !== b.id) {
        selBox = b.id;
        renderOverlay();
        renderInspector();
      }
      orig = { ...b };
      handle = t.dataset.h ?? '';
      mode = handle ? 'resize' : 'move';
      snapshot();
    } else {
      mode = 'draw';
      if (selBox) {
        selBox = null;
        renderOverlay();
        renderInspector();
      }
      draft = el('div', { class: 'drawing' }) as HTMLDivElement;
      ov.append(draft);
    }
    e.preventDefault();
  });

  ov.addEventListener('pointermove', (e) => {
    if (mode === 'none') return;
    const p = page();
    if (!p) return;
    const q = pos(e);
    const dx = q.x - start.x;
    const dy = q.y - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 0.002) moved = true;
    if (mode === 'draw' && draft) {
      // Shift: strook over de volle breedte
      positionBox(draft, (e.shiftKey ? { x: 0, w: 1 } : { x: Math.min(start.x, q.x), w: Math.abs(dx) }) as Box);
      draft.style.top = `${Math.min(start.y, q.y) * 100}%`;
      draft.style.height = `${Math.abs(dy) * 100}%`;
      return;
    }
    const b = p.boxes.find((x) => x.id === selBox);
    if (!b || !orig) return;
    if (mode === 'move') {
      b.x = Math.min(1 - b.w, Math.max(0, orig.x + dx));
      b.y = Math.min(1 - b.h, Math.max(0, orig.y + dy));
    } else {
      let x0 = orig.x,
        y0 = orig.y,
        x1 = orig.x + orig.w,
        y1 = orig.y + orig.h;
      if (handle.includes('w')) x0 = Math.min(x1 - 0.005, Math.max(0, x0 + dx));
      if (handle.includes('e')) x1 = Math.max(x0 + 0.005, Math.min(1, x1 + dx));
      if (handle.includes('n')) y0 = Math.min(y1 - 0.005, Math.max(0, y0 + dy));
      if (handle.includes('s')) y1 = Math.max(y0 + 0.005, Math.min(1, y1 + dy));
      Object.assign(b, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    const be = ov.querySelector(`[data-id="${b.id}"]`) as HTMLElement | null;
    if (be) positionBox(be, b);
  });

  const end = (e: PointerEvent) => {
    if (mode === 'none') return;
    const p = page();
    if (mode === 'draw' && p && draft) {
      draft.remove();
      draft = null;
      const q = pos(e);
      const r = e.shiftKey
        ? { x: 0, y: Math.min(start.y, q.y), w: 1, h: Math.abs(q.y - start.y) }
        : { x: Math.min(start.x, q.x), y: Math.min(start.y, q.y), w: Math.abs(q.x - start.x), h: Math.abs(q.y - start.y) };
      if (r.w > 0.006 && r.h > 0.004) {
        snapshot();
        const b: Box = { id: uid(), ...r, kind: 'handmatig', source: 'handmatig', rot: guessRot(p), text: !p.boxes.some((x) => x.text) && !!cur && pageNeedsText(cur, p) };
        p.boxes.push(b);
        selBox = b.id;
        markDirty();
      }
    } else if (!moved) {
      undoStack.pop(); // klik zonder wijziging
    } else {
      markDirty();
    }
    mode = 'none';
    orig = null;
    renderOverlay();
    renderInspector();
    refreshPreview();
    renderStrip();
  };
  ov.addEventListener('pointerup', end);
  ov.addEventListener('pointercancel', end);
  ov.addEventListener('dblclick', (e) => {
    const p = page();
    const be = (e.target as HTMLElement).closest('.box') as HTMLElement | null;
    if (!p || !be) return;
    const b = p.boxes.find((x) => x.id === be.dataset.id);
    if (!b) return;
    snapshot();
    setTextBox(p, b, !b.text);
  });
}

/** Neem de tekstrichting over van andere vakken op de pagina (bijv. gedraaide bijlage). */
function guessRot(p: PageState): Rot {
  return p.boxes.find((b) => b.source === 'auto')?.rot ?? 0;
}
function pageNeedsText(d: Doc, p: PageState) {
  // Eerste vak op een pagina krijgt de tekst, tenzij een ander vak die al heeft.
  return !p.boxes.length || !d.pages.some((x) => x === p && x.boxes.some((b) => b.text));
}

function setTextBox(p: PageState, b: Box, on: boolean) {
  for (const x of p.boxes) if (on) x.text = x === b;
  b.text = on;
  markDirty();
  renderOverlay();
  renderInspector();
  refreshPreview();
}

function markDirty() {
  if (cur) cur.exported = false;
  renderDocList();
}

function deleteSelected() {
  const p = page();
  if (!p || !selBox) return;
  snapshot();
  p.boxes = p.boxes.filter((b) => b.id !== selBox);
  selBox = null;
  markDirty();
  renderOverlay();
  renderInspector();
  refreshPreview();
  renderStrip();
}

function emptyState() {
  return el(
    'div',
    { class: 'empty' },
    el(
      'div',
      { class: 'card' },
      el('h2', {}, 'Namen weg uit gescande toetsen'),
      el('p', { class: 'note' }, 'Alles gebeurt in deze browser op je eigen computer. Er wordt niets verstuurd.'),
      el(
        'ol',
        {},
        el('li', {}, 'Sleep de PDF\'s (scans) naar dit venster.'),
        el('li', {}, 'De app zoekt automatisch "Naam", "Examen no.", "Leerlingnummer" en "Klas" en markeert die vakken.'),
        el('li', {}, 'Controleer per pagina; teken zelf een vak door te slepen, of versleep/verklein een vak.'),
        el('li', {}, 'Exporteer: de vakken worden écht uit het beeld verwijderd en vervangen door "Kandidaat 67".'),
      ),
      el(
        'div',
        { style: 'display:flex;gap:8px;flex-wrap:wrap' },
        el('button', { class: 'btn primary', onclick: () => fileInput.click() }, 'Bestanden kiezen'),
        el(
          'button',
          {
            class: 'btn',
            title: 'Laadt drie neptoetsen met verzonnen namen, gemaakt in je browser',
            onclick: async () => {
              const { makeDemoFiles } = await import('./demo');
              addFiles(await makeDemoFiles());
            },
          },
          '🧪 Probeer met voorbeeld',
        ),
      ),
      el(
        'p',
        { class: 'note', style: 'margin-bottom:0' },
        'Het voorbeeld gebruikt verzonnen namen en wordt in je browser gemaakt. Of probeer ',
        el('button', {
          class: 'linkbtn',
          onclick: async () => {
            const { makeClassDemoFile } = await import('./demo');
            addFiles([await makeClassDemoFile()]);
          },
        }, 'een hele klas in één PDF'),
        '.',
      ),
      el(
        'p',
        { class: 'note', style: 'margin-bottom:0' },
        'Iets gemist in een al geëxporteerde PDF? ',
        el('button', { class: 'linkbtn', onclick: quickFix }, '✏️ Snel wissen'),
        ': open de PDF, trek een vak en sla op – zonder tekstherkenning of splitsen.',
      ),
    ),
  );
}

// ───────────────────────── Toolbar / strip / inspector ─────────────────────────

function renderToolbar() {
  const p = page();
  const has = !!(cur && p);
  const n = cur?.pages.length ?? 0;
  const tb = (label: string, title: string, fn: () => void, opts: { disabled?: boolean; active?: boolean } = {}) =>
    el('button', { class: 'btn small' + (opts.active ? ' active' : ''), title, 'aria-label': title, onclick: fn, disabled: opts.disabled ?? !has }, label);
  const item = (label: string, key: string, fn: () => void, disabled = !has) => {
    const b = mi(label, fn);
    b.append(el('kbd', {}, key));
    (b as HTMLButtonElement).disabled = disabled;
    return b;
  };
  keepOpen(toolbar, () =>
    toolbar.replaceChildren(
      tb('◀', 'Vorige pagina (←)', () => gotoPage(curPage - 1), { disabled: !has || curPage === 0 }),
      el('span', { class: 'info' }, has ? `Pagina ${curPage + 1} / ${n}` : '–'),
      tb('▶', 'Volgende pagina (→)', () => gotoPage(curPage + 1), { disabled: !has || curPage >= n - 1 }),
      el('span', { class: 'sep' }),
      tb('−', 'Uitzoomen (-)', () => setZoom(-1)),
      tb('Passend', 'Passend maken (0)', () => setZoom(0), { active: zoom === 'fit' }),
      tb('+', 'Inzoomen (+)', () => setZoom(1)),
      el('span', { class: 'sep' }),
      tb(preview ? '👁 Voorbeeld aan' : '👁 Voorbeeld', 'Toon hoe de uitvoer eruit ziet (P)', togglePreview, { active: preview }),
      tb('↶', 'Ongedaan maken (Ctrl+Z)', () => undo(), { disabled: !undoStack.length }),
      menu('page', '⋯', 'Meer paginaopties', [
        item('🎯 Zoom naar vakken', 'Z', zoomToBoxes, !has || !p?.boxes.length),
        item('🔍 Pagina opnieuw detecteren', 'D', () => cur && p && enqueue(cur, [p])),
        item('⟲ Linksom draaien', '⇧R', () => rotatePage(-1)),
        item('⟳ Rechtsom draaien', 'R', () => rotatePage(1)),
        item('↷ Opnieuw', 'Ctrl+Y', () => undo(true), !redoStack.length),
      ], 'right small'),
    ),
  );
  toolbar.title = has ? 'Tip: sleep op de pagina om een nieuw vak te tekenen' : '';
}

function setZoom(dir: number) {
  const p = page();
  if (!p) return;
  if (dir === 0) zoom = 'fit';
  else {
    const curW = stageSize(p).w;
    const z = curW / (p.wPt * (96 / 72));
    zoom = Math.min(4, Math.max(0.2, z * (dir > 0 ? 1.25 : 0.8)));
  }
  renderToolbar();
  renderEditor();
}

/** Vak meedraaien met de pagina (90° of 270° met de klok mee). */
function rotBox(b: Box, delta: 90 | 270): Box {
  const r: Box = { ...b, w: b.h, h: b.w, rot: ((b.rot + delta) % 360) as Rot };
  if (delta === 90) {
    r.x = 1 - (b.y + b.h);
    r.y = b.x;
    if (b.ax !== undefined && b.ay !== undefined) [r.ax, r.ay] = [1 - b.ay, b.ax];
  } else {
    r.x = b.y;
    r.y = 1 - (b.x + b.w);
    if (b.ax !== undefined && b.ay !== undefined) [r.ax, r.ay] = [b.ay, 1 - b.ax];
  }
  return r;
}

/** Draai de huidige pagina een kwartslag; vakken draaien mee. */
function rotatePage(dir: 1 | -1) {
  const p = page();
  if (!cur || !p) return;
  const delta = dir > 0 ? 90 : 270;
  p.userRot = (((p.userRot ?? 0) + delta) % 360) as Rot;
  p.boxes = p.boxes.map((b) => rotBox(b, delta));
  [p.wPt, p.hPt] = [p.hPt, p.wPt];
  p.thumb = undefined;
  // Ongedaan-maken van vakken op deze pagina past niet meer bij de nieuwe stand.
  for (const st of [undoStack, redoStack])
    for (let i = st.length - 1; i >= 0; i--) if (st[i].doc === cur && st[i].page === curPage) st.splice(i, 1);
  cur.exported = false;
  makeThumbs(cur);
  renderAll();
}

/** Zoom in op het gebied met vakken en scroll ernaartoe. */
async function zoomToBoxes() {
  const p = page();
  if (!p || !p.boxes.length) return;
  const x0 = Math.min(...p.boxes.map((b) => b.x));
  const y0 = Math.min(...p.boxes.map((b) => b.y));
  const x1 = Math.max(...p.boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...p.boxes.map((b) => b.y + b.h));
  const pageWpx = p.wPt * (96 / 72);
  const pageHpx = p.hPt * (96 / 72);
  const fitW = (editor.clientWidth - 40) / ((x1 - x0 + 0.08) * pageWpx);
  const fitH = (editor.clientHeight - 40) / ((y1 - y0 + 0.08) * pageHpx);
  zoom = Math.min(4, Math.max(0.2, Math.min(fitW, fitH)));
  renderToolbar();
  await renderEditor();
  if (!stage) return;
  const sw = stage.offsetWidth;
  const sh = stage.offsetHeight;
  editor.scrollLeft = stage.offsetLeft + ((x0 + x1) / 2) * sw - editor.clientWidth / 2;
  editor.scrollTop = stage.offsetTop + ((y0 + y1) / 2) * sh - editor.clientHeight / 2;
}

function togglePreview() {
  preview = !preview;
  stage?.classList.toggle('preview', preview);
  refreshPreview();
  renderToolbar();
}

function gotoPage(i: number) {
  if (!cur) return;
  const n = Math.max(0, Math.min(cur.pages.length - 1, i));
  if (n === curPage) return;
  curPage = n;
  selBox = null;
  renderToolbar();
  renderEditor();
  renderStrip();
  renderInspector();
}

function renderStrip() {
  if (!cur) {
    strip.replaceChildren();
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  strip.replaceChildren(
    ...cur.pages.map((p) =>
      el(
        'div',
        { class: 'thumb' + (p.index === curPage ? ' sel' : ''), onclick: () => gotoPage(p.index), title: p.detectNote ?? '' },
        p.thumb ? el('img', { src: p.thumb, alt: `Pagina ${p.index + 1}` }) : el('div', { style: 'width:100px;height:72px' }),
        el('span', { class: 'n' }, String(p.index + 1)),
        p.checked ? el('span', { class: 'badge ok', title: 'Gecontroleerd' }, '✓') : null,
        p.detect === 'bezig'
          ? el('span', { class: 'badge busy' }, '…')
          : p.boxes.length
            ? el('span', { class: 'badge' }, String(p.boxes.length))
            : null,
      ),
    ),
  );
  strip.querySelector('.sel')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function copyBoxes(target: 'pages' | 'docs' | 'all') {
  const p = page();
  if (!cur || !p || !p.boxes.length) return;
  const srcBoxes = p.boxes;
  let count = 0;
  const targets: { d: Doc; p: PageState }[] = [];
  if (target === 'pages') cur.pages.forEach((q) => q !== p && targets.push({ d: cur!, p: q }));
  if (target === 'docs') docs.forEach((d) => d !== cur && d.pages[curPage] && targets.push({ d, p: d.pages[curPage] }));
  if (target === 'all') docs.forEach((d) => d.pages.forEach((q) => q !== p && targets.push({ d, p: q })));
  for (const { d, p: q } of targets) {
    // Alleen toepassen op pagina's met dezelfde oriëntatie
    if (Math.sign(q.wPt - q.hPt) !== Math.sign(p.wPt - p.hPt)) continue;
    for (const b of srcBoxes) {
      if (q.boxes.some((o) => iou(o, b) > 0.8)) continue;
      q.boxes.push({ ...b, id: uid(), source: 'handmatig', text: b.text && !q.boxes.some((o) => o.text) });
      count++;
    }
    d.exported = false;
  }
  toast(`${count} vak(ken) gekopieerd naar ${targets.length} pagina('s).`);
  renderDocList();
  renderStrip();
}

function iou(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

function clearPageBoxes(all: boolean) {
  if (!cur) return;
  const p = page();
  if (!p) return;
  if (all && !confirm('Alle vakken op alle pagina\'s van dit document wissen?')) return;
  snapshot();
  for (const q of all ? cur.pages : [p]) q.boxes = [];
  selBox = null;
  markDirty();
  renderAll();
}

function renderInspector() {
  const p = page();
  if (!cur) {
    inspector.replaceChildren(
      el('div', { class: 'section' }, el('h3', {}, 'Legenda'), legend()),
      el('div', { class: 'section' }, el('h3', {}, 'Privacy'), el('p', { class: 'note' }, 'Bestanden worden alleen in het werkgeheugen van deze browser geopend. Sluit je het tabblad, dan is alles weg.')),
    );
    return;
  }
  const d = cur;
  const numInput = el('input', { type: 'number', min: '0', value: String(d.num) }) as HTMLInputElement;
  const numNote = el('div', { class: 'note' });
  numInput.addEventListener('change', () => {
    const v = Math.max(0, Math.floor(Number(numInput.value)));
    if (!Number.isFinite(v)) return;
    if (usedNumbers(d).has(v)) {
      numNote.textContent = `Nummer ${v} is al in gebruik.`;
      numNote.className = 'note err';
      numInput.value = String(d.num);
      return;
    }
    d.num = v;
    d.exported = false;
    numNote.textContent = '';
    renderDocList();
    renderInspector();
    refreshPreview();
  });

  const sections: HTMLElement[] = [];
  sections.push(
    el(
      'div',
      { class: 'section' },
      el('h3', { class: 'with-eye' }, 'Dit document', el('button', { class: 'eye', title: 'Analyse: wat de tekstherkenning zag en hoe er gesplitst is', 'aria-label': 'Analyse bekijken', onclick: () => openAnalysis(d) }, '👁')),
      el(
        'div',
        { class: 'field' },
        el('label', {}, 'Kandidaatnummer'),
        el('div', { class: 'inline' }, numInput, el('button', { class: 'btn small', title: 'Ander willekeurig nummer', 'aria-label': 'Ander willekeurig nummer', onclick: () => { d.num = uniqueNumber(S.numMin, S.numMax, usedNumbers(d)); d.exported = false; renderDocList(); renderInspector(); refreshPreview(); } }, '🎲')),
        numNote,
      ),
      el('div', { class: 'note' }, 'Vervangende tekst: ', el('strong', {}, docText(d))),
      d.splitInfo
        ? el(
            'button',
            { class: 'btn small split-btn', onclick: () => openSplitReview(splitGroup(d)), title: `Deel van "${d.splitInfo.from}": splitsing bekijken of aanpassen` },
            `✂ Splitsing bekijken (${splitGroup(d).length} kandidaten)`,
          )
        : null,
      more('doc', 'Meer documentacties',
        el('button', { class: 'btn small', onclick: () => exportAll([d]) }, '⬇ Alleen dit document exporteren'),
        d.splitInfo ? null : el('button', { class: 'btn small', onclick: () => openSplitReview([d], d.splitSuggest), disabled: d.pages.length < 2, title: 'Eén scan met meerdere leerlingen opdelen' }, '✂ Splitsen…'),
        el(
          'button',
          {
            class: 'btn small',
            disabled: !docs[docs.indexOf(d) + 1] || docs[docs.indexOf(d) + 1].status !== 'klaar',
            title: 'Het volgende document in de lijst achter dit document plakken (bijv. een apart gescande bijlage)',
            onclick: () => {
              const nxt = docs[docs.indexOf(d) + 1];
              if (!nxt) return;
              if (detectQueue.some((j) => j.doc === d || j.doc === nxt)) return toast('Wacht tot de detectie klaar is.');
              if (confirm(`"${nxt.name}" achter "${d.name}" plakken tot één document (${docText(d)})?`)) mergeDocs([d, nxt]);
            },
          },
          '⤵ Samenvoegen met volgende',
        ),
      ),
    ),
  );

  if (p) {
    const b = p.boxes.find((x) => x.id === selBox);
    if (b) {
      const kind = el('select', {}, ...(['naam', 'nummer', 'klas', 'handmatig'] as BoxKind[]).map((k) => el('option', { value: k, selected: k === b.kind }, KIND_LABEL[k]))) as HTMLSelectElement;
      kind.addEventListener('change', () => {
        snapshot();
        b.kind = kind.value as BoxKind;
        markDirty();
        renderOverlay();
      });
      const rot = el('select', {}, ...([0, 90, 180, 270] as Rot[]).map((r) => el('option', { value: String(r), selected: r === b.rot }, r === 0 ? 'Normaal' : `${r}° gedraaid`))) as HTMLSelectElement;
      rot.addEventListener('change', () => {
        snapshot();
        b.rot = Number(rot.value) as Rot;
        markDirty();
        refreshPreview();
      });
      const txt = el('input', { type: 'checkbox', checked: b.text }) as HTMLInputElement;
      txt.addEventListener('change', () => {
        snapshot();
        setTextBox(p, b, txt.checked);
      });
      sections.push(
        el(
          'div',
          { class: 'section' },
          el('h3', {}, 'Geselecteerd vak'),
          el('div', { class: 'field' }, el('label', {}, 'Soort'), kind),
          el('label', { class: 'check' }, txt, el('span', {}, `Hier "${docText(d)}" plaatsen`, el('div', { class: 'note' }, 'Dubbelklik op een vak om dit te wisselen.'))),
          el('div', { class: 'field' }, el('label', {}, 'Tekstrichting'), rot),
          b.label ? el('div', { class: 'note' }, `Gevonden bij label: "${b.label}"`) : null,
          el('button', { class: 'btn small danger', onclick: deleteSelected, style: 'margin-top:8px' }, '🗑 Vak verwijderen'),
        ),
      );
    }

    sections.push(
      el(
        'div',
        { class: 'section' },
        el('h3', {}, `Pagina ${curPage + 1}`),
        el(
          'div',
          { class: p.detect === 'fout' ? 'note err' : 'note' },
          p.detect === 'nog niet' ? 'Nog niet automatisch gecontroleerd.' : p.detectNote ?? '',
        ),
        el(
          'button',
          {
            class: 'btn small' + (p.checked ? ' active' : ''),
            style: 'margin-top:10px;width:100%',
            title: 'Markeer deze pagina als gecontroleerd (zet waarschuwingen uit)',
            onclick: () => {
              p.checked = !p.checked;
              renderDocList();
              renderStrip();
              renderInspector();
            },
          },
          p.checked ? '✓ Gecontroleerd' : 'Markeer als gecontroleerd',
        ),
        more('page', 'Meer pagina-acties',
          el('button', { class: 'btn small', onclick: () => enqueue(d, [p]), disabled: p.detect === 'bezig' }, '🔍 Deze pagina detecteren'),
          el('button', { class: 'btn small', onclick: () => clearPageBoxes(false), disabled: !p.boxes.length }, 'Vakken op deze pagina wissen'),
          el('div', { class: 'note', style: 'margin-top:6px' }, 'Vakken kopiëren – zelfde formulier op elke pagina of bij elke leerling?'),
          el('button', { class: 'btn small', onclick: () => copyBoxes('pages'), disabled: !p.boxes.length }, '→ Alle pagina\'s van dit document'),
          el('button', { class: 'btn small', onclick: () => copyBoxes('docs'), disabled: !p.boxes.length || docs.length < 2 }, `→ Pagina ${curPage + 1} van alle documenten`),
          el('button', { class: 'btn small', onclick: () => copyBoxes('all'), disabled: !p.boxes.length }, '→ Alle pagina\'s van alle documenten'),
        ),
      ),
    );
  }

  sections.push(
    el('div', { class: 'section' }, el('h3', {}, 'Legenda'), legend()),
    el(
      'details',
      { class: 'section fold', 'data-key': 'keys' },
      el('summary', {}, el('h3', {}, 'Sneltoetsen')),
      el('dl', { class: 'kv' },
        el('dt', {}, el('kbd', {}, '←'), ' ', el('kbd', {}, '→')), el('dd', {}, 'Pagina'),
        el('dt', {}, el('kbd', {}, 'PgUp'), ' ', el('kbd', {}, 'PgDn')), el('dd', {}, 'Document'),
        el('dt', {}, el('kbd', {}, 'Del')), el('dd', {}, 'Vak wissen'),
        el('dt', {}, el('kbd', {}, '←↑→↓')), el('dd', {}, 'Vak verschuiven (geselecteerd)'),
        el('dt', {}, el('kbd', {}, 'Shift'), '+sleep'), el('dd', {}, 'Strook over volle breedte'),
        el('dt', {}, el('kbd', {}, 'P')), el('dd', {}, 'Voorbeeld'),
        el('dt', {}, el('kbd', {}, 'Z')), el('dd', {}, 'Naar vakken zoomen'),
        el('dt', {}, el('kbd', {}, 'R')), el('dd', {}, 'Pagina draaien'),
        el('dt', {}, el('kbd', {}, 'D')), el('dd', {}, 'Detecteer pagina'),
        el('dt', {}, el('kbd', {}, 'T')), el('dd', {}, 'Tekst in vak aan/uit'),
        el('dt', {}, el('kbd', {}, 'Ctrl+Z')), el('dd', {}, 'Ongedaan maken'),
      ),
    ),
  );
  keepOpen(inspector, () => inspector.replaceChildren(...sections));
}

/** Inklapbaar blok met minder vaak gebruikte knoppen. */
function more(key: string, label: string, ...items: (HTMLElement | null)[]) {
  return el('details', { class: 'more', 'data-key': key }, el('summary', {}, label), el('div', { class: 'more-list' }, ...items));
}

function legend() {
  return el(
    'div',
    { class: 'legend' },
    el('span', { style: '--c: var(--naam)' }, 'Naam'),
    el('span', { style: '--c: var(--nummer)' }, 'Nummer'),
    el('span', { style: '--c: var(--klas)' }, 'Klas'),
    el('span', { style: '--c: var(--handmatig)' }, 'Handmatig'),
  );
}

function renderAll() {
  renderDocList();
  renderToolbar();
  renderEditor();
  renderStrip();
  renderInspector();
}

// ───────────────────────── Export ─────────────────────────

function outName(d: Doc, taken: Set<string>) {
  let base = safeFileName(S.fileNameTemplate.replace(/\{tekst\}/g, docText(d)).replace(/\{n\}/g, String(d.num)));
  let name = `${base}.pdf`;
  let i = 2;
  while (taken.has(name.toLowerCase())) name = `${base} (${i++}).pdf`;
  taken.add(name.toLowerCase());
  return name;
}

function forbiddenTokens(d: Doc) {
  return d.name
    .replace(/\.[^.]+$/, '')
    .split(/[\s_\-.,()]+/)
    .map(norm)
    .filter((t) => t.length >= 4 && !/^\d+$/.test(t) && !['scan', 'toets', 'kandidaat'].includes(t))
    .concat(namesFor(d));
}

async function exportAll(list?: Doc[]) {
  const todo = (list ?? docs).filter((d) => d.status === 'klaar' && d.src);
  if (!todo.length) return;
  const busy = docs.some((d) => d.pages.some((p) => p.detect === 'bezig')) || detectQueue.length > 0 || detectRunning > 0;
  if (busy && !confirm('De detectie is nog bezig. Toch nu exporteren?')) return;
  const attention = todo.filter((d) => needsAttention(d) && d.pages.some((p) => p.boxes.length));
  if (
    attention.length &&
    !confirm(
      `${attention.length} document(en) hebben aandachtspunten (bijv. een pagina zonder vak terwijl die bij anderen wel vakken heeft): ${attention
        .slice(0, 5)
        .map(docText)
        .join(', ')}${attention.length > 5 ? ', …' : ''}.

Toch exporteren? (Tip: gebruik eerst het controle-overzicht.)`,
    )
  )
    return;
  const noName = todo.filter((d) => !d.pages.some((p) => p.boxes.length));
  if (noName.length && !confirm(`${noName.length} document(en) hebben geen enkel vak. Die worden zonder wijzigingen (maar wel als nieuwe afbeelding) geëxporteerd. Doorgaan?`)) return;

  const results: ExportResult[] = [];
  const taken = new Set<string>();
  const totalPages = todo.reduce((a, d) => a + d.pages.length, 0);
  let done = 0;
  busyExport = true;
  updateBusy();
  for (const d of todo) {
    setStatus(`Exporteren: ${docText(d)}…`);
    try {
      const bytes = await exportDocument(d.src!, d.pages, docText(d), S, () => setProgress(++done, totalPages), d.bpp ?? 0);
      setStatus(`Controleren: ${docText(d)}…`);
      const verify = await verifyOutput(bytes, forbiddenTokens(d), d.pages.length);
      results.push({ doc: d, fileName: outName(d, taken), bytes, verify });
      d.exported = true;
    } catch (e) {
      console.error(e);
      toast(`Fout bij exporteren van ${docText(d)}: ${e instanceof Error ? e.message : e}`);
    }
  }
  setProgress(0, 0);
  busyExport = false;
  updateBusy();
  setStatus(`${results.length} document(en) geëxporteerd en gecontroleerd.`);
  lastExport = results;
  renderDocList();
  showExportDialog(results);
}

function showExportDialog(results: ExportResult[]) {
  const allOk = results.every((r) => r.verify.ok);
  const total = results.reduce((a, r) => a + r.bytes.length, 0);
  const dlg = el('dialog');
  const close = () => {
    dlg.close();
    dlg.remove();
  };
  const downloadZip = () => {
    const files: Record<string, [Uint8Array, { level: 0 }]> = {};
    for (const r of results) files[r.fileName] = [r.bytes, { level: 0 }];
    download(zipSync(files), 'toetsen-geanonimiseerd.zip', 'application/zip');
  };
  const downloadCombined = async () => {
    const sorted = [...results].sort((a, b) => a.doc.num - b.doc.num);
    const bytes = await combineDocuments(sorted.map((r) => ({ bytes: r.bytes, title: docText(r.doc) })));
    download(bytes, 'toetsen-geanonimiseerd (samengevoegd).pdf', 'application/pdf');
  };
  dlg.append(
    el('div', { class: 'dhead' }, el('h2', {}, allOk ? '✅ Export klaar en gecontroleerd' : '⚠ Export klaar – controleer de meldingen'), el('button', { class: 'btn icon', onclick: close }, '✕')),
    el(
      'div',
      { class: 'dbody' },
      el('p', { class: 'note', style: 'margin-top:0' }, `${results.length} bestand(en), samen ${fmtBytes(total)}. Elke pagina is opnieuw opgebouwd als nieuwe afbeelding; de oorspronkelijke beeldgegevens zitten er niet meer in.`),
      el(
        'ul',
        { class: 'results' },
        ...results.map((r) =>
          el(
            'li',
            {},
            el('strong', {}, r.fileName),
            ` (${fmtBytes(r.bytes.length)}, ${r.doc.pages.reduce((a, p) => a + p.boxes.length, 0)} vak(ken) weggehaald) `,
            el('button', { class: 'btn small', onclick: () => download(r.bytes, r.fileName, 'application/pdf') }, 'Download'),
            el('div', {}, ...r.verify.checks.map((c) => el('div', { class: c.ok ? 'ok' : 'bad' }, `${c.ok ? '✓' : '✗'} ${c.msg}`))),
          ),
        ),
      ),
      S.keyCsv
        ? el('p', { class: 'note warn' }, '🗝 Het sleutelbestand bevat de echte namen. Bewaar het apart en veilig, en stuur het niet mee met de geanonimiseerde toetsen.')
        : null,
    ),
    el(
      'div',
      { class: 'dfoot' },
      el('button', { class: 'btn', onclick: () => startMatcher(), title: 'Elke toets aan een leerling uit de leerlinglijst koppelen (voor het sleutelbestand)' }, '👥 Leerlingen koppelen'),
      S.keyCsv ? el('button', { class: 'btn', onclick: downloadKey }, '🗝 Sleutel (CSV)') : null,
      results.length > 1 ? el('button', { class: 'btn', onclick: downloadCombined }, '📚 Eén samengevoegde PDF') : null,
      results.length > 1
        ? el('button', { class: 'btn primary', onclick: downloadZip }, '⬇ Download alles (ZIP)')
        : el('button', { class: 'btn primary', onclick: () => download(results[0].bytes, results[0].fileName, 'application/pdf') }, '⬇ Download PDF'),
    ),
  );
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  if (S.combined && results.length > 1) downloadCombined();
}

// ───────────────────────── Analyse (oogje) ─────────────────────────

/** Laat zien wat de tekstherkenning per pagina zag en hoe de splitsheuristiek besliste. */
function openAnalysis(d: Doc) {
  const dlg = el('dialog', { class: 'wide' });
  const close = () => dlg.close();
  const info = d.splitInfo;
  const analysis = info ? null : analyzeClassSplit(d.pages);
  const starts = new Set(analysis?.result?.starts ?? []);
  const unfinished = d.pages.some((p) => p.detect === 'bezig' || p.detect === 'nog niet');

  const splitSection: HTMLElement[] = [];
  if (info) {
    splitSection.push(
      el('p', {}, `Deel ${info.part} van ${info.total} uit "${info.from}" (pagina ${info.first}–${info.last} van het origineel), gesplitst: ${info.how}.`),
      el('button', { class: 'btn small', onclick: () => { close(); openSplitReview(splitGroup(d)); } }, '✂ Splitsing bekijken/aanpassen…'),
    );
  } else if (analysis?.result) {
    const r = analysis.result;
    splitSection.push(
      el(
        'p',
        {},
        `Lijkt ${r.starts.length + 1} toetsen te bevatten (${r.method === 'ritme' ? 'vast aantal pagina\'s per leerling' : 'bij elk voorblad'}), beginnend op pagina ${[0, ...r.starts].map((i) => i + 1).join(', ')}. `,
        r.sure ? 'Zeker genoeg om automatisch te splitsen.' : 'Niet zeker genoeg om dat automatisch te doen.',
      ),
      el('button', { class: 'btn small', onclick: () => { close(); openSplitReview([d], r.starts); } }, `✂ Bekijken: ${r.starts.length + 1} toetsen`),
    );
  } else {
    splitSection.push(el('p', {}, unfinished ? 'De detectie is nog niet klaar voor alle pagina\'s.' : 'Geen klassenscan herkend: dit document wordt als één toets behandeld.'));
  }
  const log = info?.log ?? analysis?.log ?? [];
  if (log.length) splitSection.push(el('details', { class: 'more' }, el('summary', {}, 'Afwegingen van de splitsheuristiek'), el('ol', { class: 'an-log' }, ...log.map((l) => el('li', {}, l)))));

  const fmt = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);
  const rows = d.pages.map((p) => {
    const naam = p.boxes.some((b) => b.kind === 'naam');
    const sim = p.index === 0 ? null : printedSimilarity(d.pages[0].printed, p.printed);
    const role = p.index === 0 ? 'begin' : starts.has(p.index) ? 'begin' : '';
    const tr = el(
      'tr',
      { class: (role ? 'start ' : '') + 'clickable', title: 'Open deze pagina', onclick: () => { cur = d; curPage = p.index; selBox = null; close(); renderAll(); } },
      el('td', {}, String(p.index + 1)),
      el('td', {}, naam ? '✓' : ''),
      el('td', {}, p.boxes.map((b) => KIND_LABEL[b.kind]).join(', ')),
      el('td', { title: p.printed?.join(' ') ?? '' }, p.printed ? String(p.printed.length) : '–'),
      el('td', { class: sim !== null && sim >= SAME_SHEET ? 'hi' : '' }, p.index === 0 ? '(zelf)' : fmt(sim)),
      el('td', {}, role ? '▶ nieuwe leerling' : ''),
      el('td', { class: 'an-note' }, p.detect === 'nog niet' ? 'nog niet gedetecteerd' : p.detect === 'bezig' ? 'bezig…' : (p.detectNote ?? '')),
    );
    return tr;
  });

  dlg.append(
    el('div', { class: 'dhead' }, el('h2', {}, `👁 Analyse – ${docText(d)}`), el('button', { class: 'btn icon', onclick: close }, '✕')),
    el(
      'div',
      { class: 'dbody' },
      el('p', { class: 'note', style: 'margin-top:0' }, `${d.name} · ${d.pages.length} pagina's. Alles hieronder blijft op je computer.`),
      el('h3', {}, 'Splitsen'),
      ...splitSection,
      el('h3', {}, 'Per pagina'),
      el(
        'p',
        { class: 'note' },
        `"Gedrukte woorden" = goed leesbare woorden (wijs aan voor de lijst). "Gelijk aan p. 1" = hoeveel daarvan overeenkomt met pagina 1 van dit document; vanaf ${Math.round(SAME_SHEET * 100)}% geldt het als hetzelfde blad (een voorblad).`,
      ),
      el(
        'div',
        { class: 'an-wrap' },
        el(
          'table',
          { class: 'an-table' },
          el('thead', {}, el('tr', {}, ...['Pag.', 'Naamvak', 'Vakken', 'Gedrukte woorden', 'Gelijk aan p. 1', 'Splitsen', 'Tekstherkenning'].map((h) => el('th', {}, h)))),
          el('tbody', {}, ...rows),
        ),
      ),
    ),
    el('div', { class: 'dfoot' }, el('button', { class: 'btn primary', onclick: close }, 'Sluiten')),
  );
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

// ───────────────────────── Sjablonen ─────────────────────────

interface Template {
  name: string;
  created: string;
  pages: { index: number; landscape: boolean; boxes: Omit<Box, 'id'>[] }[];
}
const TPL_KEY = 'namenweg.templates.v1';
function loadTemplates(): Template[] {
  try {
    return JSON.parse(localStorage.getItem(TPL_KEY) || '[]');
  } catch {
    return [];
  }
}
function saveTemplates(t: Template[]) {
  try {
    localStorage.setItem(TPL_KEY, JSON.stringify(t));
  } catch {
    toast('Opslaan in de browser lukt niet (privévenster?). Gebruik "Exporteren".');
  }
}

/** Een sjabloon bevat alleen posities van vakken, nooit beeld of namen. */
function templateFrom(d: Doc, name: string): Template {
  return {
    name,
    created: new Date().toISOString(),
    pages: d.pages
      .filter((p) => p.boxes.length)
      .map((p) => ({
        index: p.index,
        landscape: p.wPt > p.hPt,
        boxes: p.boxes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, kind: b.kind, source: 'handmatig' as const, rot: b.rot, text: b.text, label: 'sjabloon' })),
      })),
  };
}

function applyTemplate(t: Template, mode: 'toevoegen' | 'vervangen') {
  let n = 0;
  for (const d of docs) {
    if (d.status !== 'klaar') continue;
    for (const tp of t.pages) {
      const p = d.pages[tp.index];
      if (!p || p.wPt > p.hPt !== tp.landscape) continue;
      if (mode === 'vervangen') p.boxes = [];
      for (const b of tp.boxes) {
        if (p.boxes.some((o) => iou(o, b) > 0.8)) continue;
        p.boxes.push({ ...b, id: uid(), text: b.text && !p.boxes.some((o) => o.text) });
        n++;
      }
      d.exported = false;
    }
  }
  toast(`Sjabloon "${t.name}" toegepast: ${n} vak(ken) geplaatst.`);
  renderAll();
}

function openTemplates() {
  const dlg = el('dialog');
  const listEl = el('div');
  const nameIn = el('input', { type: 'text', placeholder: 'Bijv. Natuurkunde SE3 antwoordblad' }) as HTMLInputElement;
  const fileIn = el('input', { type: 'file', accept: 'application/json,.json', hidden: true }) as HTMLInputElement;
  const render = () => {
    const ts = loadTemplates();
    listEl.replaceChildren(
      ...(ts.length
        ? ts.map((t, i) =>
            el(
              'div',
              { class: 'tpl' },
              el('div', {}, el('strong', {}, t.name), el('div', { class: 'note' }, `${t.pages.length} pagina('s), ${t.pages.reduce((a, p) => a + p.boxes.length, 0)} vakken · ${new Date(t.created).toLocaleDateString('nl-NL')}`)),
              el('div', { class: 'tpl-actions' },
                el('button', { class: 'btn small primary', disabled: !docs.length, onclick: () => { applyTemplate(t, 'toevoegen'); dlg.close(); } }, 'Toepassen'),
                el('button', { class: 'btn small', disabled: !docs.length, title: 'Bestaande vakken eerst wissen', onclick: () => { if (confirm('Alle bestaande vakken op de betreffende pagina\'s vervangen?')) { applyTemplate(t, 'vervangen'); dlg.close(); } } }, 'Vervangen'),
                el('button', { class: 'btn small', onclick: () => download(new Blob([JSON.stringify(t, null, 1)], { type: 'application/json' }), `${safeFileName(t.name)}.namenweg.json`) }, 'Exporteren'),
                el('button', { class: 'btn small danger', onclick: () => { if (confirm(`Sjabloon "${t.name}" verwijderen?`)) { ts.splice(i, 1); saveTemplates(ts); render(); } } }, '🗑'),
              ),
            ),
          )
        : [el('p', { class: 'note' }, 'Nog geen sjablonen opgeslagen.')]),
    );
  };
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    try {
      const t = JSON.parse(await f.text()) as Template;
      if (!t || !Array.isArray(t.pages)) throw new Error('geen sjabloon');
      // Alleen bekende velden overnemen
      const clean: Template = {
        name: String(t.name || f.name).slice(0, 100),
        created: String(t.created || new Date().toISOString()),
        pages: t.pages.map((p) => ({
          index: Math.max(0, Math.floor(Number(p.index) || 0)),
          landscape: !!p.landscape,
          boxes: (p.boxes || []).map((b) => ({
            x: +b.x, y: +b.y, w: +b.w, h: +b.h,
            kind: (['naam', 'nummer', 'klas', 'handmatig'] as BoxKind[]).includes(b.kind) ? b.kind : 'handmatig',
            source: 'handmatig' as const,
            rot: ([0, 90, 180, 270] as Rot[]).includes(b.rot) ? b.rot : 0,
            text: !!b.text,
            label: 'sjabloon',
          })).filter((b) => [b.x, b.y, b.w, b.h].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)),
        })),
      };
      const ts = loadTemplates();
      ts.push(clean);
      saveTemplates(ts);
      render();
    } catch {
      toast('Dit bestand is geen geldig NamenWeg-sjabloon.');
    }
    fileIn.value = '';
  });
  const saveCur = () => {
    if (!cur || !cur.pages.some((p) => p.boxes.length)) return toast('Het huidige document heeft geen vakken.');
    const name = nameIn.value.trim() || `Sjabloon ${new Date().toLocaleDateString('nl-NL')}`;
    const ts = loadTemplates();
    ts.push(templateFrom(cur, name));
    saveTemplates(ts);
    nameIn.value = '';
    render();
  };
  dlg.append(
    el('div', { class: 'dhead' }, el('h2', {}, '📐 Sjablonen'), el('button', { class: 'btn icon', onclick: () => dlg.close() }, '✕')),
    el(
      'div',
      { class: 'dbody' },
      el('p', { class: 'note', style: 'margin-top:0' }, 'Gebruik je vaker hetzelfde antwoordblad? Sla de vakken van een document op als sjabloon en pas ze later in één keer toe op een nieuwe klas. Een sjabloon bevat alleen de posities van de vakken – geen beelden of namen.'),
      el('fieldset', {},
        el('legend', {}, 'Huidig document opslaan'),
        el('div', { class: 'field' }, el('label', {}, 'Naam'), nameIn),
        el('div', { style: 'display:flex;gap:8px;margin-bottom:10px' },
          el('button', { class: 'btn primary', onclick: saveCur, disabled: !cur }, '💾 Opslaan als sjabloon'),
          el('button', { class: 'btn', onclick: () => fileIn.click() }, '📂 Importeren (.json)'),
          fileIn,
        ),
      ),
      el('h3', { style: 'margin:6px 0' }, 'Opgeslagen sjablonen'),
      listEl,
    ),
    el('div', { class: 'dfoot' }, el('button', { class: 'btn', onclick: () => dlg.close() }, 'Sluiten')),
  );
  render();
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

// ───────────────────────── Controle-overzicht ─────────────────────────

/**
 * Toont van elke pagina een uitsnede van het eindresultaat: rond de vakken, of (zonder vakken)
 * de bovenkant van de pagina, waar namen meestal staan. Zo controleer je een hele klas in één keer.
 */
function openOverview() {
  const list = docs.filter((d) => d.status === 'klaar' && d.src);
  if (!list.length) return;
  const dlg = el('dialog', { class: 'wide' });
  const grid = el('div', { class: 'ov-grid' });
  const onlyEmpty = el('input', { type: 'checkbox' }) as HTMLInputElement;
  let cancelled = false;
  const close = () => {
    cancelled = true;
    dlg.close();
  };
  const cards: { d: Doc; p: PageState; card: HTMLElement }[] = [];
  for (const d of list)
    for (const p of d.pages) {
      const card = el(
        'button',
        {
          class: 'ov-card' + (p.boxes.length ? '' : ' empty'),
          title: 'Open deze pagina',
          onclick: () => {
            cur = d;
            curPage = p.index;
            selBox = null;
            close();
            renderAll();
          },
        },
        el('div', { class: 'ov-img' }, el('span', { class: 'note' }, 'laden…')),
        el('div', { class: 'ov-cap' }, el('strong', {}, docText(d)), ` · p. ${p.index + 1}`, p.boxes.length ? ` · ${p.boxes.length} vak${p.boxes.length === 1 ? '' : 'ken'}` : ' · geen vakken (bovenkant getoond)'),
      );
      cards.push({ d, p, card });
      grid.append(card);
    }
  onlyEmpty.addEventListener('change', () => {
    for (const c of cards) c.card.hidden = onlyEmpty.checked && c.p.boxes.length > 0;
  });
  dlg.append(
    el('div', { class: 'dhead' }, el('h2', {}, '🔎 Controle-overzicht'), el('button', { class: 'btn icon', onclick: close }, '✕')),
    el(
      'div',
      { class: 'dbody' },
      el('p', { class: 'note', style: 'margin-top:0' }, 'Zo ziet de uitvoer eruit. Staat er nog ergens een naam of nummer? Klik op de pagina om hem te openen en een vak te tekenen.'),
      el('label', { class: 'check' }, onlyEmpty, el('span', {}, "Alleen pagina's zonder vakken tonen")),
      grid,
    ),
    el('div', { class: 'dfoot' }, el('button', { class: 'btn primary', onclick: close }, 'Sluiten')),
  );
  document.body.append(dlg);
  dlg.addEventListener('close', () => {
    cancelled = true;
    dlg.remove();
  });
  dlg.showModal();

  (async () => {
    for (const { d, p, card } of cards) {
      if (cancelled) return;
      try {
        const dpi = 70;
        const c = await d.src!.render(p.index, dpi);
        applyRedactions(c, p.boxes, docText(d), S);
        const W = c.width;
        const H = c.height;
        let r = { x0: 0, y0: 0, x1: W, y1: H * 0.28 };
        if (p.boxes.length) {
          const x0 = Math.min(...p.boxes.map((b) => b.x)) * W;
          const y0 = Math.min(...p.boxes.map((b) => b.y)) * H;
          const x1 = Math.max(...p.boxes.map((b) => b.x + b.w)) * W;
          const y1 = Math.max(...p.boxes.map((b) => b.y + b.h)) * H;
          const m = 0.06 * Math.max(W, H);
          r = { x0: Math.max(0, x0 - m), y0: Math.max(0, y0 - m), x1: Math.min(W, x1 + m), y1: Math.min(H, y1 + m) };
        }
        const out = document.createElement('canvas');
        out.width = Math.round(r.x1 - r.x0);
        out.height = Math.round(r.y1 - r.y0);
        out.getContext('2d')!.drawImage(c, r.x0, r.y0, out.width, out.height, 0, 0, out.width, out.height);
        release(c);
        card.querySelector('.ov-img')!.replaceChildren(el('img', { src: out.toDataURL('image/jpeg', 0.8), alt: '' }));
      } catch {
        card.querySelector('.ov-img')!.replaceChildren(el('span', { class: 'note err' }, 'kan niet tonen'));
      }
    }
  })();
}

function downloadKey() {
  const list = docs.filter((d) => d.status === 'klaar');
  if (!list.length) return;
  const names = new Map(lastExport.map((r) => [r.doc, r.fileName]));
  const roster = matchState.roster;
  const rows: (string | number)[][] = [
    roster
      ? ['Kandidaat', 'Nummer', 'Leerling', 'Leerlingnummer', 'Klas', 'Origineel bestand', 'Geëxporteerd bestand', "Pagina's"]
      : ['Kandidaat', 'Nummer', 'Origineel bestand', 'Geëxporteerd bestand', "Pagina's"],
  ];
  for (const d of [...list].sort((a, b) => a.num - b.num)) {
    const s = studentById(d.student);
    const who = roster ? [s ? s.name : d.student === UNK ? '(niet in lijst)' : '(niet gekoppeld)', s?.nr ?? '', s?.klas ?? ''] : [];
    rows.push([docText(d), d.num, ...who, d.name, names.get(d) ?? '', d.pages.length]);
  }
  // Leerlingen van de lijst zonder toets (bijv. afwezig).
  if (roster)
    for (const s of roster.students)
      if (!list.some((d) => d.student === s.id)) rows.push(['(geen toets)', '', s.name, s.nr, s.klas, '', '', '']);
  const n = new Date();
  const pad = (v: number) => String(v).padStart(2, '0');
  const stamp = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}-${pad(n.getHours())}${pad(n.getMinutes())}`;
  download(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }), `sleutel-namenweg-${stamp}.csv`);
  matchState.dirty = false;
}

/** Venster om de toetsen aan de leerlinglijst te koppelen (optioneel beginnend bij `start`). */
function startMatcher(start?: Doc) {
  if (detectQueue.length || detectRunning > 0) toast('Let op: de detectie is nog bezig; naamvakken kunnen nog veranderen.');
  openMatcher({
    docs: () => docs,
    label: (d) => docText(d as Doc),
    merge: (list) => mergeDocs(list as Doc[], undefined, true),
    openSplit: (d, onDone) => {
      const g = splitGroup(d as Doc);
      if (g.some((x) => detectQueue.some((j) => j.doc === x) || x.pages.some((p) => p.detect === 'bezig'))) {
        toast('Wacht tot de detectie van dit document klaar is.');
        return false;
      }
      openSplitReview(g, undefined, onDone);
      return true;
    },
    show: (d) => {
      cur = d as Doc;
      curPage = 0;
      selBox = null;
      renderAll();
    },
    changed: () => renderDocList(),
    downloadKey,
    toast: (m) => toast(m),
  }, start?.id);
}

// ───────────────────────── Instellingen ─────────────────────────

function openSettings() {
  const dlg = el('dialog');
  const draft: Settings = { ...S };
  const text = (k: keyof Settings, label: string, help?: string, area = false) => {
    const inp = (area ? el('textarea', {}) : el('input', { type: 'text' })) as HTMLInputElement | HTMLTextAreaElement;
    inp.value = String(draft[k]);
    inp.addEventListener('input', () => ((draft as unknown as Record<string, unknown>)[k] = inp.value));
    return el('div', { class: 'field' }, el('label', {}, label), inp, help ? el('div', { class: 'note' }, help) : null);
  };
  const num = (k: keyof Settings, label: string, attrs: Record<string, string> = {}, help?: string) => {
    const inp = el('input', { type: 'number', ...attrs }) as HTMLInputElement;
    inp.value = String(draft[k]);
    inp.addEventListener('input', () => ((draft as unknown as Record<string, unknown>)[k] = Number(inp.value)));
    return el('div', { class: 'field' }, el('label', {}, label), inp, help ? el('div', { class: 'note' }, help) : null);
  };
  const check = (k: keyof Settings, label: string, help?: string) => {
    const inp = el('input', { type: 'checkbox', checked: Boolean(draft[k]) }) as HTMLInputElement;
    inp.addEventListener('change', () => ((draft as unknown as Record<string, unknown>)[k] = inp.checked));
    return el('label', { class: 'check' }, inp, el('span', {}, label, help ? el('div', { class: 'note' }, help) : null));
  };
  const select = (k: keyof Settings, label: string, opts: [string, string][]) => {
    const s = el('select', {}, ...opts.map(([v, l]) => el('option', { value: v, selected: String(draft[k]) === v }, l))) as HTMLSelectElement;
    s.addEventListener('change', () => {
      const v = s.value;
      (draft as unknown as Record<string, unknown>)[k] = /^\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    });
    return el('div', { class: 'field' }, el('label', {}, label), s);
  };
  const color = el('input', { type: 'color', value: draft.textColor }) as HTMLInputElement;
  const namesArea = el('textarea', { placeholder: 'Bijv. een klassenlijst, één naam per regel', rows: '4' }) as HTMLTextAreaElement;
  namesArea.value = extraNames;
  const namesField = el(
    'div',
    { class: 'field' },
    el('label', {}, 'Extra namen om overal te zoeken'),
    namesArea,
    el('div', { class: 'note' }, 'Wordt NIET opgeslagen: na sluiten van het tabblad is de lijst weg. Woorden van minstens 4 letters worden gezocht.'),
  );
  color.addEventListener('input', () => (draft.textColor = color.value));

  const save = () => {
    const oldKw = [S.kwNaam, S.kwNummer, S.kwKlas, S.kwStop, S.detectKlas, S.detectNummer, S.searchRotated, S.padding, S.ocrDpi].join('|');
    const namesChanged = extraNames !== namesArea.value;
    extraNames = namesArea.value;
    Object.assign(S, draft);
    if (S.numMax < S.numMin) [S.numMin, S.numMax] = [S.numMax, S.numMin];
    saveSettings();
    setWorkerCount(S.ocrWorkers);
    dlg.close();
    renderAll();
    const newKw = [S.kwNaam, S.kwNummer, S.kwKlas, S.kwStop, S.detectKlas, S.detectNummer, S.searchRotated, S.padding, S.ocrDpi].join('|');
    if ((oldKw !== newKw || namesChanged) && docs.length) toast('Detectie-instellingen gewijzigd. Kies ☰ Menu → "Alles opnieuw detecteren" om ze toe te passen.');
  };

  dlg.append(
    el('div', { class: 'dhead' }, el('h2', {}, '⚙ Instellingen'), el('button', { class: 'btn icon', onclick: () => dlg.close() }, '✕')),
    el(
      'div',
      { class: 'dbody' },
      el(
        'fieldset',
        {},
        el('legend', {}, 'Vervangende tekst'),
        text('template', 'Tekst', '{n} = nummer, {nn}/{nnn} = met voorloopnullen. Voorbeeld: "Kandidaat {n}".'),
        el('div', { class: 'grid2' }, num('numMin', 'Nummer vanaf', { min: '0' }), num('numMax', 'Nummer tot en met', { min: '0' })),
        el('div', { class: 'note', style: 'margin-bottom:10px' }, 'Nummers worden willekeurig en uniek gekozen (niet op volgorde), zodat ze niet herleidbaar zijn tot de alfabetische volgorde. Is het bereik vol, dan wordt het automatisch groter.'),
        el('div', { class: 'grid2' },
          select('fill', 'Kleur van het weggehaalde vak', [['wit', 'Wit (onopvallend)'], ['zwart', 'Zwart (duidelijk zichtbaar)']]),
          el('div', { class: 'field' }, el('label', {}, 'Tekstkleur'), color),
        ),
        check('stampEveryPage', 'Tekst ook in een hoek van elke pagina zetten', 'Handig als er pagina\'s zonder naamvak zijn, zodat je weet bij wie ze horen.'),
        select('stampPosition', 'Positie hoekstempel', [['rechtsboven', 'Rechtsboven'], ['linksboven', 'Linksboven'], ['rechtsonder', 'Rechtsonder'], ['linksonder', 'Linksonder']]),
      ),
      el(
        'fieldset',
        {},
        el('legend', {}, 'Automatische detectie'),
        check('autoDetect', 'Automatisch detecteren na het toevoegen van bestanden'),
        check('detectNummer', 'Examen-/leerlingnummer verwijderen'),
        check('detectKlas', 'Klas verwijderen'),
        check('searchFileNames', 'Ook zoeken naar de naam uit de bestandsnaam, overal op de pagina', 'Heet het bestand bijv. "jansen piet.pdf", dan worden de woorden "jansen" en "piet" overal op de pagina gezocht (werkt het best bij duidelijk schrift).'),
        namesField,
        check('autoSplit', 'Scan van een hele klas automatisch per leerling opdelen', 'Staat het naamvak op een vast ritme (bijv. op elke 2e pagina), dan krijgt elke leerling een eigen document en kandidaatnummer.'),
        check('searchRotated', 'Ook zoeken in gedraaide pagina\'s (90°/180°/270°)', 'Alleen als er rechtop niets gevonden wordt. Kost wat extra tijd.'),
        text('kwNaam', 'Labels voor naam', 'Gescheiden door komma\'s. Hoofdletters en kleine OCR-fouten maken niet uit.', true),
        text('kwNummer', 'Labels voor nummer', undefined, true),
        text('kwKlas', 'Labels voor klas', undefined, true),
        text('kwStop', 'Andere labels (begrenzen een vak, worden niet verwijderd)', 'Bijv. "Examenvak", "Datum": het naamvak stopt vóór zo\'n label.', true),
        el('div', { class: 'grid2' },
          num('padding', 'Extra marge rond vakken (× tekstregelhoogte)', { min: '0', max: '3', step: '0.1' }),
          select('ocrDpi', 'Resolutie voor tekstherkenning', [['150', '150 dpi (sneller)'], ['200', '200 dpi (aanbevolen)'], ['300', '300 dpi (nauwkeuriger, traag)']]),
        ),
        num('ocrWorkers', 'Aantal gelijktijdige OCR-processen (0 = automatisch)', { min: '0', max: '8' }, `Automatisch = ${defaultWorkerCount()} op deze computer.`),
      ),
      el(
        'fieldset',
        {},
        el('legend', {}, 'Uitvoer'),
        el('div', { class: 'grid2' },
          select('exportDpi', 'Resolutie', [['100', '100 dpi (klein)'], ['150', '150 dpi'], ['200', '200 dpi (aanbevolen)'], ['300', '300 dpi (groot)']]),
          select('jpegQuality', 'Beeldkwaliteit', [['0', 'Automatisch (grootte zoals origineel)'], ['0.6', 'Laag (klein bestand)'], ['0.75', 'Gemiddeld'], ['0.85', 'Hoog'], ['0.95', 'Zeer hoog']]),
        ),
        check('grayscale', 'Grijswaarden (kleinere bestanden)'),
        text('fileNameTemplate', 'Bestandsnaam', '{tekst} = vervangende tekst, {n} = nummer. ".pdf" wordt automatisch toegevoegd.'),
        check('keyCsv', 'Sleutelbestand (CSV) aanbieden', 'Koppelt kandidaatnummer aan originele bestandsnaam. Blijft op je computer.'),
        check('combined', 'Na export ook direct één samengevoegde PDF downloaden'),
      ),
      el(
        'fieldset',
        {},
        el('legend', {}, 'Weergave'),
        check('showLabels', 'Labels boven vakken tonen in de editor'),
      ),
    ),
    el(
      'div',
      { class: 'dfoot' },
      el('button', { class: 'btn', onclick: () => { if (confirm('Alle instellingen terugzetten naar standaard?')) { Object.assign(draft, DEFAULT_SETTINGS); Object.assign(S, DEFAULT_SETTINGS); saveSettings(); dlg.close(); renderAll(); } } }, 'Standaardwaarden'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn', onclick: () => dlg.close() }, 'Annuleren'),
      el('button', { class: 'btn primary', onclick: save }, 'Opslaan'),
    ),
  );
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

// ───────────────────────── Help ─────────────────────────

function openHelp(section?: string) {
  const dlg = el('dialog');
  dlg.append(
    el('div', { class: 'dhead' }, el('h2', {}, 'Hoe werkt NamenWeg?'), el('button', { class: 'btn icon', onclick: () => dlg.close() }, '✕')),
    el(
      'div',
      { class: 'dbody help' },
      el('h3', { id: 'help-privacy' }, '🔒 Privacy: alles blijft op je computer'),
      el('ul', {},
        el('li', {}, 'De app is een statische webpagina. PDF\'s worden alleen in het geheugen van je browser geopend en nergens naartoe gestuurd.'),
        el('li', {}, 'Ook de tekstherkenning (Tesseract OCR) draait lokaal in je browser; de herkenningsmodellen worden van deze website zelf geladen, niet van een externe dienst.'),
        el('li', {}, 'Een Content-Security-Policy verbiedt de browser technisch om verbinding te maken met andere servers.'),
        el('li', {}, 'Bij het eerste bezoek worden alle onderdelen (ca. 30 MB, eenmalig) op de achtergrond opgeslagen, ook de tekstherkenning. Staat rechtsonder "✓ werkt offline", dan werkt de app volledig zonder internet. Test het gerust: zet je wifi uit en gebruik de app.'),
        el('li', {}, 'In de browser worden alleen bewaard: je instellingen, je sjablonen (alleen posities van vakken) en de OCR-taalmodellen (openbare data, voor offline gebruik). Nooit bestanden, scans of namen. Sluit je het tabblad, dan zijn alle geopende documenten weg.'),
      ),
      el('h3', {}, '✂ Echt verwijderen, niet alleen afdekken'),
      el('p', {}, 'Een zwart vlak óp een PDF leggen is onveilig: de oorspronkelijke scan zit er dan nog onder en kan eruit gehaald worden. NamenWeg bouwt daarom elke pagina opnieuw op: de pagina wordt naar pixels omgezet, de pixels van het naamvak worden overschreven, en alleen díé nieuwe afbeelding komt in een gloednieuwe PDF. Er gaan geen originele beeldlagen, tekstlagen, metadata (zoals auteur, scanner of bestandsnaam) mee.'),
      el('p', {}, 'Na de export controleert de app elk bestand automatisch: geen tekstlaag, één afbeelding per pagina, en geen namen of de oorspronkelijke bestandsnaam in de metadata.'),
      el('h3', {}, '🔍 Automatische detectie'),
      el('p', {}, 'De app leest de voorgedrukte tekst op elke pagina en zoekt labels zoals "Naam kandidaat", "Examen no.", "Leerlingnummer" en "Klas". Vanaf het label groeit het vak mee met het handschrift en eventuele invulhokjes. Staat er rechtop niets, dan wordt de pagina gedraaid bekeken (handig voor liggende uitwerkbijlagen).'),
      el('p', {}, `Mist de tekstherkenning een label op één pagina (bijv. "Examen no."), dan vult de app het vak aan op basis van dezelfde kop op andere pagina's. Zulke vakken zijn gemarkeerd als "afgeleid". Ook wordt de naam uit de bestandsnaam (bijv. "jansen piet.pdf") overal op de pagina gezocht.`),
      el('p', {}, 'Handgeschreven namen zónder voorgedrukt label kunnen niet altijd automatisch gevonden worden. Controleer daarom altijd het resultaat met het 🔎 Controle-overzicht of de knop "Voorbeeld".'),
      el('h3', {}, '✏ Handmatig aanpassen'),
      el('ul', {},
        el('li', {}, 'Sleep op een lege plek om een nieuw vak te tekenen.'),
        el('li', {}, 'Sleep een vak om het te verplaatsen; gebruik de hoekjes om het groter of kleiner te maken.'),
        el('li', {}, 'Dubbelklik op een vak om daar de vervangende tekst ("Kandidaat 67") te plaatsen.'),
        el('li', {}, 'Houd Shift ingedrukt tijdens het slepen voor een strook over de volle breedte; verschuif een geselecteerd vak met de pijltjestoetsen.'),
        el('li', {}, 'Scheef of ondersteboven gescand? Draai de pagina via ⋯ boven de pagina (of toets R); de vakken draaien mee.'),
        el('li', {}, 'Staat het naamvak bij iedereen op dezelfde plek? Teken het één keer en gebruik "Vakken kopiëren".'),
        el('li', {}, 'Gebruik je vaker hetzelfde antwoordblad? Sla de vakken op als 📐 sjabloon.'),
      ),
      el('h3', {}, '🧑‍🎓 Namenlijst'),
      el('p', {}, 'In ☰ Menu → Instellingen kun je een lijst met namen plakken (bijv. de hele klas). Die namen worden op elke pagina gezocht, ook buiten de naamvakken. De lijst wordt niet opgeslagen.'),
      el('h3', {}, '👥 Leerlingen koppelen'),
      el('p', {}, 'Wil je weten welke toets van welke leerling is, zonder dat de namen in de geanonimiseerde toetsen komen? Kies "👥 Leerlingen koppelen" en laad de leerlinglijst (CSV of Excel .xlsx, bijv. een export uit de leerlingadministratie). Je ziet dan per toets de naamvakken uit de scan; typ een paar letters van de voor- of achternaam (of initialen, of het leerlingnummer) en druk op Enter. Passen er meer namen, kies dan met 1, 2 of 3. De app springt vanzelf naar de volgende toets.'),
      el('ul', {},
        el('li', {}, 'Kies je een leerling die al een toets heeft, dan wordt het vak rood en zie je de andere toets ernaast om het handschrift te vergelijken. Hoort het bij elkaar (bijv. een apart gescande uitwerkbijlage), voeg ze dan samen. Horen er twee leerlingen in één toets, pas dan de splitsing aan.'),
        el('li', {}, 'Leerlingen met meer dan één toets blijven rood tot het klopt; het Overzicht (Ctrl+O) toont ook wie nog geen toets heeft.'),
        el('li', {}, 'Staat iemand niet op de lijst? Typ de naam en druk Shift+Enter om de leerling toe te voegen, of Ctrl+Enter voor "niet in lijst / onleesbaar".'),
        el('li', {}, 'De kandidaatnummers blijven willekeurig. Wie wie is, staat alleen in het sleutelbestand (met leerlingnummer en klas, en de leerlingen zonder toets). De lijst wordt niet opgeslagen; de namen worden wel gebruikt om de export te controleren.'),
      ),
      el('h3', {}, '✏️ Snel wissen'),
      el('p', {}, 'Toch nog iets gemist in een geëxporteerde PDF? Kies ☰ Menu → "Snel wissen in een PDF" (of open de app met ?snelwissen achter het adres). Open de PDF, trek met de muis een vak over wat weg moet (Shift = strook over de volle breedte) en sla op. Er is geen tekstherkenning en er wordt niets gesplitst. Elke kandidaat staat op een eigen rij, dankzij de bladwijzers die NamenWeg in elke export zet (ook in de samengevoegde PDF). Alleen pagina\'s met een nieuw vak worden opnieuw opgebouwd; de rest gaat ongewijzigd mee.'),
      el('h3', {}, '🗝 Sleutelbestand'),
      el('p', {}, 'Wil je later terugvinden wie "Kandidaat 67" was, download dan het sleutelbestand (CSV). Daarin staat welk nummer bij welk origineel bestand hoort. Bewaar dit bestand apart en veilig.'),
      el('h3', {}, '💡 Tips'),
      el('ul', {},
        el('li', {}, 'Verwerk een hele klas tegelijk: sleep alle PDF\'s in één keer naar het venster.'),
        el('li', {}, `Hele stapel in één PDF gescand? Staan de naamvakken op een vast ritme (bijv. elke 2e pagina) en zijn dat steeds hetzelfde voorblad, dan deelt de app de scan na de detectie automatisch per leerling op, met voor elke leerling een eigen nummer. Heeft niet elke leerling evenveel pagina's, of twijfelt de app, dan opent het (schermvullende) venster "Splitsresultaat": één rij per kandidaat. Elke kandidaat heeft een eigen kleur. Bovenaan kies je wat je ziet: "Vakken" (de vakken die weggehaald worden), "Zoals de uitvoer" (precies het exportresultaat) of "Origineel"; een kandidaat zonder naamvak krijgt een rode waarschuwing. Klik op een pagina om op die kandidaat in te zoomen (de kandidaat erboven en eronder blijft zichtbaar; ↑ ↓ naar een andere kandidaat, ← → bladeren, Esc uitzoomen). Sleep een pagina naar een andere kandidaat, klik op ✂ tussen twee pagina's om te splitsen of op "Samenvoegen met vorige". Met de schuifregelaar maak je de pagina's groter. Later bekijken of aanpassen: klik in de documentenlijst op het blauwe label "✂ 1 van 3 uit …", of op "✂ Splitsing bekijken" bij het document. Wil je toch één PDF? Kies na het exporteren "Eén samengevoegde PDF".`),
        el('li', {}, 'Ook losse scans als JPG of PNG worden ondersteund.'),
        el('li', {}, 'Bestanden te groot? Kies in ☰ Menu → Instellingen een lagere resolutie of grijswaarden.'),
      ),
    ),
    el('div', { class: 'dfoot' }, el('button', { class: 'btn primary', onclick: () => dlg.close() }, 'Sluiten')),
  );
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  if (section) dlg.querySelector(`#help-${section}`)?.scrollIntoView();
}

// ───────────────────────── Thema & toetsen ─────────────────────────

const TKEY = 'namenweg.theme';
function applyTheme() {
  let t = 'auto';
  try {
    t = localStorage.getItem(TKEY) || 'auto';
  } catch {
    /* */
  }
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  themeBtn.textContent = `${t === 'dark' ? '🌙' : t === 'light' ? '☀' : '🌓'} Thema: ${t === 'auto' ? 'automatisch' : t === 'dark' ? 'donker' : 'licht'}`;
}
function cycleTheme() {
  let t = 'auto';
  try {
    t = localStorage.getItem(TKEY) || 'auto';
    localStorage.setItem(TKEY, t === 'auto' ? 'light' : t === 'light' ? 'dark' : 'auto');
  } catch {
    /* */
  }
  applyTheme();
}
applyTheme();

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('input, textarea, select, dialog')) return;
  const p = page();
  const openMenu = document.querySelector<HTMLDetailsElement>('details.menu[open]');
  if (e.key === 'Escape' && openMenu) {
    openMenu.open = false;
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo(e.shiftKey);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    undo(true);
  } else if (e.ctrlKey || e.metaKey || e.altKey) return;
  else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
  else if (e.key.startsWith('Arrow') && selBox && p) {
    // Geselecteerd vak verschuiven (Shift = grotere stap)
    const b = p.boxes.find((x) => x.id === selBox);
    if (!b) return;
    e.preventDefault();
    snapshot();
    const step = e.shiftKey ? 0.01 : 0.002;
    if (e.key === 'ArrowLeft') b.x = Math.max(0, b.x - step);
    if (e.key === 'ArrowRight') b.x = Math.min(1 - b.w, b.x + step);
    if (e.key === 'ArrowUp') b.y = Math.max(0, b.y - step);
    if (e.key === 'ArrowDown') b.y = Math.min(1 - b.h, b.y + step);
    markDirty();
    renderOverlay();
    refreshPreview();
  } else if (e.key === 'ArrowRight') gotoPage(curPage + 1);
  else if (e.key === 'ArrowLeft') gotoPage(curPage - 1);
  else if (e.key === 'PageDown' || e.key === 'PageUp') {
    if (!cur) return;
    const i = docs.indexOf(cur) + (e.key === 'PageDown' ? 1 : -1);
    if (docs[i]) {
      cur = docs[i];
      curPage = 0;
      selBox = null;
      renderAll();
    }
    e.preventDefault();
  } else if (e.key === 'p' || e.key === 'P') togglePreview();
  else if (e.key === 'z' || e.key === 'Z') zoomToBoxes();
  else if (e.key === 'r' || e.key === 'R') rotatePage(e.shiftKey ? -1 : 1);
  else if ((e.key === 'd' || e.key === 'D') && cur && p) enqueue(cur, [p]);
  else if ((e.key === 't' || e.key === 'T') && p && selBox) {
    const b = p.boxes.find((x) => x.id === selBox);
    if (b) {
      snapshot();
      setTextBox(p, b, !b.text);
    }
  } else if (e.key === '+' || e.key === '=') setZoom(1);
  else if (e.key === '-') setZoom(-1);
  else if (e.key === '0') setZoom(0);
  else if (e.key === 'Escape' && selBox) {
    selBox = null;
    renderOverlay();
    renderInspector();
  }
});

let resizeTimer = 0;
new ResizeObserver(() => {
  if (zoom !== 'fit') return;
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => renderEditor(), 120);
}).observe(editor);

renderAll();

// Offline gebruik mogelijk maken (alleen in productie)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  if (new URLSearchParams(location.search).has('nosw')) {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
  } else {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    // "✓ werkt offline" tonen zodra de service worker alles heeft opgeslagen.
    const check = async (tries: number) => {
      try {
        if (await caches.match('./__offline-ready')) return void (offlineBadge.hidden = false);
      } catch {
        /* geen cache-toegang (privévenster): dan geen melding */
      }
      if (tries > 0) setTimeout(() => check(tries - 1), 5000);
    };
    check(240);
  }
}

// ?snelwissen (of #snelwissen): meteen het venster "Snel wissen" openen.
if (/[?&#]snelwissen\b/.test(location.search + location.hash)) quickFix();

// Alleen tijdens ontwikkeling: ?demo=bestand1.pdf,bestand2.pdf laadt bestanden uit de lokale map scans/.
if (import.meta.env.DEV) {
  const qs = new URLSearchParams(location.search);
  const demo = qs.get('demo');
  if (qs.get('auto') === '0') S.autoDetect = false;
  if (demo === 'wisselend') {
    // hele klas in één PDF met 2, 3, 1 en 2 pagina's per leerling: splitsvenster moet opengaan
    import('./demo').then(async ({ makeClassDemoFile }) => addFiles([await makeClassDemoFile(true)]));
  } else if (demo === 'klas' || demo === 'bladen' || demo === 'beide') {
    // klas = hele klas in één PDF (moet splitsen); bladen = één leerling, naam op elk blad (niet splitsen)
    import('./demo').then(async ({ makeClassDemoFile, makeMultiSheetDemoFile }) =>
      addFiles([...(demo !== 'bladen' ? [await makeClassDemoFile()] : []), ...(demo !== 'klas' ? [await makeMultiSheetDemoFile()] : [])]),
    );
  } else if (demo) {
    Promise.all(
      demo.split(',').map(async (n) => {
        const r = await fetch(`/scans/${encodeURIComponent(n)}`);
        return new File([await r.blob()], n, { type: 'application/pdf' });
      }),
    ).then(addFiles);
  }
  (window as unknown as Record<string, unknown>).__nw = {
    docs,
    S,
    match: startMatcher,
    get cur() {
      return cur;
    },
    show(di: number, pi: number, z: number | 'fit' = 'fit', prev = false) {
      cur = docs[di];
      curPage = pi;
      zoom = z;
      preview = prev;
      selBox = null;
      renderAll();
    },
  };
}
