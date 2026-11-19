import './styles.css';
import { zipSync } from 'fflate';
import { DEFAULT_SETTINGS, type Box, type BoxKind, type PageState, type Rot, type Settings } from './types';
import { openFile, isSupported, release, withRotation, type Source } from './pdfio';
import { detectPage, norm } from './detect';
import { completeFromPeers, InkMask, nameTokensFromFileName, refineWithInk } from './detect-core';
import { setWorkerCount, defaultWorkerCount, onOcrStatus } from './ocr';
import { applyRedactions, exportDocument, verifyOutput, combineDocuments, type VerifyResult } from './redact';
import { el, uid, uniqueNumber, fillTemplate, safeFileName, download, toCsv, fmtBytes } from './util';

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
const toolbar = el('div', { class: 'toolbar' });
const editor = el('div', { class: 'editor', tabindex: '0' });
const strip = el('div', { class: 'strip' });
const inspector = el('aside', { class: 'right' });
const statusMsg = el('span', {}, 'Klaar. Voeg PDF-bestanden toe om te beginnen.');
const progressBar = el('div');
const progress = el('div', { class: 'progress', hidden: true }, progressBar);
const btnStop = el('button', { class: 'btn small', hidden: true, onclick: () => stopDetect(), title: 'Automatische detectie stoppen' }, '⏹ Stop');
const themeBtn = el('button', { class: 'btn icon', title: 'Licht/donker thema', onclick: cycleTheme });

const btnDetectAll = el('button', { class: 'btn', onclick: () => detectAll(true) }, '🔍 Detecteer alles opnieuw');
const btnExportAll = el('button', { class: 'btn primary', onclick: () => exportAll() }, '⬇ Exporteer alles');
const btnKey = el('button', { class: 'btn', onclick: downloadKey, title: 'Sleutelbestand: welke kandidaat is wie (blijft op je computer)' }, '🗝 Sleutel (CSV)');
const btnRenumber = el('button', { class: 'btn', onclick: renumberAll, title: 'Geef alle documenten nieuwe willekeurige nummers' }, '🎲 Nieuwe nummers');
const btnOverview = el('button', { class: 'btn', onclick: () => openOverview(), title: "Alle pagina's in één overzicht controleren" }, '🔎 Controle-overzicht');
const btnTemplates = el('button', { class: 'btn', onclick: () => openTemplates(), title: 'Vaklayout opslaan of toepassen' }, '📐 Sjablonen');
const btnClear = el('button', { class: 'btn danger', onclick: clearAll }, '🗑 Alles wissen');

app.append(
  el(
    'header',
    { class: 'top' },
    el('div', { class: 'brand' }, el('img', { src: './favicon.svg', alt: '' }), 'NamenWeg', el('small', {}, 'toetsen anonimiseren')),
    el('button', { class: 'privacy', onclick: () => openHelp('privacy'), title: 'Hoe wordt mijn privacy beschermd?' }, '🔒 100% lokaal – er wordt niets geüpload'),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn', onclick: openSettings }, '⚙ Instellingen'),
    el('button', { class: 'btn', onclick: () => openHelp() }, '❓ Help'),
    themeBtn,
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
      docList,
      el(
        'div',
        { class: 'actions' },
        btnExportAll,
        el('div', { class: 'row' }, btnOverview, btnTemplates),
        el('div', { class: 'row' }, btnDetectAll),
        el('div', { class: 'row' }, btnKey, btnRenumber),
        btnClear,
      ),
    ),
    el('section', { class: 'center' }, toolbar, editor, strip),
    inspector,
  ),
  el('footer', { class: 'status' }, statusMsg, el('div', { class: 'spacer' }), btnStop, progress),
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
  if (docs.some((d) => !d.exported)) {
    e.preventDefault();
  }
});

// ───────────────────────── Status ─────────────────────────

function setStatus(msg: string) {
  statusMsg.textContent = msg;
}
function setProgress(done: number, total: number) {
  progress.hidden = total === 0 || done >= total;
  progressBar.style.width = total ? `${(100 * done) / total}%` : '0';
}
onOcrStatus((m) => m && setStatus(m));

