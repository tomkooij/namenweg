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
  /**
   * Vingerafdruk van de gedrukte tekst (goed leesbare woorden), om te zien of pagina's
   * hetzelfde blad zijn. Alleen in het geheugen.
   */
  printed?: string[];
  /** Posities van die gedrukte woorden (genormaliseerd), om bladen uit te lijnen. */
  printedPos?: PrintedAnchor[];
  /** Plek van het kopwoord (bijv. de schoolnaam in het logo), rechtop gelezen; zie Settings.kwKop. */
  kop?: Rect;
  /** Slanke kaders bovenaan (bijv. "NAAM: …… Klas"); ok = bevestigd als naamkader. */
  frames?: SlimFrame[];
}

/** Slank kader bovenaan een pagina (genormaliseerd). */
export interface SlimFrame extends Rect {
  ok: boolean;
}

/** Goed leesbaar gedrukt woord met zijn plek op de pagina (midden, 0..1). */
export interface PrintedAnchor {
  t: string;
  x: number;
  y: number;
}

/**
 * Detectiestrategie: een voorinstelling van de detectiemethoden hieronder. "logo" = alleen de
 * bovenkant (logo, invulblok, naamkader); "volledig" = alles; "eigen" = zelf gekozen.
 */
export type Strategy = 'logo' | 'volledig' | 'eigen';

export interface Settings {
  strategy: Strategy;
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
  /**
   * Kopwoorden (bijv. de schoolnaam in het logo): staat er zo'n woord, dan staan de
   * persoonsgegevens ernaast, ook als het label "Naam" onleesbaar is.
   */
  kwKop: string;
  detectNummer: boolean;
  detectKlas: boolean;
  padding: number;
  showLabels: boolean;
  searchFileNames: boolean;
  /** Eén scan van de hele klas automatisch per leerling opdelen. */
  autoSplit: boolean;
  /** Geprinte markeringen (zwarte vierkantjes op de hoeken van het naamveld) zoeken. */
  detectMarkers: boolean;
  /** Bovenkant: staat het kopwoord (logo) bovenaan, dan de hele bovenkant weghalen. */
  kopStrook: boolean;
  /** Bovenkant: invulblok herkennen aan de labels (Naam: + Vak:/Datum:/Klas:/Examen no.). */
  kopBlok: boolean;
  /** Bovenkant: slank kader met "Naam"/"Klas" erin. */
  kopKader: boolean;
  /** Naamkader: ook zonder leesbaar woord als het elders in de stapel op die plek bevestigd is. */
  kopKaderLeren: boolean;
  /** Naamkader: ruimer lezen (één OCR-fout, extra OCR-ronde op het kader). */
  kopKaderRuim: boolean;
  /** Naamkader: elk zeer slank kader bovenaan (≥ 8:1), ook zonder woord erin. */
  kopKaderVorm: boolean;
  /** Labels overal op de pagina (Naam, Klas, Examen no., …), met tweede OCR-ronde. */
  labels: boolean;
  /** Vangnetten: vakken aanvullen op basis van andere pagina's (zelfde blad, kopwoord). */
  vangnet: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  strategy: 'logo',
  template: 'Kandidaat {n}',
  numMin: 10,
  numMax: 99,
  fill: 'wit',
  textColor: '#1a3fb0',
  exportDpi: 200,
  jpegQuality: 0,
  grayscale: false,
  autoDetect: true,
  searchRotated: false,
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
  kwKop: 'coornhert, gymnasium',
  kwStop: 'examenvak, vak, datum, date, docent, blad, pagina, cijfer, score, school, gymnasium, coornhert, toets, onderwerp, niveau',
  detectNummer: true,
  detectKlas: true,
  padding: 0.5,
  showLabels: true,
  searchFileNames: false,
  autoSplit: true,
  detectMarkers: false,
  kopStrook: true,
  kopBlok: true,
  kopKader: true,
  kopKaderLeren: true,
  kopKaderRuim: true,
  kopKaderVorm: true,
  labels: false,
  vangnet: false,
};

/** De methoden die een strategie aan- of uitzet. */
export const METHOD_KEYS = ['kopStrook', 'kopBlok', 'kopKader', 'kopKaderLeren', 'kopKaderRuim', 'kopKaderVorm', 'detectMarkers', 'labels', 'searchFileNames', 'vangnet', 'searchRotated'] as const;
type MethodKey = (typeof METHOD_KEYS)[number];

export const PRESETS: Record<'logo' | 'volledig', Record<MethodKey, boolean>> = {
  logo: { kopStrook: true, kopBlok: true, kopKader: true, kopKaderLeren: true, kopKaderRuim: true, kopKaderVorm: true, detectMarkers: false, labels: false, searchFileNames: false, vangnet: false, searchRotated: false },
  volledig: { kopStrook: true, kopBlok: true, kopKader: true, kopKaderLeren: true, kopKaderRuim: true, kopKaderVorm: true, detectMarkers: true, labels: true, searchFileNames: true, vangnet: true, searchRotated: true },
};

/** Welke strategie past bij deze instellingen ("eigen" als het geen voorinstelling is). */
export function strategyOf(s: Settings): Strategy {
  for (const k of ['logo', 'volledig'] as const) if (METHOD_KEYS.every((m) => s[m] === PRESETS[k][m])) return k;
  return 'eigen';
}
