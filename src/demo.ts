// Voorbeeldbestanden met VERZONNEN namen, volledig in de browser gemaakt.
// Hiermee kan iedereen de app uitproberen zonder echte leerlinggegevens.
import { PDFDocument } from 'pdf-lib';

interface Student {
  last: string;
  first: string;
  nr: string;
  klas: string;
}

const STUDENTS: Student[] = [
  { last: 'Jansen', first: 'Piet', nr: '204517', klas: '4B' },
  { last: 'Bakker', first: 'Lotte', nr: '203998', klas: '4B' },
  { last: 'Amrani', first: 'Fatima', nr: '205133', klas: '4C' },
];

const HAND = '"Segoe Print", "Bradley Hand", "Comic Sans MS", "Chalkboard SE", cursive';
const PRINT = 'Arial, Helvetica, sans-serif';

function jitter(n: number) {
  return (Math.random() - 0.5) * n;
}

function handText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color = '#1d3a9e') {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = `${size}px ${HAND}`;
  ctx.translate(x, y);
  ctx.rotate(jitter(0.03));
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, lineTo: number) {
  ctx.fillStyle = '#777';
  ctx.font = `22px ${PRINT}`;
  ctx.fillText(text, x, y);
  const w = ctx.measureText(text).width;
  ctx.strokeStyle = '#aaa';
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(x + w + 8, y + 4);
  ctx.lineTo(lineTo, y + 4);
  ctx.stroke();
  ctx.setLineDash([]);
  return x + w + 16;
}

function grid(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  ctx.strokeStyle = '#d6dbe0';
  ctx.lineWidth = 1;
  for (let x = x0; x <= x1; x += 38) {
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
  }
  for (let y = y0; y <= y1; y += 38) {
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
  }
}

function page(s: Student, withHeader: boolean, answers: string[]): HTMLCanvasElement {
  // A4 staand, 150 dpi
  const c = document.createElement('canvas');
  c.width = 1240;
  c.height = 1754;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fdfdfb';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.textBaseline = 'alphabetic';
  let top = 120;
  if (withHeader) {
    ctx.fillStyle = '#222';
    ctx.font = `bold 30px ${PRINT}`;
    ctx.fillText('Proefwerk natuurkunde – hoofdstuk 3 (VOORBEELD)', 90, 90);
    let x = label(ctx, 'Naam:', 90, 170, 700);
    handText(ctx, `${s.first} ${s.last}`, x + 10, 165, 46);
    x = label(ctx, 'Klas:', 760, 170, 900);
    handText(ctx, s.klas, x + 6, 165, 42);
    x = label(ctx, 'Leerlingnummer:', 90, 240, 520);
    handText(ctx, s.nr, x + 10, 236, 40);
    label(ctx, 'Datum:', 760, 240, 1150);
    handText(ctx, '12-11', 860, 236, 38);
    ctx.fillStyle = '#333';
    ctx.fillRect(80, 290, 1080, 3);
    top = 330;
  }
  grid(ctx, 90, top, 1150, 1660);
  let y = top + 70;
  for (const a of answers) {
    handText(ctx, a, 120, y, 36);
    y += 114;
  }
  return c;
}

async function canvasJpeg(c: HTMLCanvasElement) {
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('jpeg'))), 'image/jpeg', 0.8));
  return new Uint8Array(await blob.arrayBuffer());
}

const ANSWERS = [
  ['1  v = Δx / Δt = 100 / 9,8 = 10,2 m/s', '2  F = m · a = 70 · 2,5 = 175 N', '3  Ek = ½ m v² = 3,6 kJ'],
  ['4  P = E / t = 3600 / 12 = 300 W', '5  zie grafiek: t = 5 s', '6  η = 0,58'],
];

/** Pagina's van één leerling: voorblad met naam en een vervolgblad zonder. */
async function addStudent(pdf: PDFDocument, s: Student) {
  for (const c of [page(s, true, ANSWERS[0]), page(s, false, ANSWERS[1])]) {
    const img = await pdf.embedJpg(await canvasJpeg(c));
    const p = pdf.addPage([595.28, 841.89]);
    p.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
  }
}

