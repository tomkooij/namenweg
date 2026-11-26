// Koppelen: welke toets hoort bij welke leerling? Je ziet de naamvakken uit de scan en typt een
// paar letters van de naam. Geen OCR. De leerlinglijst en de koppelingen blijven alleen in het
// geheugen van dit tabblad en komen alleen in het sleutelbestand terecht.
import type { PageState, Rect } from './types';
import { release, type Source } from './pdfio';
import { el } from './util';
import {
  makeStudent,
  parseCsv,
  readTable,
  rosterFromRows,
  search,
  studentKey,
  suggestFromFileName,
  UNK,
  type Match,
  type Roster,
  type Student,
} from './roster';

export interface MatchDoc {
  id: string;
  name: string;
  num: number;
  pages: PageState[];
  src: Source | null;
  status: string;
  /** Gekoppelde leerling (id); UNK = niet in lijst / onleesbaar; undefined = nog niet gekoppeld. */
  student?: string;
}

/** Wat het koppelvenster van de rest van de app nodig heeft. */
export interface MatchHost {
  docs(): MatchDoc[];
  label(d: MatchDoc): string;
  /** Documenten samenvoegen (bijv. een apart gescande uitwerkbijlage). */
  merge(list: MatchDoc[]): MatchDoc | null;
  /** Splitsvenster openen; `onDone` na sluiten. Geeft false als dat nu niet kan. */
  openSplit(d: MatchDoc, onDone: () => void): boolean;
  /** Document in de editor tonen. */
  show(d: MatchDoc): void;
  /** Documentenlijst opnieuw tekenen. */
  changed(): void;
  downloadKey(): void;
  toast(msg: string): void;
}

/** Alleen in het geheugen; `dirty` = koppelingen gewijzigd sinds het laatste sleutelbestand. */
export const matchState: { roster: Roster | null; dirty: boolean } = { roster: null, dirty: false };

export const studentById = (id?: string): Student | undefined =>
  id && id !== UNK ? matchState.roster?.students.find((s) => s.id === id) : undefined;

/** Namen uit de lijst (om ook elders op de pagina te zoeken en de export te controleren). */
export const rosterNames = () => matchState.roster?.students.map((s) => s.name) ?? [];

/** Korte status voor bij een document in de lijst. */
export function matchChip(d: MatchDoc, all: MatchDoc[]): { text: string; cls: string; title: string } | null {
  if (!matchState.roster) return null;
  if (d.student === undefined) return { text: '👤 nog niet gekoppeld', cls: '', title: 'Nog niet aan een leerling gekoppeld' };
  if (d.student === UNK) return { text: '👤 niet in lijst', cls: 'warn', title: 'Gemarkeerd als "niet in lijst / onleesbaar"' };
  const s = studentById(d.student);
  if (!s) return null;
  const n = all.filter((x) => x.student === d.student).length;
  return n > 1
    ? { text: `👤 ${s.name} (${n}×)`, cls: 'err', title: 'Deze leerling is aan meer dan één toets gekoppeld' }
    : { text: `👤 ${s.name}`, cls: 'ok', title: 'Gekoppeld aan deze leerling' };
}

/** Nieuwe lijst; bestaande koppelingen worden overgezet op leerlingnummer of naam. */
export function setRoster(r: Roster, docs: MatchDoc[]) {
  const old = matchState.roster;
  let kept = 0;
  let lost = 0;
  if (old) {
    const byKey = new Map(r.students.map((s) => [studentKey(s), s]));
    const byName = new Map(r.students.map((s) => [s.norm, s]));
    for (const d of docs) {
      if (!d.student || d.student === UNK) continue;
      const os = old.students.find((s) => s.id === d.student);
      let ns = os && (byKey.get(studentKey(os)) ?? byName.get(os.norm));
      if (!ns && os?.extra) {
        ns = makeStudent(os.name, `x${r.students.length + 1}`, r.students.length + 1, os.nr, os.klas, true);
        r.students.push(ns);
        byKey.set(studentKey(ns), ns);
        byName.set(ns.norm, ns);
      }
      if (ns) {
        d.student = ns.id;
        kept++;
      } else {
        d.student = undefined;
        lost++;
      }
    }
  }
  matchState.roster = r;
  matchState.dirty = docs.some((d) => d.student !== undefined);
  return { kept, lost };
}

// ───────────────────────── Uitsneden van de naamvakken ─────────────────────────

interface CropRegion {
  page: number;
  r: Rect;
}

