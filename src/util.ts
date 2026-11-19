export const uid = () => crypto.getRandomValues(new Uint32Array(2)).join('-');

/** Cryptografisch willekeurig geheel getal in [min, max]. */
export function randInt(min: number, max: number) {
  const range = max - min + 1;
  const limit = Math.floor(0x100000000 / range) * range;
  const buf = new Uint32Array(1);
  let v: number;
  do {
    crypto.getRandomValues(buf);
    v = buf[0];
  } while (v >= limit);
  return min + (v % range);
}

/** Kies een uniek nummer dat nog niet in `used` zit; vergroot het bereik als het vol is. */
export function uniqueNumber(min: number, max: number, used: Set<number>) {
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  while (used.size >= hi - lo + 1 || countFree(lo, hi, used) === 0) hi = hi * 10 + 9;
  for (;;) {
    const n = randInt(lo, hi);
    if (!used.has(n)) return n;
  }
}

function countFree(lo: number, hi: number, used: Set<number>) {
  let c = 0;
  for (const u of used) if (u >= lo && u <= hi) c++;
  return hi - lo + 1 - c;
}

export function fillTemplate(t: string, n: number) {
  return t.replace(/\{n\}/g, String(n)).replace(/\{nn\}/g, String(n).padStart(2, '0')).replace(/\{nnn\}/g, String(n).padStart(3, '0'));
}

export function safeFileName(s: string) {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'document';
}

export function download(data: Blob | Uint8Array, name: string, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function csvCell(v: string | number) {
  const s = String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: (string | number)[][]) {
  // Puntkomma als scheidingsteken: opent direct goed in Nederlandse Excel.
  return '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | number | EventListener> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') e.addEventListener(k.replace(/^on/, ''), v as EventListener);
    else if (v === false) continue;
    else if (v === true) e.setAttribute(k, '');
    else if (k === 'class') e.className = String(v);
    else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null && c !== false) e.append(c);
  return e;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
