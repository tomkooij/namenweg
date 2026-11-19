// Kopieert alle runtime-bestanden (OCR-engine, taalmodellen, pdf.js-wasm) naar public/,
// zodat de app NIETS van een CDN of andere externe server laadt.
import { cpSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

const nm = 'node_modules';
const out = 'public/tesseract';
mkdirSync(join(out, 'core'), { recursive: true });
mkdirSync(join(out, 'lang'), { recursive: true });

cpSync(join(nm, 'tesseract.js/dist/worker.min.js'), join(out, 'worker.min.js'));
for (const f of readdirSync(join(nm, 'tesseract.js-core'))) {
  if (f.endsWith('.wasm.js')) cpSync(join(nm, 'tesseract.js-core', f), join(out, 'core', f));
}
for (const lang of ['eng', 'nld']) {
  // Ongecomprimeerd opslaan: sommige servers sturen .gz met Content-Encoding mee, wat
  // dubbel uitpakken veroorzaakt. De webserver comprimeert zelf al tijdens transport.
  const gz = readFileSync(join(nm, `@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`));
  writeFileSync(join(out, 'lang', `${lang}.traineddata`), gunzipSync(gz));
  rmSync(join(out, 'lang', `${lang}.traineddata.gz`), { force: true });
}

const pdfOut = 'public/pdfjs';
for (const dir of ['wasm', 'iccs', 'standard_fonts', 'cmaps']) {
  const src = join(nm, 'pdfjs-dist', dir);
  if (existsSync(src)) cpSync(src, join(pdfOut, dir), { recursive: true });
}
console.log('Assets gekopieerd naar public/');
