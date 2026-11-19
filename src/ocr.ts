// Lokale tekstherkenning met Tesseract (WebAssembly). Engine en taalmodellen worden
// vanaf dezelfde website geladen als de app; er gaat geen beeldmateriaal de computer uit.
import { createWorker, PSM, OEM, type Worker } from 'tesseract.js';
import { assetUrl } from './pdfio';

export type { OcrWord } from './detect-core';
import type { OcrWord } from './detect-core';

type Task = { canvas: HTMLCanvasElement; resolve: (w: OcrWord[]) => void; reject: (e: unknown) => void };

let workers: Worker[] = [];
let starting: Promise<void> | null = null;
let wanted = 2;
const idle: Worker[] = [];
const queue: Task[] = [];
let statusCb: (msg: string) => void = () => {};

export function onOcrStatus(cb: (msg: string) => void) {
  statusCb = cb;
}

export function defaultWorkerCount() {
  const c = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(4, Math.floor(c / 2)));
}

export function setWorkerCount(n: number) {
  wanted = n > 0 ? n : defaultWorkerCount();
}

async function start() {
  if (starting) return starting;
  starting = (async () => {
    statusCb('OCR-engine laden (eenmalig, lokaal)…');
    const opts = {
      workerPath: assetUrl('tesseract/worker.min.js'),
      corePath: assetUrl('tesseract/core'),
      langPath: assetUrl('tesseract/lang'),
      workerBlobURL: false,
      gzip: false,
      cacheMethod: 'none',
    };
    const made = await Promise.all(
      Array.from({ length: wanted }, async () => {
        const w = await createWorker('nld+eng', OEM.LSTM_ONLY, opts);
        await w.setParameters({
          tessedit_pageseg_mode: PSM.SPARSE_TEXT,
          preserve_interword_spaces: '1',
        });
        return w;
      }),
    );
    workers = made;
    idle.push(...made);
    statusCb('');
  })();
  try {
    await starting;
  } catch (e) {
    starting = null;
    throw e;
  }
}

function pump() {
  while (idle.length && queue.length) {
    const w = idle.pop()!;
    const t = queue.shift()!;
    run(w, t.canvas)
      .then(t.resolve, t.reject)
      .finally(() => {
        idle.push(w);
        pump();
      });
  }
}

async function run(w: Worker, canvas: HTMLCanvasElement): Promise<OcrWord[]> {
  const res = await w.recognize(canvas, {}, { blocks: true, text: false });
  const out: OcrWord[] = [];
  let line = 0;
  for (const b of res.data.blocks ?? []) {
    for (const p of b.paragraphs) {
      for (const l of p.lines) {
        line++;
        for (const wd of l.words) {
          out.push({
            text: wd.text,
            conf: wd.confidence,
            x0: wd.bbox.x0,
            y0: wd.bbox.y0,
            x1: wd.bbox.x1,
            y1: wd.bbox.y1,
            line,
          });
        }
      }
    }
  }
  return out;
}

export async function recognize(canvas: HTMLCanvasElement): Promise<OcrWord[]> {
  await start();
  return new Promise((resolve, reject) => {
    queue.push({ canvas, resolve, reject });
    pump();
  });
}

export async function terminateOcr() {
  const ws = workers;
  workers = [];
  idle.length = 0;
  starting = null;
  await Promise.all(ws.map((w) => w.terminate()));
}
