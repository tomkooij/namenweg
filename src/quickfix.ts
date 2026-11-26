// Snel wissen: een (al geëxporteerde) PDF openen, met de muis een paar vakken over iets dat
// gemist is trekken, en opslaan. Geen tekstherkenning, geen splitsen. De weergave lijkt op het
// splitsvenster: één rij per kandidaat, volgens de bladwijzers die NamenWeg in de PDF zet.
import type { Rect, Settings } from './types';
import { openPdfBytes, pdfSource, readOutline, release, type Source } from './pdfio';
import { patchPdf, verifyOutput } from './redact';
import type { OutlineEntry } from './outline';
import { download, el, safeFileName } from './util';
import type { PDFDocumentProxy } from 'pdfjs-dist';

interface QfBox extends Rect {
  id: number;
}

const SIZE_KEY = 'namenweg.snelwissen.grootte';
const pref = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const savePref = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* */
  }
};

export function openQuickFix(S: Settings, toast: (msg: string) => void, file?: File) {
  const dlg = el('dialog', { class: 'sr full qf m-vakken' });
  const title = el('h2', {}, '✏️ Snel wissen');
  const body = el('div', { class: 'dbody' });
  const foot = el('div', { class: 'dfoot' });
  dlg.append(el('div', { class: 'dhead' }, title, el('button', { class: 'btn icon', onclick: () => tryClose(), title: 'Sluiten (Esc)', 'aria-label': 'Sluiten' }, '✕')), body, foot);
  dlg.style.setProperty('--sr-fill', S.fill === 'zwart' ? '#000' : '#fff');

  let pdf: PDFDocumentProxy | null = null;
  let src: Source | null = null;
  let bytes: Uint8Array | null = null;
  let name = '';
  let outline: OutlineEntry[] = [];
  let boxes: QfBox[][] = [];
  let nextId = 1;
  const undoStack: QfBox[][][] = [];
  let busy = false;
  let alive = true;
  const changed = () => boxes.some((b) => b.length);

  function tryClose() {
    if (busy) return;
    if (changed() && !confirm('De vakken zijn nog niet opgeslagen. Toch sluiten?')) return;
    dlg.close();
  }

  // ── Bestand kiezen ──
  function showPicker() {
    const input = el('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true }) as HTMLInputElement;
    input.addEventListener('change', () => input.files?.[0] && load(input.files[0]));
    body.replaceChildren(
      el(
        'div',
        { class: 'qf-pick' },
        el(
          'div',
          { class: 'card' },
          el('h3', {}, 'Iets gemist in een geëxporteerde PDF?'),
          el(
            'p',
            { class: 'note' },
            'Open de PDF, trek met de muis een vak over wat weg moet, en sla op. Geen tekstherkenning, geen splitsen: alleen de pagina\'s met een nieuw vak worden opnieuw opgebouwd (écht weggehaald, niet afgedekt); de rest gaat ongewijzigd mee. Bladwijzers per kandidaat blijven behouden.',
          ),
          el('button', { class: 'drop qf-drop', onclick: () => input.click() }, el('strong', {}, '📄 Kies een PDF'), 'of sleep hem hierheen'),
          input,
        ),
      ),
    );
    foot.replaceChildren(el('button', { class: 'btn', onclick: () => tryClose() }, 'Sluiten'));
  }

  async function load(f: File) {
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') return toast('Kies een PDF-bestand.');
    try {
      body.replaceChildren(el('p', { class: 'note' }, 'Openen…'));
      bytes = new Uint8Array(await f.arrayBuffer());
      pdf = await openPdfBytes(bytes.slice());
      src = await pdfSource(pdf);
      outline = await readOutline(pdf);
      name = f.name;
      boxes = Array.from({ length: src.numPages }, () => []);
      undoStack.length = 0;
      title.textContent = `✏️ Snel wissen – ${f.name}`;
      build();
    } catch (e) {
      toast(`Kan dit bestand niet openen: ${e instanceof Error ? e.message : e}`);
      showPicker();
    }
  }

  // ── Rijen: één per kandidaat (bladwijzers), anders één rij met alle pagina's ──
  function groups(): { title: string; first: number; last: number }[] {
    const n = src!.numPages;
    const starts = outline.filter((o, i, a) => i === 0 || o.page !== a[i - 1].page);
    if (!starts.length) return [{ title: "Alle pagina's", first: 0, last: n - 1 }];
    const out: { title: string; first: number; last: number }[] = [];
    if (starts[0].page > 0) out.push({ title: 'Begin', first: 0, last: starts[0].page - 1 });
    starts.forEach((o, i) => out.push({ title: o.title, first: o.page, last: (starts[i + 1]?.page ?? n) - 1 }));
    return out;
  }

  // ── Beeld: scherper renderen als de pagina in beeld komt ──
  let size = Math.max(80, Math.min(900, Number(pref(SIZE_KEY, '300')) || 300));
  const TIERS = [30, 50, 80, 120, 170];
  const best = new Map<number, { url: string; dpi: number }>();
  const want = new Map<HTMLImageElement, number>();
  let pumping = false;
  const tierFor = (hPx: number, i: number) => {
    const need = (hPx * (window.devicePixelRatio || 1)) / (src!.sizes[i].h / 72);
    return TIERS.find((t) => t >= need) ?? TIERS[TIERS.length - 1];
  };
  async function pump() {
    if (pumping) return;
    pumping = true;
    while (alive && want.size && src) {
      const [img, i] = want.entries().next().value as [HTMLImageElement, number];
      want.delete(img);
      if (!img.isConnected) continue;
      const dpi = tierFor(Number(img.dataset.h) || size, i);
      if (Number(img.dataset.dpi) >= dpi) continue;
      const have = best.get(i);
      let url = have && have.dpi >= dpi ? have.url : '';
      if (!url) {
        try {
          const c = await src.render(i, dpi, true);
          url = c.toDataURL('image/jpeg', 0.85);
          release(c);
          best.set(i, { url, dpi });
        } catch {
          continue;
        }
      }
      if (img.isConnected) {
        img.src = url;
        img.dataset.dpi = String(dpi);
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
  let focusK: number | null = null;
  const SMALL = 120;
  const rowsEl = el('div', { class: 'sr-rows' });
  const summary = el('div', { class: 'sr-summary' });
  const saveBtn = el('button', { class: 'btn primary', onclick: () => save() }, '💾 Opslaan als nieuwe PDF');
  const undoBtn = el('button', { class: 'btn', onclick: () => undo(), title: 'Ctrl+Z' }, '↶ Ongedaan');
  const sizeIn = el('input', { type: 'range', min: '80', max: '900', step: '10', value: String(size), 'aria-label': "Grootte van de pagina's" }) as HTMLInputElement;
  const showBtns = (
    [
      ['vakken', 'Vakken', 'De scan met de vakken die weggehaald worden'],
      ['uitvoer', 'Zoals de uitvoer', 'De vakken alvast dicht, zoals na het opslaan'],
    ] as const
  ).map(([m, l, t]) =>
    el('button', {
      class: 'btn small' + (m === 'vakken' ? ' active' : ''),
      title: t,
      'data-m': m,
      onclick: () => {
        dlg.classList.toggle('m-vakken', m === 'vakken');
        dlg.classList.toggle('m-uitvoer', m === 'uitvoer');
        for (const b of showBtns) b.classList.toggle('active', b.dataset.m === m);
      },
    }, l),
  );
  sizeIn.addEventListener('input', () => {
    size = Number(sizeIn.value);
    dlg.style.setProperty('--sr-h', `${size}px`);
  });
  sizeIn.addEventListener('change', () => {
    savePref(SIZE_KEY, String(size));
    render();
  });

  function build() {
    body.replaceChildren(
      el(
        'p',
        { class: 'note', style: 'margin-top:0' },
        'Sleep op een pagina om een vak te tekenen (Shift = strook over de hele breedte). Klik op een pagina om in te zoomen op die kandidaat (↑ ↓ andere kandidaat, ← → bladeren, Esc uitzoomen). Klik op × om een vak te verwijderen.',
      ),
      el(
        'div',
        { class: 'sr-tools' },
        el('span', { class: 'seg', role: 'group', 'aria-label': 'Weergave' }, ...showBtns),
        el('span', { class: 'sep' }),
        el('label', { class: 'inline' }, 'Grootte', sizeIn),
      ),
      summary,
      rowsEl,
    );
    foot.replaceChildren(
      el('span', { class: 'note qf-foot' }, `Vulkleur: ${S.fill}. Pagina's met een vak worden opnieuw opgebouwd op ${S.exportDpi} dpi (zie Instellingen).`),
      el('span', { class: 'spacer' }),
      undoBtn,
      el('button', { class: 'btn', onclick: () => tryClose() }, 'Annuleren'),
      saveBtn,
    );
    render();
  }

  function focusHeight() {
    const h = body.clientHeight || window.innerHeight;
    return Math.max(260, Math.round(h - 2 * (SMALL + 64) - 100));
  }

  function render(scrollTo?: { k: number; page?: number }) {
    if (!src) return;
    io.disconnect();
    want.clear();
    const gs = groups();
    if (focusK !== null && focusK >= gs.length) focusK = gs.length - 1;
    const zoomed = focusK !== null;
    const bigH = zoomed ? focusHeight() : 0;
    dlg.classList.toggle('zoomed', zoomed);
    dlg.style.setProperty('--sr-h', `${zoomed ? SMALL : size}px`);
    dlg.style.setProperty('--sr-zh', `${bigH}px`);
    const total = boxes.reduce((a, b) => a + b.length, 0);
    const pagesWith = boxes.filter((b) => b.length).length;
    summary.replaceChildren(
      el('strong', {}, `${src.numPages} pagina's`),
      outline.length ? ` · ${gs.length} kandidaten (uit de bladwijzers)` : ' · geen bladwijzers gevonden',
      ' · ',
      total ? el('strong', {}, `${total} vak${total === 1 ? '' : 'ken'} op ${pagesWith} pagina${pagesWith === 1 ? '' : "'s"}`) : 'nog geen vakken',
    );
    saveBtn.disabled = !total;
    undoBtn.disabled = !undoStack.length;
    rowsEl.replaceChildren(
      ...gs.map((g, k) => {
        const isF = k === focusK;
        const items: HTMLElement[] = [];
        let nBox = 0;
        for (let i = g.first; i <= g.last; i++) {
          const sz = src!.sizes[i];
          const h = isF ? bigH : zoomed ? SMALL : size;
          const ready = best.get(i);
          const img = el('img', { src: ready?.url ?? '', alt: `Pagina ${i + 1}`, draggable: 'false', 'data-i': String(i), 'data-h': String(h) }) as HTMLImageElement;
          if (ready) img.dataset.dpi = String(ready.dpi);
          img.style.aspectRatio = `${sz.w} / ${sz.h}`;
          io.observe(img);
          nBox += boxes[i].length;
          items.push(
            el(
              'div',
              { class: 'sr-page', 'data-i': String(i), title: `Pagina ${i + 1} · sleep: vak tekenen · klik: ${isF ? 'uitzoomen' : 'inzoomen'}` },
              img,
              el(
                'div',
                { class: 'sr-boxes qf-boxes' },
                ...boxes[i].map((b) => {
                  const e = el(
                    'div',
                    { class: 'sr-box handmatig' },
                    el('button', { class: 'qf-x', title: 'Vak verwijderen', 'aria-label': 'Vak verwijderen', 'data-i': String(i), 'data-id': String(b.id) }, '×'),
                  );
                  e.style.cssText = `left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%`;
                  return e;
                }),
              ),
              el('span', { class: 'n' }, String(i + 1)),
            ),
          );
        }
        const len = g.last - g.first + 1;
        return el(
          'div',
          { class: `sr-row c${k % 6}` + (isF ? ' focus' : ''), 'data-k': String(k) },
          el(
            'div',
            { class: 'sr-head' },
            el('span', { class: 'sr-label' }, g.title),
            isF ? el('span', { class: 'sr-of' }, `${k + 1} van ${gs.length}`) : null,
            el('span', {}, `${len} pagina${len === 1 ? '' : "'s"} (p. ${len === 1 ? g.first + 1 : `${g.first + 1}–${g.last + 1}`})`),
            nBox ? el('span', { class: 'note' }, `· ${nBox} nieuw vak${nBox === 1 ? '' : 'ken'}`) : null,
            el('span', { class: 'spacer' }),
            isF
              ? el(
                  'span',
                  { class: 'inline' },
                  el('button', { class: 'btn small', disabled: k === 0, onclick: () => zoomTo(k - 1), title: 'Vorige (↑)' }, '↑'),
                  el('button', { class: 'btn small', disabled: k === gs.length - 1, onclick: () => zoomTo(k + 1), title: 'Volgende (↓)' }, '↓'),
                  el('button', { class: 'btn small', onclick: () => zoomTo(null, g.first), title: 'Uitzoomen (Esc)' }, '⤡ Uitzoomen'),
                )
              : el('button', { class: 'btn small', onclick: () => zoomTo(k), title: 'Inzoomen' }, '🔍 Inzoomen'),
          ),
          el('div', { class: 'sr-strip' }, ...items),
        );
      }),
    );
    const target = scrollTo ?? (focusK !== null ? { k: focusK } : null);
    if (target)
      requestAnimationFrame(() => {
        rowsEl.querySelector(`.sr-row[data-k="${target.k}"]`)?.scrollIntoView({ block: 'center' });
        if (target.page !== undefined) rowsEl.querySelector(`.sr-page[data-i="${target.page}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
      });
  }
  function zoomTo(k: number | null, page?: number) {
    const prev = focusK;
    focusK = k;
    render({ k: k ?? prev ?? 0, page });
  }
  const groupOf = (i: number) => groups().findIndex((g) => i >= g.first && i <= g.last);

  function snap() {
    undoStack.push(boxes.map((b) => b.map((x) => ({ ...x }))));
    if (undoStack.length > 200) undoStack.shift();
  }
  function undo() {
    const u = undoStack.pop();
    if (!u) return;
    boxes = u;
    render();
  }

  // ── Tekenen ──
  let draw: { i: number; x0: number; y0: number; r: DOMRect; px: number; py: number; ghost?: HTMLElement; full: boolean } | null = null;
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const rectOf = (d: NonNullable<typeof draw>, e: PointerEvent): Rect => {
    const x1 = clamp((e.clientX - d.r.left) / d.r.width);
    const y1 = clamp((e.clientY - d.r.top) / d.r.height);
    const x = d.full ? 0 : Math.min(d.x0, x1);
    const w = d.full ? 1 : Math.abs(x1 - d.x0);
    return { x, y: Math.min(d.y0, y1), w, h: Math.abs(y1 - d.y0) };
  };
  rowsEl.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (e.button !== 0) return;
    const x = t.closest('.qf-x') as HTMLElement | null;
    if (x) {
      e.preventDefault();
      const i = Number(x.dataset.i);
      snap();
      boxes[i] = boxes[i].filter((b) => b.id !== Number(x.dataset.id));
      render();
      return;
    }
    const pg = t.closest('.sr-page') as HTMLElement | null;
    const img = pg?.querySelector('img');
    if (!pg || !img) return;
    const r = img.getBoundingClientRect();
    draw = { i: Number(pg.dataset.i), r, x0: clamp((e.clientX - r.left) / r.width), y0: clamp((e.clientY - r.top) / r.height), px: e.clientX, py: e.clientY, full: e.shiftKey };
    rowsEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  rowsEl.addEventListener('pointermove', (e) => {
    if (!draw) return;
    if (!draw.ghost) {
      if (Math.hypot(e.clientX - draw.px, e.clientY - draw.py) < 5) return;
      draw.ghost = el('div', { class: 'sr-box handmatig qf-ghost' });
      rowsEl.querySelector(`.sr-page[data-i="${draw.i}"] .sr-boxes`)?.append(draw.ghost);
    }
    const b = rectOf(draw, e);
    draw.ghost.style.cssText = `left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%`;
  });
  const endDraw = (e: PointerEvent) => {
    if (!draw) return;
    const d = draw;
    draw = null;
    d.ghost?.remove();
    if (e.type !== 'pointerup') return;
    if (!d.ghost) {
      // Gewone klik: inzoomen op deze kandidaat (of uitzoomen).
      const k = groupOf(d.i);
      zoomTo(focusK === k ? null : k, d.i);
      return;
    }
    const b = rectOf(d, e);
    // Heel kleine vakken zijn waarschijnlijk per ongeluk.
    if (b.w * d.r.width < 6 || b.h * d.r.height < 6) return;
    snap();
    boxes[d.i].push({ ...b, id: nextId++ });
    render({ k: groupOf(d.i), page: d.i });
  };
  rowsEl.addEventListener('pointerup', endDraw);
  rowsEl.addEventListener('pointercancel', endDraw);

  // ── Opslaan ──
  async function save() {
    if (!bytes || !pdf || !src || busy || !changed()) return;
    busy = true;
    saveBtn.disabled = true;
    const label = saveBtn.textContent;
    try {
      const res = await patchPdf(bytes, pdf, src, boxes, outline, S, (done, total) => {
        saveBtn.textContent = `Opslaan… ${done}/${total}`;
      });
      saveBtn.textContent = 'Controleren…';
      const v = await verifyOutput(res.bytes, [], src.numPages);
      const base = name.replace(/\.pdf$/i, '').replace(/ \(nagewist\)$/, '');
      download(res.bytes, safeFileName(`${base} (nagewist)`) + '.pdf', 'application/pdf');
      const bad = v.checks.filter((c) => !c.ok);
      toast(
        bad.length
          ? `⚠ Opgeslagen, maar controleer: ${bad.map((c) => c.msg).join('; ')}`
          : `✓ Opgeslagen en gecontroleerd: ${res.rebuilt} pagina${res.rebuilt === 1 ? '' : "'s"} opnieuw opgebouwd, de rest ongewijzigd.`,
      );
      boxes = boxes.map(() => []);
      busy = false;
      dlg.close();
    } catch (e) {
      busy = false;
      toast(`Opslaan mislukt: ${e instanceof Error ? e.message : e}`);
      saveBtn.textContent = label;
      saveBtn.disabled = false;
    }
  }

  // ── Toetsen, slepen en sluiten ──
  dlg.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).closest('input, select, textarea')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    if (focusK === null) return;
    const last = groups().length - 1;
    const strip = rowsEl.querySelector('.sr-row.focus .sr-strip') as HTMLElement | null;
    const step = (strip?.querySelector('.sr-page') as HTMLElement | null)?.offsetWidth ?? 300;
    if (e.key === 'ArrowDown' && focusK < last) zoomTo(focusK + 1);
    else if (e.key === 'ArrowUp' && focusK > 0) zoomTo(focusK - 1);
    else if (e.key === 'ArrowRight') strip?.scrollBy({ left: step + 22, behavior: 'smooth' });
    else if (e.key === 'ArrowLeft') strip?.scrollBy({ left: -(step + 22), behavior: 'smooth' });
    else return;
    e.preventDefault();
  });
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (focusK !== null) zoomTo(null);
    else tryClose();
  });
  for (const t of ['dragenter', 'dragover', 'dragleave'] as const)
    dlg.addEventListener(t, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  dlg.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const f = [...(e.dataTransfer?.files ?? [])].find((x) => /\.pdf$/i.test(x.name));
    if (!f) return toast('Sleep hier een PDF-bestand.');
    if (changed() && !confirm('Een andere PDF openen? De vakken die je hier getekend hebt, gaan dan verloren.')) return;
    load(f);
  });
  const onResize = () => focusK !== null && render();
  window.addEventListener('resize', onResize);
  dlg.addEventListener('close', () => {
    alive = false;
    io.disconnect();
    window.removeEventListener('resize', onResize);
    best.clear();
    pdf?.loadingTask.destroy();
    dlg.remove();
  });

  document.body.append(dlg);
  dlg.showModal();
  if (file) load(file);
  else showPicker();
}
