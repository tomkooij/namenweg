import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, type PDFArray } from 'pdf-lib';
import { addOutline } from '../../src/outline';

/** Bladwijzers teruglezen met pdf-lib: titel en paginanummer. */
function readBack(pdf: PDFDocument) {
  const ctx = pdf.context;
  const root = ctx.lookup(pdf.catalog.get(PDFName.of('Outlines')), PDFDict);
  const pageRefs = pdf.getPages().map((p) => p.ref);
  const out: { title: string; page: number }[] = [];
  let ref = root.get(PDFName.of('First')) as PDFRef | undefined;
  while (ref) {
    const item = ctx.lookup(ref, PDFDict);
    const dest = item.lookup(PDFName.of('Dest')) as PDFArray;
    out.push({ title: (item.lookup(PDFName.of('Title')) as PDFHexString).decodeText(), page: pageRefs.indexOf(dest.get(0) as PDFRef) });
    ref = item.get(PDFName.of('Next')) as PDFRef | undefined;
  }
  return { out, count: (root.lookup(PDFName.of('Count')) as unknown as { asNumber(): number }).asNumber(), mode: pdf.catalog.get(PDFName.of('PageMode'))?.toString() };
}

describe('bladwijzers', () => {
  it('één per kandidaat, op de juiste pagina, ook na opslaan en inlezen', async () => {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 6; i++) pdf.addPage([200, 300]);
    addOutline(pdf, [
      { title: 'Kandidaat 67', page: 0 },
      { title: 'Kandidaat 12', page: 2 },
      { title: 'Kandidaat 5', page: 5 },
      { title: 'Buiten bereik', page: 9 },
    ]);
    const again = await PDFDocument.load(await pdf.save());
    const r = readBack(again);
    expect(r.out).toEqual([
      { title: 'Kandidaat 67', page: 0 },
      { title: 'Kandidaat 12', page: 2 },
      { title: 'Kandidaat 5', page: 5 },
    ]);
    expect(r.count).toBe(3);
    expect(r.mode).toBe('/UseOutlines');
  });
  it('geen bladwijzers: niets toevoegen', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    addOutline(pdf, []);
    expect(pdf.catalog.get(PDFName.of('Outlines'))).toBeUndefined();
  });
});
