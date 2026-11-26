// Alleen verzonnen namen.
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { decodeText, fixCommaName, makeStudent, parseCsv, readTable, rosterFromRows, search, suggestFromFileName } from '../../src/roster';

const list = ['Lieke Visser', 'Sam Bakker', 'Sem van Dijk', 'Tess van den Berg', 'Zoë van Leeuwen', 'Milan Vos', 'Mila Vos', 'Noa de Boer', 'Noah Smit'].map((n, i) =>
  makeStudent(n, `s${i + 1}`, i + 1, String(9001 + i)),
);
const names = (q: string, taken?: (s: (typeof list)[number]) => boolean) => search(list, q, taken).map((m) => m.s.name);

describe('zoeken', () => {
  it('begin van voor- of achternaam', () => {
    expect(names('lie')).toEqual(['Lieke Visser']);
    expect(names('viss')).toEqual(['Lieke Visser']);
  });
  it('meerdere stukjes', () => {
    expect(names('s bak')).toEqual(['Sam Bakker']);
  });
  it('initialen, met of zonder tussenvoegsels', () => {
    expect(names('lv')[0]).toBe('Lieke Visser');
    expect(names('tvdb')[0]).toBe('Tess van den Berg');
    expect(names('tb')[0]).toBe('Tess van den Berg');
  });
  it('accenten maken niet uit', () => {
    expect(names('zoe')).toEqual(['Zoë van Leeuwen']);
  });
  it('bijna gelijke namen: beide, tenzij volledig uitgetypt', () => {
    expect(names('mila')).toEqual(['Mila Vos', 'Milan Vos']);
    expect(names('mila vos')).toEqual(['Mila Vos']);
  });
  it('al gekoppeld zakt in de volgorde', () => {
    expect(names('no', (s) => s.name === 'Noa de Boer')).toEqual(['Noah Smit', 'Noa de Boer']);
  });
  it('leerlingnummer', () => {
    expect(names('9003')).toEqual(['Sem van Dijk']);
  });
  it('lege zoekopdracht geeft iedereen', () => {
    expect(names('')).toHaveLength(list.length);
  });
});

describe('bestandsnaam', () => {
  it('vindt de leerling uit de bestandsnaam', () => {
    expect(suggestFromFileName(list, 'visser lieke.pdf')?.name).toBe('Lieke Visser');
    expect(suggestFromFileName(list, 'scan 4B dijk sem (deel 2).pdf')?.name).toBe('Sem van Dijk');
  });
  it('niets bij twijfel of geen naam', () => {
    expect(suggestFromFileName(list, 'vos.pdf')).toBeNull();
    expect(suggestFromFileName(list, 'scan klas 4B.pdf')).toBeNull();
  });
});

describe('CSV', () => {
  it('puntkomma, kolom Naam, extra kolommen', () => {
    const r = rosterFromRows(parseCsv('Volgnummer;Leerlingnummer;E-mail;Naam;Klas\n1;9001;a@b.nl;Sam Bakker;4B\n2;9002;c@d.nl;"Vries, Sem de";4B\n'));
    expect(r.students.map((s) => [s.name, s.nr, s.klas, s.pos])).toEqual([
      ['Sam Bakker', '9001', '4B', 1],
      ['Sem de Vries', '9002', '4B', 2],
    ]);
    expect(r.columns).toBe('Naam, Leerlingnummer, Klas');
  });
  it('losse naamkolommen, kopregel niet bovenaan, komma als scheidingsteken', () => {
    const csv = 'Klassenlijst 4B,,,\n\nRoepnaam,Tussenvoegsel,Achternaam,Stamnummer\nTess,van den,Berg,9004\nMilan,,Vos,9006\n';
    const r = rosterFromRows(parseCsv(csv));
    expect(r.students.map((s) => s.name)).toEqual(['Tess van den Berg', 'Milan Vos']);
    expect(r.students[0].nr).toBe('9004');
  });
  it('zonder kopregel: kolom met namen', () => {
    const r = rosterFromRows(parseCsv('1;Lieke Visser\n2;Sam Bakker\n'));
    expect(r.students.map((s) => s.name)).toEqual(['Lieke Visser', 'Sam Bakker']);
  });
  it('aanhalingstekens en tabs', () => {
    expect(parseCsv('a\tb\n"x\ty"\t"he ""zei"""\n')).toEqual([
      ['a', 'b'],
      ['x\ty', 'he "zei"'],
    ]);
  });
  it('oude Excel-CSV in Windows-1252', () => {
    const bytes = new Uint8Array([0x5a, 0x6f, 0xeb]); // "Zoë"
    expect(decodeText(bytes)).toBe('Zoë');
  });
  it('komma-namen', () => {
    expect(fixCommaName('Berg, Tess van den')).toBe('Tess van den Berg');
    expect(fixCommaName('Lieke Visser')).toBe('Lieke Visser');
  });
});

describe('Excel (.xlsx)', () => {
  function xlsx(sheet: string, shared: string[]) {
    return zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Lijst" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/sharedStrings.xml': strToU8(`<sst>${shared.map((s) => `<si>${s}</si>`).join('')}</sst>`),
      'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${sheet}</sheetData></worksheet>`),
    });
  }
  it('leest gedeelde teksten, getallen, inline tekst en lege cellen', () => {
    const bytes = xlsx(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>9001</v></c></row>' +
        '<row r="3"><c r="A3" t="inlineStr"><is><t>Zo&#235; van Leeuwen</t></is></c><c r="B3"/><c r="C3"><v>9005</v></c></row>',
      ['<t>Naam</t>', '<t>Leerlingnummer</t>', '<r><t>Lieke </t></r><r><t>Visser</t></r>'],
    );
    const rows = readTable(bytes, 'lijst.xlsx');
    expect(rows).toEqual([
      ['Naam', '', 'Leerlingnummer'],
      ['Lieke Visser', '', '9001'],
      ['Zoë van Leeuwen', '', '9005'],
    ]);
    const r = rosterFromRows(rows);
    expect(r.students.map((s) => `${s.name} ${s.nr}`)).toEqual(['Lieke Visser 9001', 'Zoë van Leeuwen 9005']);
  });
  it('oud .xls-formaat: duidelijke melding', () => {
    expect(() => readTable(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), 'lijst.xls')).toThrow(/xlsx/);
  });
});
