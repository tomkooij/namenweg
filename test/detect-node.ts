// Detectietest in Node op lokaal gerenderde pagina's (zie test/render-pages.py).
// Gebruik: npx tsx test/detect-node.ts <map> [filter]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { createWorker, PSM } from 'tesseract.js';
import { findNameWords, nameTokensFromFileName, refineWithInk, completeFromPeers, findLabels, InkMask, parsePhrases, regionsFor, type OcrWord, type PeerPage } from '../src/detect-core';
import { DEFAULT_SETTINGS } from '../src/types';

const dir = process.argv[2];
const filter = process.argv[3] ?? '';
const S = DEFAULT_SETTINGS;
const scanNames = readdirSync('scans');
const phrases = parsePhrases(S);
const worker = await createWorker('nld+eng', 1, { langPath: join(process.cwd(), 'public/tesseract/lang'), gzip: false, cacheMethod: 'none' });
await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });

const report: Record<string, { labels: string[]; regions: { kind: string; x0: number; y0: number; x1: number; y1: number; derived?: boolean }[] }> = {};
const peers: (PeerPage & { f: string; W: number; H: number })[] = [];
for (const f of readdirSync(dir).filter((f) => /^[a-z]+-\d+\.png$/.test(f) && f.includes(filter)).sort()) {
  const r = await worker.recognize(join(dir, f.replace('.png', '.enh.png')), {}, { blocks: true, text: false });
  const words: OcrWord[] = [];
  let line = 0;
  for (const b of r.data.blocks ?? [])
    for (const p of b.paragraphs)
      for (const l of p.lines) {
        line++;
        for (const w of l.words) words.push({ text: w.text, conf: w.confidence, ...w.bbox, line });
      }
  const labels = findLabels(words, phrases);
  const png = PNG.sync.read(readFileSync(join(dir, f)));
  const mask = new InkMask({ data: png.data, width: png.width, height: png.height }, 2);
  const regions = regionsFor(labels, mask, png.width, png.height, S.padding);
  const orig = scanNames.find((n) => n.startsWith(f.slice(0, 5))) ?? '';
  const nameHits = findNameWords(words, nameTokensFromFileName(orig, S));
  if (nameHits.length) console.log('  NAAM-WOORDEN', f, nameHits.map((n) => `${n.text}@${Math.round(n.rect.x0)},${Math.round(n.rect.y0)}`).join(' '));
  peers.push({
    f,
    W: png.width,
    H: png.height,
    wPt: png.width,
    hPt: png.height,
    boxes: regions.map((g, i) => ({ id: String(i), x: g.rect.x0 / png.width, y: g.rect.y0 / png.height, w: (g.rect.x1 - g.rect.x0) / png.width, h: (g.rect.y1 - g.rect.y0) / png.height, kind: g.kind, source: 'auto', rot: 0, text: false, label: g.label, ax: g.anchor.x / png.width, ay: g.anchor.y / png.height })),
  });
  report[f] = { labels: labels.map((l) => `${l.kind}:${l.text}(${Math.round(l.conf)})`), regions: regions.map((g) => ({ kind: g.kind, ...g.rect })) };
  console.log(f, labels.map((l) => `${l.kind}:${l.text}`).join(' | '), '→', regions.map((g) => `${g.kind}[${Math.round(g.rect.x0)},${Math.round(g.rect.y0)},${Math.round(g.rect.x1)},${Math.round(g.rect.y1)}]`).join(' '));
}
for (const { page, box } of completeFromPeers(peers)) {
  const pp = page as (typeof peers)[number];
  const png = PNG.sync.read(readFileSync(join(dir, pp.f)));
  Object.assign(box, refineWithInk(new InkMask({ data: png.data, width: png.width, height: png.height }, 2), png.width, png.height, box));
  const r = { kind: box.kind, x0: box.x * pp.W, y0: box.y * pp.H, x1: (box.x + box.w) * pp.W, y1: (box.y + box.h) * pp.H, derived: true };
  report[pp.f].regions.push(r);
  console.log('AANGEVULD', pp.f, box.kind, [r.x0, r.y0, r.x1, r.y1].map(Math.round).join(','), box.label);
}
writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 1));
await worker.terminate();
