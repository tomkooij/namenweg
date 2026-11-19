export type BoxKind = 'naam' | 'nummer' | 'klas' | 'handmatig';
export type Rot = 0 | 90 | 180 | 270;

/** Rechthoek in genormaliseerde paginacoördinaten (0..1), in weergave-oriëntatie. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Box extends Rect {
  id: string;
  kind: BoxKind;
  source: 'auto' | 'handmatig';
  /** Leesrichting van de tekst in dit vak (graden met de klok mee). */
  rot: Rot;
  /** Komt de vervangende tekst ("Kandidaat 67") in dit vak? */
  text: boolean;
  /** Herkend label (alleen informatief, bv. "Naam kandidaat"). */
  label?: string;
  /** Linkerbovenhoek van het gedrukte label (genormaliseerd), om pagina's te vergelijken. */
  ax?: number;
  ay?: number;
}

export type DetectState = 'nog niet' | 'bezig' | 'klaar' | 'fout' | 'overgeslagen';

export interface PageState {
  index: number;
  /** Afmetingen in punten (1/72 inch), na rotatie. */
  wPt: number;
  hPt: number;
  boxes: Box[];
  detect: DetectState;
  detectNote?: string;
  thumb?: string;
  /** Extra rotatie door de gebruiker (met de klok mee). */
  userRot?: Rot;
  /** Door de gebruiker gecontroleerd en in orde bevonden. */
  checked?: boolean;
  /** Gedraaide oriëntaties zijn al doorzocht (of niet nodig). */
  rotChecked?: boolean;
}

export interface Settings {
  template: string;
  numMin: number;
  numMax: number;
  fill: 'wit' | 'zwart';
  textColor: string;
  exportDpi: number;
  jpegQuality: number;
  grayscale: boolean;
  autoDetect: boolean;
  searchRotated: boolean;
  ocrDpi: number;
  ocrWorkers: number;
  stampEveryPage: boolean;
  stampPosition: 'rechtsboven' | 'linksboven' | 'rechtsonder' | 'linksonder';
  keyCsv: boolean;
  combined: boolean;
  fileNameTemplate: string;
  kwNaam: string;
  kwNummer: string;
  kwKlas: string;
  kwStop: string;
  detectNummer: boolean;
  detectKlas: boolean;
  padding: number;
  showLabels: boolean;
  searchFileNames: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  template: 'Kandidaat {n}',
  numMin: 10,
  numMax: 99,
  fill: 'wit',
  textColor: '#1a3fb0',
  exportDpi: 200,
  jpegQuality: 0,
  grayscale: false,
  autoDetect: true,
  searchRotated: true,
  ocrDpi: 200,
  ocrWorkers: 0,
  stampEveryPage: false,
  stampPosition: 'rechtsboven',
  keyCsv: true,
  combined: false,
  fileNameTemplate: '{tekst}',
  kwNaam: 'naam, naam kandidaat, kandidaat, naam leerling, achternaam, voornaam, name, kandidaatnaam, leerlingnaam, student',
  kwNummer: 'examen no, examen nr, examen, examennummer, kandidaat nr, kandidaatnummer, leerling nr, leerlingnummer, llnr, lln nr, studentnummer, student nr, exam no, candidate number',
  kwKlas: 'klas, groep, stamgroep, class',
  kwStop: 'examenvak, vak, datum, date, docent, blad, pagina, cijfer, score, school, gymnasium, coornhert, toets, onderwerp, niveau',
  detectNummer: true,
  detectKlas: true,
  padding: 0.5,
  showLabels: true,
  searchFileNames: true,
};