/** Welke stukken van de scan tonen: per pagina met vakken de omhullende (max. 4 pagina's). */
function regionsFor(d: MatchDoc): CropRegion[] {
  const out: CropRegion[] = [];
  const union = (bs: Rect[]) => {
    const x0 = Math.min(...bs.map((b) => b.x));
    const y0 = Math.min(...bs.map((b) => b.y));
    const x1 = Math.max(...bs.map((b) => b.x + b.w));
    const y1 = Math.max(...bs.map((b) => b.y + b.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  for (const p of d.pages) {
    if (!p.boxes.length) continue;
    let u = union(p.boxes);
    // Vakken ver uit elkaar (bijv. naam boven, nummer onderaan): alleen de naam.
    if (u.h > 0.35) {
      const naam = p.boxes.filter((b) => b.kind === 'naam' || b.text);
      u = union(naam.length ? naam : [p.boxes[0]]);
    }
    const mx = 0.05;
    const my = 0.012;
    const x = Math.max(0, u.x - mx);
    const y = Math.max(0, u.y - my);
    out.push({ page: p.index, r: { x, y, w: Math.min(1, u.x + u.w + mx) - x, h: Math.min(1, u.y + u.h + my) - y } });
    if (out.length >= 4) break;
  }
  if (!out.length && d.pages.length) out.push({ page: 0, r: { x: 0, y: 0, w: 1, h: 0.3 } });
  return out;
}

const cropKey = (d: MatchDoc) =>
  d.id + '|' + d.pages.map((p) => `${p.userRot ?? 0}:${p.boxes.map((b) => [b.x, b.y, b.w, b.h].map((v) => v.toFixed(3)).join(',')).join(';')}`).join('/');
const cropCache = new Map<string, { url: string; page: number }[]>();

async function makeCrops(d: MatchDoc) {
  const out: { url: string; page: number }[] = [];
  for (const { page, r } of regionsFor(d)) {
    const p = d.pages[page];
    // Ongeveer 1000 pixels breed, genoeg voor handschrift op een groot scherm.
    const dpi = Math.max(60, Math.min(170, 1000 / Math.max(0.5, (r.w * p.wPt) / 72)));
    const c = await d.src!.render(page, dpi, true);
    const W = c.width;
    const H = c.height;
    const o = document.createElement('canvas');
    o.width = Math.max(1, Math.round(r.w * W));
    o.height = Math.max(1, Math.round(r.h * H));
    o.getContext('2d')!.drawImage(c, Math.round(r.x * W), Math.round(r.y * H), o.width, o.height, 0, 0, o.width, o.height);
    release(c);
    out.push({ url: o.toDataURL('image/jpeg', 0.85), page });
    release(o);
  }
  return out;
}

// ───────────────────────── Venster ─────────────────────────

const MAXC = 3; // aantal kandidaten dat met een cijfer te kiezen is

export function openMatcher(host: MatchHost, startId?: string) {
  const items = () => host.docs().filter((d) => d.status === 'klaar' && d.src);
  if (!items().length) return host.toast('Voeg eerst toetsen toe.');
  let alive = true;
  let curId = items()[0].id;
  let sel = 0;
  let picked = false;
  let suggested = false;
  let confirmFor: string | null = null;
  let matches: Match[] = [];
  let last: { id: string } | null = null;
  let ovOpen = false;
  const history: { a: Map<string, string | undefined>; n: number }[] = [];

  const students = () => matchState.roster?.students ?? [];
  const docOf = (id: string) => items().find((d) => d.id === id);
  const curDoc = (): MatchDoc => {
    const list = items();
    return list.find((d) => d.id === curId) ?? list[0];
  };
  const countOf = (sid: string) => items().filter((d) => d.student === sid).length;
  const isProblem = (d: MatchDoc) => !!d.student && d.student !== UNK && countOf(d.student) > 1;
  const problems = () => items().filter(isProblem);
  const labelOf = (sid?: string) => (sid === UNK ? 'Niet in lijst' : (studentById(sid)?.name ?? ''));

  // ── Opbouw ──
  const dlg = el('dialog', { class: 'mt' });
  const barFill = el('i');
  const progTxt = el('span', { class: 'mt-progtxt' });
  const probsBtn = el('button', { class: 'btn mt-probs', hidden: true, onclick: () => nextProblem(), title: 'Spring naar het volgende probleem' });
  const listBtn = el('button', { class: 'btn', onclick: () => showLoader(true), title: 'Een andere leerlinglijst kiezen' });
  const keyBtn = el('button', { class: 'btn', onclick: () => downloadKey(), title: 'Welke kandidaat is welke leerling (blijft op je computer)' }, '🗝 Sleutel (CSV)');
  const head = el(
    'div',
    { class: 'dhead' },
    el('h2', {}, '👥 Leerlingen koppelen'),
    el('div', { class: 'mt-prog' }, el('div', { class: 'mt-bar' }, barFill), progTxt),
    el(
      'div',
      { class: 'mt-tools' },
      probsBtn,
      el('button', { class: 'btn', onclick: () => undo(), title: 'Ctrl+Z' }, '↶ Ongedaan'),
      el('button', { class: 'btn', onclick: () => openOv(), title: 'Ctrl+O' }, 'Overzicht'),
      listBtn,
      keyBtn,
    ),
    el('button', { class: 'btn icon', onclick: () => close(), title: 'Sluiten (Esc)', 'aria-label': 'Sluiten' }, '✕'),
  );
  const pos = el('span', { class: 'mt-pos' });
  const docBtns = el('span', { class: 'mt-docbtns' });
  const crops = el('div', { class: 'mt-crops' });
  const big = el('div', { class: 'mt-big' });
  const compare = el('div', { class: 'mt-compare' });
  const lastEl = el('div', { class: 'mt-last' });
  const stage = el('div', { class: 'mt-stage' }, el('div', { class: 'mt-meta' }, pos, docBtns), crops, big, compare, lastEl);
  const film = el('div', { class: 'mt-film' });
  const q = el('input', { class: 'mt-q', autocomplete: 'off', spellcheck: 'false', placeholder: 'Typ de eerste letters…', 'aria-label': 'Naam zoeken' }) as HTMLInputElement;
  const list = el('div', { class: 'mt-list' });
  const right = el(
    'div',
    { class: 'mt-right' },
    q,
    el(
      'div',
      { class: 'mt-keys' },
      el('span', {}, el('kbd', {}, '↵'), ' koppel'),
      el('span', {}, el('kbd', {}, '1'), '–', el('kbd', {}, '3'), ' kies'),
      el('span', {}, el('kbd', {}, '←'), el('kbd', {}, '→'), ' bladeren'),
      el('span', {}, el('kbd', {}, 'Ctrl+Z'), ' ongedaan'),
      el('button', { class: 'mt-helpbtn', onclick: () => toggleHelp(true), title: 'Alle sneltoetsen (?)' }, '?'),
    ),
    list,
    el(
      'div',
      { class: 'mt-extra' },
      el('button', { class: 'btn', onclick: () => assign(UNK), title: 'Ctrl+Enter' }, '❓ Niet in lijst / onleesbaar'),
      el('button', { class: 'btn', onclick: () => addTyped(), title: 'Shift+Enter: de getypte naam toevoegen' }, '＋ Nieuwe leerling'),
      el('button', { class: 'btn', onclick: () => goNextOpen(1), title: 'Tab' }, 'Volgende open ⇥'),
    ),
  );
  const mainEl = el('div', { class: 'mt-main' }, el('div', { class: 'mt-left' }, stage, film), right);
  const loader = el('div', { class: 'mt-loader' });
  const ov = el('div', { class: 'mt-ov', hidden: true });
  const help = el('div', { class: 'mt-help', hidden: true, onclick: () => toggleHelp(false) });
  dlg.append(head, mainEl, loader, ov, help);

  // ── Uitsneden renderen: eerst de huidige toets, dan de buren, dan de rest ──
  let pumping = false;
  const failed = new Set<string>();
  async function pump() {
    if (pumping) return;
    pumping = true;
    while (alive) {
      const list = items();
      const i = Math.max(0, list.findIndex((d) => d.id === curId));
      const order = [i, i + 1, i + 2, i - 1, i + 3, i + 4, ...list.map((_, k) => k)].map((k) => list[k]).filter(Boolean);
      // Ook de toetsen die in het vergelijkvak staan.
      const extra = [...compare.querySelectorAll<HTMLElement>('[data-doc]')].map((e) => docOf(e.dataset.doc!)).filter((d): d is MatchDoc => !!d);
      const next = [...extra, ...order].find((d) => !cropCache.has(cropKey(d)) && !failed.has(cropKey(d)));
      if (!next) break;
      const key = cropKey(next);
      try {
        cropCache.set(key, await makeCrops(next));
      } catch {
        failed.add(key);
      }
      fillImgs(next);
    }
    pumping = false;
  }
  /** Afbeeldingen van een document invullen zodra de uitsneden klaar zijn. */
  function fillImgs(d: MatchDoc) {
    const cs = cropCache.get(cropKey(d));
    for (const img of dlg.querySelectorAll<HTMLImageElement>(`img[data-doc="${d.id}"]`)) {
      const c = cs?.[Number(img.dataset.k) || 0];
      if (c) {
        img.src = c.url;
        img.classList.add('ok');
      } else if (failed.has(cropKey(d))) img.alt = 'kan niet tonen';
    }
  }
  const cropImg = (d: MatchDoc, k = 0) => {
    const img = el('img', { 'data-doc': d.id, 'data-k': String(k), alt: '', draggable: 'false' }) as HTMLImageElement;
    const c = cropCache.get(cropKey(d))?.[k];
    if (c) {
      img.src = c.url;
      img.classList.add('ok');
    }
    return img;
  };

  // ── Logica ──
  function snap() {
    history.push({ a: new Map(items().map((d) => [d.id, d.student])), n: students().length });
    if (history.length > 300) history.shift();
  }
  function undo() {
    const h = history.pop();
    if (!h) return host.toast('Niets om ongedaan te maken');
    for (const d of items()) if (h.a.has(d.id)) d.student = h.a.get(d.id);
    if (matchState.roster) matchState.roster.students.length = h.n;
    matchState.dirty = true;
    last = null;
    resetInput();
    render();
    host.toast('Ongedaan gemaakt');
  }
  function othersOf(sid: string) {
    return items().filter((d) => d.student === sid && d.id !== curId);
  }
  function tryAssign(sid: string) {
    if (sid !== UNK && othersOf(sid).length && confirmFor !== sid) {
      confirmFor = sid;
      updateBig(true);
      return;
    }
    assign(sid);
  }
  function assign(sid: string) {
    const d = curDoc();
    snap();
    d.student = sid;
    matchState.dirty = true;
    last = { id: d.id };
    if (sid !== UNK && countOf(sid) > 1) host.toast(`⚠ ${labelOf(sid)} heeft nu ${countOf(sid)} toetsen`);
    const nxt = nextOpen(1);
    if (!nxt) {
      resetInput();
      render();
      if (!problems().length) host.toast('🎉 Alle toetsen zijn gekoppeld!');
      return;
    }
    go(nxt.id);
  }
  function addTyped() {
    const name = q.value.trim().replace(/\s+/g, ' ');
    if (!name || !matchState.roster) {
      host.toast('Typ eerst de volledige naam van de nieuwe leerling');
      q.focus();
      return;
    }
    const r = matchState.roster;
    const s = makeStudent(name, `x${r.students.length + 1}`, r.students.length + 1, '', '', true);
    const ex = r.students.find((x) => x.norm === s.norm);
    if (ex) return tryAssign(ex.id);
    snap(); // ongedaan maken haalt ook de nieuwe leerling weer weg
    r.students.push(s);
    host.toast(`"${s.name}" toegevoegd aan de lijst`);
    const d = curDoc();
    d.student = s.id;
    matchState.dirty = true;
    last = { id: d.id };
    const nxt = nextOpen(1);
    if (nxt) go(nxt.id);
    else {
      resetInput();
      render();
    }
  }
  function unassign(d: MatchDoc) {
    if (d.student === undefined) return false;
    snap();
    d.student = undefined;
    matchState.dirty = true;
    render();
    return true;
  }
  function nextOpen(dir: 1 | -1) {
    const list = items();
    const i = list.findIndex((d) => d.id === curId);
    for (let k = 1; k <= list.length; k++) {
      const d = list[(((i + dir * k) % list.length) + list.length) % list.length];
      if (d.student === undefined && d.id !== curId) return d;
    }
    return null;
  }
  function goNextOpen(dir: 1 | -1) {
    const n = nextOpen(dir);
    if (n) go(n.id);
    else host.toast(curDoc().student === undefined ? 'Dit is de laatste open toets' : 'Alle toetsen zijn gekoppeld');
    q.focus();
  }
  function step(delta: number) {
    const list = items();
    const i = list.findIndex((d) => d.id === curId);
    const n = list[Math.max(0, Math.min(list.length - 1, i + delta))];
    if (n) go(n.id);
  }
  function resetInput() {
    q.value = '';
    sel = 0;
    picked = false;
    suggested = false;
    confirmFor = null;
  }
  function go(id: string) {
    curId = id;
    resetInput();
    // Naam in de bestandsnaam (bijv. "jansen piet.pdf")? Dan staat die alvast klaar.
    const d = curDoc();
    if (d.student === undefined) {
      const s = suggestFromFileName(students(), d.name);
      if (s) {
        q.value = s.name;
        suggested = true;
      }
    }
    render();
    q.focus();
  }
  function nextProblem() {
    const list = items();
    const p = problems();
    if (!p.length) return;
    const i = list.findIndex((d) => d.id === curId);
    go((p.find((d) => list.indexOf(d) > i) ?? p[0]).id);
  }
  function merge(list: MatchDoc[], sid?: string) {
    const all = items();
    const sorted = [...list].sort((a, b) => all.indexOf(a) - all.indexOf(b));
    const nd = host.merge(sorted);
    if (!nd) return host.toast('Samenvoegen lukt niet');
    history.length = 0; // de oude documenten bestaan niet meer
    nd.student = sid ?? sorted.find((d) => d.student !== undefined)?.student;
    matchState.dirty = true;
    host.toast(`Samengevoegd tot één toets (${host.label(nd)}, ${nd.pages.length} pagina's)`);
    curId = nd.id;
    last = null;
    resetInput();
    render();
    q.focus();
  }
  function openSplit(d: MatchDoc) {
    const ok = host.openSplit(d, () => {
      if (!alive) return;
      history.length = 0;
      if (!docOf(curId)) curId = items()[0]?.id ?? '';
      if (!items().length) return close();
      render();
      q.focus();
    });
    if (!ok) q.focus();
  }

  // ── Tekenen ──
  function esc(s: string) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  }
  /** Naam met de getypte stukjes onderstreept. */
  function hl(name: string, toks: string[]) {
    if (!toks.length) return esc(name);
    const n = (w: string) => w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    return name
      .split(/(\s+)/)
      .map((w) => {
        const nw = n(w);
        const t = toks.find((t) => nw.startsWith(t) || (t.length > 2 && nw.includes(t)));
        if (!t) return esc(w);
        const at = nw.startsWith(t) ? 0 : nw.indexOf(t);
        return esc(w.slice(0, at)) + '<mark>' + esc(w.slice(at, at + t.length)) + '</mark>' + esc(w.slice(at + t.length));
      })
      .join('');
  }
  const meta = (s: Student) => [s.klas, s.nr].filter(Boolean).join(' · ');

  function render() {
    if (!alive) return;
    if (!matchState.roster) return showLoader(false);
    loader.hidden = true;
    mainEl.hidden = false;
    dlg.classList.remove('loading');
    const list = items();
    if (!list.length) return close();
    if (!docOf(curId)) curId = list[0].id;
    const d = curDoc();
    const done = list.filter((x) => x.student !== undefined && !isProblem(x)).length;
    const without = students().filter((s) => !list.some((x) => x.student === s.id)).length;
    barFill.style.width = `${(done / list.length) * 100}%`;
    progTxt.textContent = `${done} / ${list.length} toetsen · ${students().length} leerlingen${without ? ` · ${without} zonder toets` : ''}`;
    const p = problems().length;
    probsBtn.hidden = !p;
    probsBtn.textContent = `⚠ ${p} probleem${p === 1 ? '' : 'en'} →`;
    listBtn.textContent = `📋 Lijst (${students().length})`;
    keyBtn.classList.toggle('primary', matchState.dirty && done === list.length && !p);

    const i = list.indexOf(d);
    pos.replaceChildren(el('b', {}, `Toets ${i + 1} van ${list.length}`), ` · ${host.label(d)} · ${d.pages.length} pagina${d.pages.length === 1 ? '' : "'s"} · `, el('span', { class: 'mt-file', title: d.name }, d.name));
    docBtns.replaceChildren(
      el('button', { class: 'btn small', onclick: () => openSplit(d), title: 'Horen deze pagina\'s niet bij één leerling? Pas de splitsing aan.' }, '✂ Splitsing'),
      el('button', { class: 'btn small', onclick: () => { close(); host.show(d); }, title: 'Deze toets in de editor openen (vakken aanpassen)' }, 'Openen'),
    );
    const regs = regionsFor(d);
    crops.replaceChildren(
      ...regs.map((r, k) =>
        el('div', { class: 'mt-crop' }, cropImg(d, k), el('small', {}, `p. ${r.page + 1}${d.pages[r.page].boxes.length ? '' : ' · geen vak, bovenkant getoond'}`)),
      ),
      el('button', { class: 'mt-nav l', tabindex: '-1', onclick: () => { step(-1); q.focus(); }, 'aria-label': 'Vorige toets' }, '‹'),
      el('button', { class: 'mt-nav r', tabindex: '-1', onclick: () => { step(1); q.focus(); }, 'aria-label': 'Volgende toets' }, '›'),
    );
    renderFilm();
    renderList();
    renderLast();
    pump();
  }

  function renderFilm() {
    const list = items();
    film.replaceChildren(
      ...list.map((d, k) => {
        const bad = isProblem(d);
        const st = d.student;
        const lab = st === undefined ? `${k + 1}` : bad ? `⚠ ${labelOf(st)} (${countOf(st)}×)` : labelOf(st);
        return el(
          'button',
          {
            class: 'mt-th' + (bad ? ' bad' : st === undefined ? '' : st === UNK ? ' unk' : ' done') + (d.id === curId ? ' cur' : ''),
            tabindex: '-1',
            title: `${host.label(d)} – ${d.name}`,
            onclick: () => go(d.id),
          },
          cropImg(d),
          el('span', {}, lab),
        );
      }),
    );
    film.querySelector('.cur')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function renderList() {
    const qv = q.value;
    matches = search(students(), qv, (s) => countOf(s.id) > 0 && curDoc().student !== s.id);
    if (sel >= matches.length) sel = Math.max(0, matches.length - 1);
    const own = curDoc().student;
    const multi = !!qv && matches.length > 1 && !picked;
    if (!matches.length) {
      list.replaceChildren(
        el(
          'div',
          { class: 'mt-empty' },
          'Geen leerling gevonden voor "',
          el('b', {}, qv),
          '". ',
          el('br'),
          el('kbd', {}, '⇧↵'),
          ' voegt de naam toe als nieuwe leerling, ',
          el('kbd', {}, 'Ctrl+↵'),
          ' markeert als "niet in lijst".',
        ),
      );
      updateBig();
      return;
    }
    list.replaceChildren(
      ...matches.map((m, k) => {
        const n = countOf(m.s.id);
        const b = el(
          'button',
          {
            class:
              'mt-chip' +
              (qv && (picked || matches.length === 1) && k === sel ? ' sel' : '') +
              (n >= 1 && own !== m.s.id ? ' full' : '') +
              (n > 1 ? ' over' : '') +
              (own === m.s.id ? ' own' : ''),
            tabindex: '-1',
            title: n ? `Gekoppeld aan ${n} toets${n === 1 ? '' : 'en'}` : 'Nog geen toets',
            onclick: () => {
              tryAssign(m.s.id);
              q.focus();
            },
          },
          multi && k < MAXC ? el('b', { class: 'num' }, String(k + 1)) : null,
        );
        const nm = el('span', { class: 'nm' });
        nm.innerHTML = hl(m.s.name, m.toks);
        b.append(nm, meta(m.s) ? el('small', {}, meta(m.s)) : '', el('span', { class: 'dots' }, ...Array.from({ length: Math.max(1, n) }, (_, j) => el('i', { class: j < n ? 'on' : '' }))));
        return b;
      }),
    );
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    updateBig();
  }

  function fit(e: HTMLElement, max: number) {
    e.style.fontSize = max + 'px';
    const avail = (e.parentElement?.clientWidth ?? 600) - 40;
    e.style.fontSize = Math.max(14, Math.min(max, (max * avail) / Math.max(1, e.scrollWidth))) + 'px';
  }

  function updateBig(shake = false) {
    const qv = q.value;
    const d = curDoc();
    const st = d.student;
    let cls = '';
    let html = '';
    let hint = '';
    let multi = false;
    if (confirmFor !== null) {
      cls = 'bad';
      html = `<span class="bt">${esc(labelOf(confirmFor))}</span>`;
      const n = othersOf(confirmFor).length;
      hint = `⚠ Heeft al ${n} toets${n === 1 ? '' : 'en'} – nogmaals ↵ om tóch te koppelen, Esc om te annuleren`;
    } else if (qv) {
      if (!matches.length) {
        cls = 'nomatch';
        html = `<span class="bt">${esc(qv)}</span>`;
        hint = 'Geen leerling gevonden · ⇧↵ nieuwe leerling · Ctrl+↵ niet in lijst';
      } else if (matches.length === 1 || picked) {
        const m = matches[sel];
        cls = 'typing';
        html = `<span class="bt">${hl(m.s.name, m.toks)}</span>`;
        hint = suggested ? '↵ koppel (naam uit de bestandsnaam) · typ om te wijzigen' : picked && matches.length > 1 ? '↵ koppel (gekozen met ↑↓)' : '↵ koppel';
        if (meta(m.s)) hint += ` · ${meta(m.s)}`;
      } else {
        multi = true;
        cls = 'multi';
        const k = Math.min(MAXC, matches.length);
        html = matches
          .slice(0, k)
          .map((m, n) => {
            const full = countOf(m.s.id) > 0 && d.student !== m.s.id;
            return `<div class="cand${full ? ' full' : ''}" data-id="${esc(m.s.id)}"><b class="num">${n + 1}</b><span class="bt">${hl(m.s.name, m.toks)}</span>${full ? '<small class="vol">al gekoppeld</small>' : ''}</div>`;
          })
          .join('');
        hint = `${matches.length} namen passen – druk ${k === 2 ? '1 of 2' : `1–${k}`} of typ verder`;
      }
    } else if (st !== undefined) {
      if (isProblem(d)) {
        cls = 'bad';
        html = `<span class="bt">${esc(labelOf(st))}</span>`;
        hint = `⚠ ${countOf(st)} toetsen gekoppeld aan deze leerling – ⌫ wis, typ een andere naam of voeg samen`;
      } else {
        cls = st === UNK ? 'unk' : 'done';
        html = `<span class="bt">${esc(labelOf(st))}</span>`;
        hint = '✓ gekoppeld · ⌫ wis · typ om te wijzigen';
      }
    } else {
      cls = 'empty';
      html = '<span class="bt">typ een naam…</span>';
      hint = 'begin met de eerste letters van voor- of achternaam';
    }
    big.className = 'mt-big ' + cls;
    big.innerHTML = html + `<span class="hint">${esc(hint)}</span>`;
    const M = Math.max(24, Math.min(84, (big.clientHeight - 30) * 0.8));
    big.querySelectorAll<HTMLElement>('.bt').forEach((e) => fit(e, multi ? Math.round(M * 0.55) : cls === 'empty' ? Math.round(M * 0.45) : M));
    big.querySelectorAll<HTMLElement>('.cand').forEach((c) =>
      c.addEventListener('click', () => {
        tryAssign(c.dataset.id!);
        q.focus();
      }),
    );
    if (shake) {
      big.classList.remove('shake');
      void big.offsetWidth;
      big.classList.add('shake');
    }
    renderCompare();
  }

  /** De andere toetsen van de (voorgestelde) leerling, om het handschrift te vergelijken. */
  function renderCompare() {
    const qv = q.value;
    const d = curDoc();
    let sid: string | null = null;
    let own = false;
    if (confirmFor !== null) sid = confirmFor;
    else if (qv && matches.length && (matches.length === 1 || picked)) sid = matches[sel].s.id;
    else if (!qv && isProblem(d)) {
      sid = d.student!;
      own = true;
    }
    const others = sid ? othersOf(sid) : [];
    if (!sid || !others.length) {
      compare.className = 'mt-compare';
      compare.replaceChildren();
      return;
    }
    const name = labelOf(sid);
    compare.className = 'mt-compare show bad';
    const n = others.length;
    compare.replaceChildren(
      el(
        'div',
        { class: 't' },
        own ? `⚠ Ook gekoppeld aan ${name} – welke hoort er niet bij?` : `⚠ ${name} heeft al ${n} toets${n === 1 ? '' : 'en'} – vergelijk het handschrift:`,
      ),
      el(
        'div',
        { class: 'row' },
        ...others.map((o) =>
          el(
            'div',
            { class: 'mt-cmp' },
            el('button', { class: 'mt-cmp-img', title: `${host.label(o)} – klik om erheen te gaan`, onclick: () => go(o.id) }, cropImg(o)),
            el(
              'div',
              { class: 'mt-cmp-foot' },
              el('span', {}, `${host.label(o)} · ${o.pages.length} p.`),
              el(
                'button',
                {
                  class: 'btn small',
                  title: 'Horen deze twee bij dezelfde leerling (bijv. een apart gescande uitwerkbijlage)? Maak er één toets van.',
                  onclick: () => merge([d, o], sid!),
                },
                '⤓ Samenvoegen',
              ),
            ),
          ),
        ),
      ),
    );
    pump();
  }

  function renderLast() {
    const d = last && docOf(last.id);
    if (!d) {
      lastEl.replaceChildren();
      return;
    }
    const bad = isProblem(d);
    lastEl.replaceChildren(
      `✓ Zojuist: ${host.label(d)} → `,
      el('b', { class: bad ? 'bad' : '' }, (d.student === undefined ? '(gewist)' : labelOf(d.student)) + (bad ? ' ⚠' : '')),
      ' ',
      el('button', { class: 'linkbtn', onclick: () => go(d.id) }, 'bekijk'),
      ' · ',
      el('kbd', {}, 'Ctrl+Z'),
      ' ongedaan',
    );
  }

  // ── Leerlinglijst kiezen ──
  async function loadFile(f: File) {
    try {
      const rows = readTable(new Uint8Array(await f.arrayBuffer()), f.name);
      useRoster(rosterFromRows(rows, f.name));
    } catch (e) {
      host.toast(e instanceof Error ? e.message : String(e));
    }
  }
  function useRoster(r: Roster) {
    if (!r.students.length) return host.toast('Geen namen gevonden in deze lijst');
    const had = !!matchState.roster;
    const { kept, lost } = setRoster(r, host.docs());
    host.toast(
      `✓ ${r.students.length} leerlingen (${r.columns})` + (had ? ` · ${kept} koppeling${kept === 1 ? '' : 'en'} behouden${lost ? `, ${lost} niet gevonden` : ''}` : ''),
    );
    history.length = 0;
    host.changed();
    const cd = curDoc();
    go((cd.student === undefined ? cd : (items().find((d) => d.student === undefined) ?? cd)).id);
  }
  function showLoader(back: boolean) {
    mainEl.hidden = true;
    loader.hidden = false;
    dlg.classList.add('loading');
    const file = el('input', { type: 'file', accept: '.csv,.txt,.tsv,.xlsx', hidden: true }) as HTMLInputElement;
    file.addEventListener('change', () => {
      if (file.files?.[0]) loadFile(file.files[0]);
    });
    const paste = el('textarea', { rows: '5', placeholder: 'Of plak hier de namen: één per regel, of gekopieerd uit Excel (met kopregel).' }) as HTMLTextAreaElement;
    const r = matchState.roster;
    loader.replaceChildren(
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'Leerlinglijst'),
        el('p', { class: 'note' }, 'Kies de lijst van de klas. Daarna koppel je elke toets met een paar toetsaanslagen aan een leerling. De lijst blijft alleen in dit tabblad en wordt nergens opgeslagen; de koppeling komt in het sleutelbestand.'),
        el('button', { class: 'drop mt-drop', onclick: () => file.click() }, el('strong', {}, '📋 Kies een CSV- of Excel-bestand (.xlsx)'), 'of sleep het hierheen'),
        file,
        paste,
        el(
          'div',
          { class: 'mt-loader-btns' },
          el('button', {
            class: 'btn',
            onclick: () => {
              if (paste.value.trim()) useRoster(rosterFromRows(parseCsv(paste.value), 'geplakte lijst'));
              else paste.focus();
            },
          }, 'Geplakte namen gebruiken'),
          el('button', {
            class: 'linkbtn',
            title: 'Lijst met verzonnen namen die bij de voorbeeldtoetsen past',
            onclick: async () => {
              const { demoRosterCsv } = await import('./demo');
              useRoster(rosterFromRows(parseCsv(demoRosterCsv()), 'voorbeeldlijst'));
            },
          }, '🧪 voorbeeldlijst'),
          el('span', { class: 'spacer' }),
          back && r ? el('button', { class: 'btn', onclick: () => render() }, 'Terug') : null,
        ),
        el('p', { class: 'note' }, 'Herkende kolommen: Naam (of Roepnaam/Voornaam + Tussenvoegsel + Achternaam), en zo mogelijk Leerlingnummer en Klas. "Achternaam, Voornaam" mag ook. Oude .xls-bestanden: sla ze eerst op als .xlsx of .csv.'),
        r ? el('p', { class: 'note' }, `Huidige lijst: ${r.students.length} leerlingen uit ${r.source} (${r.columns}). Bij een andere lijst blijven koppelingen behouden als leerlingnummer of naam overeenkomt.`) : null,
      ),
    );
  }

  // ── Overzicht ──
  function openOv() {
    ovOpen = true;
    ov.hidden = false;
    const list = items();
    const card = (cls: string, title: string, sub: string, docs: MatchDoc[], extra?: HTMLElement | null) =>
      el(
        'div',
        { class: 'mt-sc ' + cls },
        el('h4', {}, el('span', {}, title), el('small', {}, sub)),
        ...docs.map((d) =>
          el(
            'button',
            {
              class: 'mt-sc-img',
              title: `${host.label(d)} – klik om erheen te gaan`,
              onclick: () => {
                closeOv();
                go(d.id);
              },
            },
            cropImg(d),
            el('small', {}, host.label(d)),
          ),
        ),
        extra ?? null,
      );
    const bad: HTMLElement[] = [];
    const good: HTMLElement[] = [];
    const none: Student[] = [];
    for (const s of students()) {
      const ds = list.filter((d) => d.student === s.id);
      const t = `${s.name}${meta(s) ? ` · ${meta(s)}` : ''}`;
      if (ds.length > 1)
        bad.push(
          card('bad', t, `⚠ ${ds.length} toetsen`, ds, el('button', { class: 'btn small', onclick: () => { closeOv(); merge(ds, s.id); }, title: 'Alle toetsen van deze leerling samenvoegen tot één' }, '⤓ Samenvoegen tot één toets')),
        );
      else if (ds.length) good.push(card('good', t, '✓', ds));
      else none.push(s);
    }
    const open = list.filter((d) => d.student === undefined);
    const unk = list.filter((d) => d.student === UNK);
    const body = el('div', { class: 'mt-ov-body' });
    body.append(...bad);
    if (open.length) body.append(card('warn', 'Nog niet gekoppeld', `${open.length} toets${open.length === 1 ? '' : 'en'}`, open));
    if (none.length)
      body.append(
        el('div', { class: 'mt-sc warn' }, el('h4', {}, el('span', {}, 'Leerlingen zonder toets'), el('small', {}, String(none.length))), el('div', { class: 'mt-none' }, none.map((s) => s.name).join(' · '))),
      );
    if (unk.length) body.append(card('warn', 'Niet in lijst / onleesbaar', `${unk.length} toets${unk.length === 1 ? '' : 'en'}`, unk));
    if (good.length) {
      const det = el('details', { class: 'mt-okcards' }, el('summary', {}, `✓ ${good.length} leerling${good.length === 1 ? '' : 'en'} in orde – klik om te tonen`), el('div', { class: 'inner' }, ...good));
      body.append(det);
    }
    const info = bad.length ? `⚠ ${bad.length} leerling(en) met meer dan één toets` : open.length || unk.length ? `${open.length + unk.length} toets(en) om na te lopen` : 'Alles klopt ✓';
    ov.replaceChildren(
      el(
        'div',
        { class: 'mt-ov-card' },
        el('div', { class: 'dhead' }, el('h2', {}, 'Overzicht per leerling'), el('button', { class: 'btn icon', onclick: () => closeOv(), 'aria-label': 'Sluiten' }, '✕')),
        body,
        el('div', { class: 'dfoot' }, el('span', { class: 'note' }, info), el('span', { class: 'spacer' }), el('button', { class: 'btn', onclick: () => downloadKey() }, '🗝 Sleutel (CSV)'), el('button', { class: 'btn primary', onclick: () => closeOv() }, 'Sluiten (Esc)')),
      ),
    );
    pump();
  }
  function closeOv() {
    ovOpen = false;
    ov.hidden = true;
    ov.replaceChildren();
    q.focus();
  }
  function toggleHelp(on: boolean) {
    help.hidden = !on;
    if (on)
      help.replaceChildren(
        el(
          'div',
          { class: 'mt-help-card' },
          el('h3', {}, 'Sneltoetsen'),
          el(
            'table',
            {},
            ...(
              [
                ['a–z', 'Typ de eerste letters van voor- of achternaam, initialen (bijv. "lv" of "tvdb") of cijfers van het leerlingnummer'],
                ['↵', 'Koppel – alleen als er precies één naam past'],
                ['1 2 3', 'Kies een naam als er meerdere passen'],
                ['↑ ↓', 'Kies zelf een naam in de lijst, daarna ↵'],
                ['← → / PgUp PgDn', 'Vorige / volgende toets (scrollwiel werkt ook)'],
                ['Tab / ⇧Tab', 'Volgende / vorige nog niet gekoppelde toets'],
                ['⌫ (leeg veld)', 'Koppeling wissen'],
                ['Ctrl+Z', 'Ongedaan maken'],
                ['Esc', 'Typveld leegmaken / waarschuwing annuleren / venster sluiten'],
                ['⇧↵', 'Getypte naam toevoegen als nieuwe leerling'],
                ['Ctrl+↵', 'Niet in lijst / onleesbaar'],
                ['Ctrl+O', 'Overzicht per leerling'],
                ['? (leeg veld)', 'Dit venster'],
              ] as const
            ).map(([k, t]) => el('tr', {}, el('td', {}, el('kbd', {}, k)), el('td', {}, t))),
          ),
          el('p', { class: 'note' }, 'Muis: klik op een naam om te koppelen of op een toets onderaan om erheen te gaan. Klik ergens om dit venster te sluiten.'),
        ),
      );
    else q.focus();
  }

  function downloadKey() {
    const list = items();
    const p = problems().length;
    const open = list.filter((d) => d.student === undefined).length;
    if ((p || open) && !confirm(`${p ? `Er ${p === 1 ? 'is' : 'zijn'} nog ${p} toets${p === 1 ? '' : 'en'} met een dubbele koppeling (rood). ` : ''}${open ? `${open} toets${open === 1 ? ' is' : 'en zijn'} nog niet gekoppeld. ` : ''}Toch het sleutelbestand downloaden?`)) {
      q.focus();
      return;
    }
    host.downloadKey();
    q.focus();
  }

  function close() {
    if (!alive) return;
    dlg.close();
  }

  // ── Toetsenbord en muis ──
  q.addEventListener('input', () => {
    sel = 0;
    picked = false;
    suggested = false;
    confirmFor = null;
    renderList();
  });
  dlg.addEventListener('cancel', (e) => e.preventDefault()); // Esc zelf afhandelen
  dlg.addEventListener('keydown', (e) => {
    if (!help.hidden) {
      e.preventDefault();
      toggleHelp(false);
      return;
    }
    if (ovOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeOv();
      }
      return;
    }
    if (!loader.hidden) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (matchState.roster) render();
        else close();
      }
      return;
    }
    if ((e.target as HTMLElement).closest('button') && e.key === 'Enter') return;
    const empty = !q.value;
    const k = e.key;
    if (k === 'Enter') {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) return assign(UNK);
      if (e.shiftKey) return addTyped();
      if (confirmFor !== null) return assign(confirmFor);
      if (empty) {
        host.toast('Typ eerst de eerste letters van de naam');
        return updateBig(true);
      }
      if (!matches.length) {
        host.toast('Geen leerling gevonden – ⇧↵ voegt de naam toe');
        return updateBig(true);
      }
      if (matches.length === 1 || picked) tryAssign(matches[sel].s.id);
      else updateBig(true); // meerdere namen: kies met een cijfer
    } else if (/^[1-9]$/.test(k) && !empty && matches.length > 1 && !picked && !e.ctrlKey && !e.altKey && !/\d/.test(q.value)) {
      e.preventDefault();
      const n = Number(k) - 1;
      if (n < Math.min(MAXC, matches.length)) tryAssign(matches[n].s.id);
      else updateBig(true);
    } else if (k === '?' && empty) {
      e.preventDefault();
      toggleHelp(true);
    } else if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      if (!matches.length || empty) return;
      const dn = k === 'ArrowDown';
      sel = picked ? (sel + (dn ? 1 : -1) + matches.length) % matches.length : dn ? 0 : matches.length - 1;
      picked = true;
      confirmFor = null;
      renderList();
    } else if (k === 'PageDown' || (k === 'ArrowRight' && (empty || e.ctrlKey))) {
      e.preventDefault();
      step(1);
    } else if (k === 'PageUp' || (k === 'ArrowLeft' && (empty || e.ctrlKey))) {
      e.preventDefault();
      step(-1);
    } else if (k === 'Home' && e.ctrlKey) {
      e.preventDefault();
      go(items()[0].id);
    } else if (k === 'End' && e.ctrlKey) {
      e.preventDefault();
      go(items()[items().length - 1].id);
    } else if (k === 'Tab') {
      e.preventDefault();
      goNextOpen(e.shiftKey ? -1 : 1);
    } else if (k === 'Backspace' && empty) {
      e.preventDefault();
      // Staat deze toets nog open, dan de vorige wissen (net gekoppeld en doorgesprongen).
      if (!unassign(curDoc())) {
        const list = items();
        const prev = list[list.findIndex((d) => d.id === curId) - 1];
        if (prev && prev.student !== undefined) {
          curId = prev.id;
          unassign(prev);
          go(prev.id);
        }
      }
    } else if (k === 'Escape') {
      e.preventDefault();
      if (confirmFor !== null) {
        confirmFor = null;
        updateBig();
      } else if (q.value) {
        resetInput();
        renderList();
      } else close();
    } else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
    } else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'o') {
      e.preventDefault();
      openOv();
    } else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement !== q) q.focus();
  });
  let wheelLock = 0;
  stage.addEventListener(
    'wheel',
    (e) => {
      if ((e.target as HTMLElement).closest('.mt-compare')) return;
      e.preventDefault();
      const t = Date.now();
      if (t - wheelLock < 110) return;
      wheelLock = t;
      step(e.deltaY > 0 ? 1 : -1);
    },
    { passive: false },
  );
  film.addEventListener(
    'wheel',
    (e) => {
      if (film.scrollWidth > film.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        film.scrollLeft += e.deltaY;
      }
    },
    { passive: false },
  );
  // Een lijst op het venster slepen; niet als toets toevoegen.
  for (const t of ['dragenter', 'dragover', 'dragleave'] as const)
    dlg.addEventListener(t, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  dlg.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const f = [...(e.dataTransfer?.files ?? [])].find((x) => /\.(csv|txt|tsv|xlsx|xls)$/i.test(x.name));
    if (f) loadFile(f);
    else host.toast('Sleep hier een leerlinglijst (CSV of .xlsx). Toetsen voeg je toe in het hoofdvenster.');
  });
  const onResize = () => updateBig();
  window.addEventListener('resize', onResize);
  dlg.addEventListener('close', () => {
    alive = false;
    window.removeEventListener('resize', onResize);
    // Uitsneden van documenten die niet meer bestaan opruimen.
    const live = new Set(host.docs().map(cropKey));
    for (const k of cropCache.keys()) if (!live.has(k)) cropCache.delete(k);
    dlg.remove();
    host.changed();
  });

  document.body.append(dlg);
  dlg.showModal();
  const start = (startId && docOf(startId)) || items().find((d) => d.student === undefined) || items()[0];
  curId = start.id;
  if (matchState.roster) go(start.id);
  else showLoader(false);
}
