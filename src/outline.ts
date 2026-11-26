// Inhoudsopgave (bladwijzers) in een PDF schrijven: waar begint elke kandidaat? Alleen de
// vervangende tekst ("Kandidaat 67"), nooit namen.
import { PDFDocument, PDFHexString, PDFName, type PDFRef } from 'pdf-lib';

export interface OutlineEntry {
  title: string;
  /** Pagina (0-based) waar dit onderdeel begint. */
  page: number;
}

export function addOutline(pdf: PDFDocument, entries: OutlineEntry[]) {
  const pages = pdf.getPages();
  const list = entries.filter((e) => e.page >= 0 && e.page < pages.length);
  if (!list.length) return;
  const ctx = pdf.context;
  const root = ctx.nextRef();
  const refs: PDFRef[] = list.map(() => ctx.nextRef());
  list.forEach((e, i) => {
    ctx.assign(
      refs[i],
      ctx.obj({
        Title: PDFHexString.fromText(e.title),
        Parent: root,
        Dest: [pages[e.page].ref, 'Fit'],
        ...(i > 0 ? { Prev: refs[i - 1] } : {}),
        ...(i < refs.length - 1 ? { Next: refs[i + 1] } : {}),
      }),
    );
  });
  ctx.assign(root, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: list.length }));
  pdf.catalog.set(PDFName.of('Outlines'), root);
  // PDF-lezers tonen de bladwijzers dan meteen in de zijbalk.
  pdf.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}