/** Drie losse PDF's, één per leerling. */
export async function makeDemoFiles(): Promise<File[]> {
  const files: File[] = [];
  for (const s of STUDENTS) {
    const pdf = await PDFDocument.create();
    await addStudent(pdf, s);
    const bytes = await pdf.save();
    files.push(new File([bytes as BlobPart], `${s.last.toLowerCase()} ${s.first.toLowerCase()}.pdf`, { type: 'application/pdf' }));
  }
  return files;
}

/** Eén PDF met de hele (voorbeeld)klas achter elkaar gescand: 4 leerlingen × 2 pagina's. */
export async function makeClassDemoFile(): Promise<File> {
  const pdf = await PDFDocument.create();
  for (const s of [...STUDENTS, { last: 'de Vries', first: 'Sem', nr: '204871', klas: '4B' }]) await addStudent(pdf, s);
  const bytes = await pdf.save();
  return new File([bytes as BlobPart], 'scan klas 4B natuurkunde.pdf', { type: 'application/pdf' });
}

/** Gedrukte vragen per blad (verschillend per blad, zonder woorden die op labels lijken). */
const SHEET_ANSWERS = [
  ['HCl + NaOH → NaCl + H₂O', 'zie berekening hieronder', 'gelijke hoeveelheden'],
  ['180 g/mol', 'negentig gram', 'omdat het polair is'],
  ['CO₂ en water', 'kalkwater wordt troebel', 'volledige verbranding'],
  ['heen en terug even snel', 'verschuift naar links', 'verlaagt de activeringsenergie'],
];
const SHEETS = [
  ['Een oplossing van zoutzuur reageert met natronloog.', 'Geef de reactievergelijking van deze neutralisatie.', 'Bereken hoeveel natronloog er nodig is.'],
  ['Bereken de molaire massa van glucose.', 'Hoeveel gram glucose bevat een halve mol?', 'Leg uit waarom suiker oplost in water.'],
  ['Methaan verbrandt volledig met zuurstof.', 'Welke producten ontstaan bij deze verbranding?', 'Beschrijf een proef om koolstofdioxide aan te tonen.'],
  ['Beschrijf wat een evenwichtsreactie inhoudt.', 'Wat gebeurt er bij een hogere temperatuur?', 'Leg de werking van een katalysator uit.'],
];

/** Blad met kop (naam op elk blad) en gedrukte vragen met handgeschreven antwoorden. */
function sheet(s: Student, nr: number, questions: string[]): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 1240;
  c.height = 1754;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fdfdfb';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#222';
  ctx.font = `bold 28px ${PRINT}`;
  ctx.fillText(`Scheikunde – hoofdstuk 5   (${nr}/4)`, 90, 90);
  let x = label(ctx, 'Naam:', 90, 170, 700);
  handText(ctx, `${s.first} ${s.last}`, x + 10, 165, 44);
  x = label(ctx, 'Klas:', 760, 170, 900);
  handText(ctx, s.klas, x + 6, 165, 40);
  ctx.fillStyle = '#333';
  ctx.fillRect(80, 220, 1080, 3);
  let y = 300;
  questions.forEach((q, i) => {
    ctx.fillStyle = '#222';
    ctx.font = `26px ${PRINT}`;
    ctx.fillText(`${(nr - 1) * 3 + i + 1}.  ${q}`, 90, y);
    handText(ctx, SHEET_ANSWERS[nr - 1][i], 140, y + 90, 34);
    y += 420;
  });
  return c;
}

/** Eén leerling, 4 verschillende bladen met op elk blad de naam: mag NIET gesplitst worden. */
export async function makeMultiSheetDemoFile(): Promise<File> {
  const pdf = await PDFDocument.create();
  const s: Student = { last: 'de Vries', first: 'Sem', nr: '204871', klas: '4B' };
  for (let i = 0; i < SHEETS.length; i++) {
    const img = await pdf.embedJpg(await canvasJpeg(sheet(s, i + 1, SHEETS[i])));
    pdf.addPage([595.28, 841.89]).drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
  }
  const bytes = await pdf.save();
  return new File([bytes as BlobPart], 'toets scheikunde h5 (één leerling).pdf', { type: 'application/pdf' });
}