let toastTimer = 0;
function toast(msg: string) {
  document.querySelector('.toast')?.remove();
  const t = el('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.remove(), 3500);
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
  let i = 0;
  for (const d of added) {
    setStatus(`Inlezen: ${++i}/${added.length}…`);
    setProgress(i - 1, added.length);
    try {
      d.src = withRotation(await openFile(d.file), (i) => d.pages[i]?.userRot ?? 0);
      d.pages = d.src.sizes.map((s, index) => ({ index, wPt: s.w, hPt: s.h, boxes: [], detect: 'nog niet' }));
      d.status = 'klaar';
    } catch (e) {
      d.status = 'fout';
      d.error = e instanceof Error ? e.message : String(e);
    }
    renderDocList();
    if (d === cur) renderAll();
    makeThumbs(d);
  }
  setProgress(0, 0);
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
  d.src?.destroy();
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
  for (const d of [...docs]) d.src?.destroy();
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
  btnStop.hidden = true;
  renderDocList();
  renderStrip();
  renderInspector();
}

function pumpDetect() {
  btnStop.hidden = !(detectQueue.length || detectRunning);
  const max = S.ocrWorkers > 0 ? S.ocrWorkers : defaultWorkerCount();
  while (detectRunning < max && detectQueue.length) {
    const job = detectQueue.shift()!;
    detectRunning++;
    runDetect(job.doc, job.page, job.phase).finally(() => {
      detectRunning--;
      detectDone++;
      const mainLeft = detectQueue.some((j) => j.phase === 'rechtop');
      if (!detectQueue.length && !detectRunning) {
        btnStop.hidden = true;
        const n = detectDone;
        detectDone = detectTotal = 0;
        setProgress(0, 0);
        completeMissing().then((added) => {
          setStatus(
            `Detectie klaar: ${n} controle(s) uitgevoerd${added ? `, ${added} vak(ken) aangevuld op basis van andere pagina's` : ''}. Controleer de vakken en exporteer.`,
          );
          checkWarnings();
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
    try {
      const canvas = await doc.src.render(p.index, S.ocrDpi);
      const res = await detectPage(canvas, S, nameTokensFromFileName(doc.name, S), [90, 270, 180]);
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
  p.detectNote = 'Bezig met tekstherkenning…';
  if (doc === cur && p.index === curPage) renderInspector();
  try {
    const canvas = await doc.src.render(p.index, S.ocrDpi);
    const res = await detectPage(canvas, S, nameTokensFromFileName(doc.name, S), [0]);
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
  } catch (e) {
    p.detect = 'fout';
    p.detectNote = 'Fout bij detectie: ' + (e instanceof Error ? e.message : String(e));
    console.error(e);
  } finally {
    runningMain--;
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

function checkWarnings() {
  const missing = docs.filter((d) => d.status === 'klaar' && !d.pages.some((p) => p.boxes.some((b) => b.kind === 'naam' || b.text)));
  if (missing.length) toast(`Let op: bij ${missing.length} document(en) is geen naamvak gevonden. Teken dat handmatig.`);
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
  docList.replaceChildren(
    ...(docs.length
      ? docs.map((d) =>
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
            el('div', { class: 'row' }, el('span', { class: 'orig', title: d.name }, '📄 ' + d.name)),
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
        el('span', { class: 'tag' }, `${KIND_LABEL[b.kind]}${b.text ? ' · tekst' : ''}${b.source === 'auto' ? ' · auto' : ''}`),
      );
      positionBox(e, b);
      if (b.id === selBox) for (const h of ['nw', 'ne', 'sw', 'se']) e.append(el('div', { class: `handle ${h}`, 'data-h': h }));
      return e;
    }),
  );
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
      positionBox(draft, { x: Math.min(start.x, q.x), y: Math.min(start.y, q.y), w: Math.abs(dx), h: Math.abs(dy) } as Box);
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
      const r = { x: Math.min(start.x, q.x), y: Math.min(start.y, q.y), w: Math.abs(q.x - start.x), h: Math.abs(q.y - start.y) };
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
      el('button', { class: 'btn primary', onclick: () => fileInput.click() }, 'Bestanden kiezen'),
    ),
  );
}

// ───────────────────────── Toolbar / strip / inspector ─────────────────────────

function renderToolbar() {
  const p = page();
  const has = !!(cur && p);
  const n = cur?.pages.length ?? 0;
  const tb = (label: string, title: string, fn: () => void, opts: { disabled?: boolean; active?: boolean } = {}) =>
    el('button', { class: 'btn small' + (opts.active ? ' active' : ''), title, onclick: fn, disabled: opts.disabled ?? !has }, label);
  toolbar.replaceChildren(
    tb('◀', 'Vorige pagina (←)', () => gotoPage(curPage - 1), { disabled: !has || curPage === 0 }),
    el('span', { class: 'info' }, has ? `Pagina ${curPage + 1} / ${n}` : '–'),
    tb('▶', 'Volgende pagina (→)', () => gotoPage(curPage + 1), { disabled: !has || curPage >= n - 1 }),
    el('span', { class: 'sep' }),
    tb('−', 'Uitzoomen (-)', () => setZoom(-1)),
    tb('Passend', 'Passend maken (0)', () => setZoom(0), { active: zoom === 'fit' }),
    tb('+', 'Inzoomen (+)', () => setZoom(1)),
    tb('🎯 Naar vakken', 'Inzoomen op de vakken van deze pagina (Z)', zoomToBoxes, { disabled: !has || !p?.boxes.length }),
    el('span', { class: 'sep' }),
    tb(preview ? '👁 Voorbeeld aan' : '👁 Voorbeeld', 'Toon hoe de uitvoer eruit ziet (P)', togglePreview, { active: preview }),
    tb('🔍 Detecteer', 'Deze pagina opnieuw automatisch detecteren (D)', () => cur && p && enqueue(cur, [p])),
    tb('⟲', 'Pagina linksom draaien (Shift+R)', () => rotatePage(-1)),
    tb('⟳', 'Pagina rechtsom draaien (R)', () => rotatePage(1)),
    tb('🗑', 'Geselecteerd vak verwijderen (Delete)', deleteSelected, { disabled: !selBox }),
    tb('↶', 'Ongedaan maken (Ctrl+Z)', () => undo(), { disabled: !undoStack.length }),
    tb('↷', 'Opnieuw (Ctrl+Y)', () => undo(true), { disabled: !redoStack.length }),
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
      el('h3', {}, 'Dit document'),
      el('div', { class: 'field' }, el('label', {}, 'Kandidaatnummer'), numInput, numNote),
      el('div', { class: 'note' }, 'Vervangende tekst: ', el('strong', {}, docText(d))),
      el('div', { class: 'row', style: 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap' },
        el('button', { class: 'btn small', onclick: () => { d.num = uniqueNumber(S.numMin, S.numMax, usedNumbers(d)); d.exported = false; renderDocList(); renderInspector(); refreshPreview(); } }, '🎲 Ander nummer'),
        el('button', { class: 'btn small', onclick: () => exportAll([d]) }, '⬇ Alleen dit document'),
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
        el('div', { style: 'display:grid;gap:6px;margin-top:10px' },
          el('button', { class: 'btn small', onclick: () => enqueue(d, [p]), disabled: p.detect === 'bezig' }, '🔍 Deze pagina detecteren'),
          el('button', { class: 'btn small', onclick: () => clearPageBoxes(false), disabled: !p.boxes.length }, 'Vakken op deze pagina wissen'),
          el(
            'button',
            {
              class: 'btn small' + (p.checked ? ' active' : ''),
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
        ),
      ),
      el(
        'div',
        { class: 'section' },
        el('h3', {}, 'Vakken kopiëren'),
        el('p', { class: 'note', style: 'margin-top:0' }, 'Zelfde formulier op elke pagina of bij elke leerling? Kopieer de vakken van deze pagina.'),
        el('div', { style: 'display:grid;gap:6px' },
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
      'div',
      { class: 'section' },
      el('h3', {}, 'Sneltoetsen'),
      el('dl', { class: 'kv' },
        el('dt', {}, el('kbd', {}, '←'), ' ', el('kbd', {}, '→')), el('dd', {}, 'Pagina'),
        el('dt', {}, el('kbd', {}, 'PgUp'), ' ', el('kbd', {}, 'PgDn')), el('dd', {}, 'Document'),
        el('dt', {}, el('kbd', {}, 'Del')), el('dd', {}, 'Vak wissen'),
        el('dt', {}, el('kbd', {}, 'P')), el('dd', {}, 'Voorbeeld'),
        el('dt', {}, el('kbd', {}, 'Z')), el('dd', {}, 'Naar vakken zoomen'),
        el('dt', {}, el('kbd', {}, 'R')), el('dd', {}, 'Pagina draaien'),
        el('dt', {}, el('kbd', {}, 'D')), el('dd', {}, 'Detecteer pagina'),
        el('dt', {}, el('kbd', {}, 'T')), el('dd', {}, 'Tekst in vak aan/uit'),
        el('dt', {}, el('kbd', {}, 'Ctrl+Z')), el('dd', {}, 'Ongedaan maken'),
      ),
    ),
  );
  inspector.replaceChildren(...sections);
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
    .filter((t) => t.length >= 4 && !/^\d+$/.test(t) && !['scan', 'toets', 'kandidaat'].includes(t));
}

async function exportAll(list?: Doc[]) {
  const todo = (list ?? docs).filter((d) => d.status === 'klaar' && d.src);
  if (!todo.length) return;
  const busy = docs.some((d) => d.pages.some((p) => p.detect === 'bezig')) || detectQueue.length > 0 || detectRunning > 0;
  if (busy && !confirm('De detectie is nog bezig. Toch nu exporteren?')) return;
  const noName = todo.filter((d) => !d.pages.some((p) => p.boxes.length));
  if (noName.length && !confirm(`${noName.length} document(en) hebben geen enkel vak. Die worden zonder wijzigingen (maar wel als nieuwe afbeelding) geëxporteerd. Doorgaan?`)) return;

  const results: ExportResult[] = [];
  const taken = new Set<string>();
  const totalPages = todo.reduce((a, d) => a + d.pages.length, 0);
  let done = 0;
  for (const d of todo) {
    setStatus(`Exporteren: ${docText(d)}…`);
    try {
      const bytes = await exportDocument(d.src!, d.pages, docText(d), S, () => setProgress(++done, totalPages), d.file.size / Math.max(1, d.pages.length));
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
    const bytes = await combineDocuments(sorted.map((r) => r.bytes));
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
            ` (${fmtBytes(r.bytes.length)}) `,
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
  const rows: (string | number)[][] = [['Kandidaat', 'Nummer', 'Origineel bestand', 'Geëxporteerd bestand', "Pagina's"]];
  for (const d of [...list].sort((a, b) => a.num - b.num)) rows.push([docText(d), d.num, d.name, names.get(d) ?? '', d.pages.length]);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  download(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }), `sleutel-namenweg-${stamp}.csv`);
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
  color.addEventListener('input', () => (draft.textColor = color.value));

  const save = () => {
    const oldKw = [S.kwNaam, S.kwNummer, S.kwKlas, S.kwStop, S.detectKlas, S.detectNummer, S.searchRotated, S.padding, S.ocrDpi].join('|');
    Object.assign(S, draft);
    if (S.numMax < S.numMin) [S.numMin, S.numMax] = [S.numMax, S.numMin];
    saveSettings();
    setWorkerCount(S.ocrWorkers);
    dlg.close();
    renderAll();
    const newKw = [S.kwNaam, S.kwNummer, S.kwKlas, S.kwStop, S.detectKlas, S.detectNummer, S.searchRotated, S.padding, S.ocrDpi].join('|');
    if (oldKw !== newKw && docs.length) toast('Detectie-instellingen gewijzigd. Klik "Detecteer alles opnieuw" om ze toe te passen.');
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
        el('li', {}, 'Na de eerste keer laden werkt de app ook offline. Test het gerust: zet je wifi uit en gebruik de app.'),
        el('li', {}, 'In de browser worden alleen bewaard: je instellingen, je sjablonen (alleen posities van vakken) en de OCR-taalmodellen (openbare data, voor offline gebruik). Nooit bestanden, scans of namen. Sluit je het tabblad, dan zijn alle geopende documenten weg.'),
      ),
      el('h3', {}, '✂ Echt verwijderen, niet alleen afdekken'),
      el('p', {}, 'Een zwart vlak óp een PDF leggen is onveilig: de oorspronkelijke scan zit er dan nog onder en kan eruit gehaald worden. NamenWeg bouwt daarom elke pagina opnieuw op: de pagina wordt naar pixels omgezet, de pixels van het naamvak worden overschreven, en alleen díé nieuwe afbeelding komt in een gloednieuwe PDF. Er gaan geen originele beeldlagen, tekstlagen, metadata (zoals auteur, scanner of bestandsnaam) mee.'),
      el('p', {}, 'Na de export controleert de app elk bestand automatisch: geen tekstlaag, één afbeelding per pagina, en de oorspronkelijke bestandsnaam komt nergens in het bestand voor.'),
      el('h3', {}, '🔍 Automatische detectie'),
      el('p', {}, 'De app leest de voorgedrukte tekst op elke pagina en zoekt labels zoals "Naam kandidaat", "Examen no.", "Leerlingnummer" en "Klas". Vanaf het label groeit het vak mee met het handschrift en eventuele invulhokjes. Staat er rechtop niets, dan wordt de pagina gedraaid bekeken (handig voor liggende uitwerkbijlagen).'),
      el('p', {}, `Mist de tekstherkenning een label op één pagina (bijv. "Examen no."), dan vult de app het vak aan op basis van dezelfde kop op andere pagina's. Zulke vakken zijn gemarkeerd als "afgeleid". Ook wordt de naam uit de bestandsnaam (bijv. "jansen piet.pdf") overal op de pagina gezocht.`),
      el('p', {}, 'Handgeschreven namen zónder voorgedrukt label kunnen niet altijd automatisch gevonden worden. Controleer daarom altijd het resultaat met het 🔎 Controle-overzicht of de knop "Voorbeeld".'),
      el('h3', {}, '✏ Handmatig aanpassen'),
      el('ul', {},
        el('li', {}, 'Sleep op een lege plek om een nieuw vak te tekenen.'),
        el('li', {}, 'Sleep een vak om het te verplaatsen; gebruik de hoekjes om het groter of kleiner te maken.'),
        el('li', {}, 'Dubbelklik op een vak om daar de vervangende tekst ("Kandidaat 67") te plaatsen.'),
        el('li', {}, 'Staat het naamvak bij iedereen op dezelfde plek? Teken het één keer en gebruik "Vakken kopiëren".'),
        el('li', {}, 'Gebruik je vaker hetzelfde antwoordblad? Sla de vakken op als 📐 sjabloon.'),
      ),
      el('h3', {}, '🗝 Sleutelbestand'),
      el('p', {}, 'Wil je later terugvinden wie "Kandidaat 67" was, download dan het sleutelbestand (CSV). Daarin staat welk nummer bij welk origineel bestand hoort. Bewaar dit bestand apart en veilig.'),
      el('h3', {}, '💡 Tips'),
      el('ul', {},
        el('li', {}, 'Verwerk een hele klas tegelijk: sleep alle PDF\'s in één keer naar het venster.'),
        el('li', {}, 'Ook losse scans als JPG of PNG worden ondersteund.'),
        el('li', {}, 'Bestanden te groot? Kies in Instellingen een lagere resolutie of grijswaarden.'),
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
  themeBtn.textContent = t === 'dark' ? '🌙' : t === 'light' ? '☀' : '🌓';
  themeBtn.title = `Thema: ${t === 'auto' ? 'automatisch' : t === 'dark' ? 'donker' : 'licht'}`;
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
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo(e.shiftKey);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    undo(true);
  } else if (e.ctrlKey || e.metaKey || e.altKey) return;
  else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
  else if (e.key === 'ArrowRight') gotoPage(curPage + 1);
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
  }
}

// Alleen tijdens ontwikkeling: ?demo=bestand1.pdf,bestand2.pdf laadt bestanden uit de lokale map scans/.
if (import.meta.env.DEV) {
  const qs = new URLSearchParams(location.search);
  const demo = qs.get('demo');
  if (qs.get('auto') === '0') S.autoDetect = false;
  if (demo) {
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
