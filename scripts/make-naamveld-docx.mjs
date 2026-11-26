// Maakt public/naamveld-sjabloon.docx: naamvelden met geprinte markeringen (twee dichte zwarte
// vierkantjes van 5 mm, linksboven en rechtsonder) die NamenWeg zonder OCR herkent.
// Gebruik: node scripts/make-naamveld-docx.mjs
// Geen extra afhankelijkheden: een .docx is een zip met XML (fflate zit al in het project).
import { writeFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';

const MM = 1440 / 25.4; // twips per mm
const tw = (mm) => Math.round(mm * MM);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const run = (text, { b = false, sz = 22, color } = {}) =>
  `<w:r><w:rPr>${b ? '<w:b/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (runs, { after = 120, before = 0, keepNext = false } = {}) =>
  `<w:p><w:pPr>${keepNext ? '<w:keepNext/>' : ''}<w:spacing w:before="${before}" w:after="${after}"/></w:pPr>${runs}</w:p>`;

/** Lege, minimale alinea (voor de cellen van exact 5 mm hoog). */
const tiny = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr><w:r><w:rPr><w:sz w:val="2"/></w:rPr></w:r></w:p>';
const cell = (wTw, content, { black = false, vAlign } = {}) =>
  `<w:tc><w:tcPr><w:tcW w:w="${wTw}" w:type="dxa"/>${black ? '<w:shd w:val="clear" w:color="auto" w:fill="000000"/>' : ''}${vAlign ? `<w:vAlign w:val="${vAlign}"/>` : ''}</w:tcPr>${content}</w:tc>`;
const row = (hTw, cells) => `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${hTw}" w:hRule="exact"/></w:trPr>${cells}</w:tr>`;

/**
 * Naamveld: tabel van 3 × 3 zonder randen. Hoekcellen linksboven en rechtsonder zijn zwart
 * (5 × 5 mm); in het midden de invulregels met stippellijnen.
 */
function field(widthMm, lines) {
  const m = tw(5);
  const mid = tw(widthMm);
  const lineH = tw(10);
  const midH = lineH * lines.length + tw(2);
  // Invulregel: label, dan een stippellijn tot de volgende tab.
  const fill = lines
    .map((parts) => {
      let pos = 0;
      const tabs = [];
      const runs = [];
      for (const [label, mm] of parts) {
        pos += mm;
        tabs.push(`<w:tab w:val="left" w:leader="dot" w:pos="${tw(pos) - tw(3)}"/>`);
        runs.push(run(label + ' ', { sz: 24 }) + '<w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:tab/></w:r>' + run('  ', { sz: 24 }));
      }
      return `<w:p><w:pPr><w:tabs>${tabs.join('')}</w:tabs><w:spacing w:before="0" w:after="0" w:line="${lineH - tw(1)}" w:lineRule="exact"/><w:ind w:left="${tw(2)}"/></w:pPr>${runs.join('')}</w:p>`;
    })
    .join('');
  const noBorders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="nil"/>`).join('');
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${2 * m + mid}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${noBorders}</w:tblBorders>` +
    `<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid><w:gridCol w:w="${m}"/><w:gridCol w:w="${mid}"/><w:gridCol w:w="${m}"/></w:tblGrid>` +
    row(m, cell(m, tiny, { black: true }) + cell(mid, tiny) + cell(m, tiny)) +
    row(midH, cell(m, tiny) + cell(mid, fill, { vAlign: 'center' }) + cell(m, tiny)) +
    row(m, cell(m, tiny) + cell(mid, tiny) + cell(m, tiny, { black: true })) +
    `</w:tbl>`
  );
}

const body = [
  para(run('Invulvak met markeringen (NamenWeg-sjabloon)', { b: true, sz: 32 }), { after: 160 }),
  para(
    run(
      'Kopieer een van de blokken hieronder naar je toets (voorblad en/of antwoordblad). NamenWeg herkent de twee zwarte vierkantjes en haalt bij het anonimiseren alles daartussen weg, ook als de naam slordig, schuin of over de lijn geschreven is. Daar komt dan "Kandidaat 67" te staan.',
    ),
  ),
  para(run('Let op:', { b: true })),
  para(run('–  Laat de vierkantjes heel en vergroot of verklein het blok niet in Word (5 × 5 mm). Afdrukken op A3 of A4 mag wel.')),
  para(run('–  Houd een paar millimeter wit rond de vierkantjes: geen tekst, lijnen of kaders er direct tegenaan.')),
  para(run('–  Linksboven en rechtsonder horen bij elkaar. Meerdere blokken op één blad kan, als ze niet overlappen.')),
  para(run('–  Scan zoals altijd (150–300 dpi). Een scheef of gedraaid gescande pagina is geen probleem.'), { after: 360 }),

  para(run('Naam en klas', { b: true, sz: 24 }), { keepNext: true }),
  field(130, [[['Naam:', 95], ['Klas:', 35]]]),
  para('', { after: 360 }),

  para(run('Alleen naam', { b: true, sz: 24 }), { keepNext: true }),
  field(100, [[['Naam:', 100]]]),
  para('', { after: 360 }),

  para(run('Naam, klas en leerlingnummer (twee regels)', { b: true, sz: 24 }), { keepNext: true }),
  field(130, [[['Naam:', 130]], [['Klas:', 45], ['Leerlingnummer:', 85]]]),
  para('', { after: 360 }),

  para(run('Gemaakt voor NamenWeg (www.tomkooij.nl/namenweg) – toetsen anonimiseren, volledig lokaal in je browser.', { sz: 18, color: '666666' })),
].join('');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="${tw(210)}" w:h="${tw(297)}"/><w:pgMar w:top="${tw(20)}" w:right="${tw(20)}" w:bottom="${tw(20)}" w:left="${tw(20)}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="nl-NL"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Standaard"><w:name w:val="Normal"/></w:style></w:styles>`;
const files = {
  '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
  '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  'word/document.xml': document,
  'word/styles.xml': styles,
};
const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])), { mtime: new Date('2026-01-01T00:00:00Z') });
const out = process.argv[2] ?? 'public/naamveld-sjabloon.docx';
writeFileSync(out, zip);
console.log(`${out}: ${zip.length} bytes`);
