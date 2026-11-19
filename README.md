# NamenWeg

**Verwijder namen, examen-/leerlingnummers en klassen uit gescande toetsen – volledig lokaal in je browser.**

👉 **Gebruik de app: https://www.tomkooij.nl/namenweg/**

![Controle-overzicht met voorbeeldtoetsen (verzonnen namen)](docs/controle-overzicht.jpg)

Gescande toetsen bevatten persoonsgegevens. Wil je ze laten nakijken door een collega, delen voor
een analyse of gebruiken als voorbeeld, dan moeten die gegevens eruit. NamenWeg doet dat:

1. Sleep een of meer PDF's (of JPG/PNG-scans) in de app – of klik op **🧪 Probeer met voorbeeld**
   voor drie neptoetsen met verzonnen namen.
2. De app zoekt **automatisch** naar voorgedrukte labels zoals *Naam kandidaat*, *Examen no.*,
   *Kandidaatnummer*, *Leerlingnummer* en *Klas*, en markeert de ingevulde vakken.
3. Controleer per pagina, pas vakken aan of teken er zelf een.
4. Exporteer: de persoonsgegevens worden **écht verwijderd** en vervangen door bijvoorbeeld
   *Kandidaat 67*.

## Privacy

- **Er wordt niets geüpload.** De app is een statische webpagina; bestanden worden alleen in het
  geheugen van je eigen browser geopend.
- **Tekstherkenning (OCR) draait lokaal** met [Tesseract.js](https://github.com/naptha/tesseract.js)
  (WebAssembly). De OCR-engine en de taalmodellen (Nederlands + Engels) worden vanaf dezelfde
  website geladen, niet van een externe CDN.
- Een strikte **Content-Security-Policy** verbiedt de browser om verbinding te maken met andere
  servers.
- Na de eerste keer laden werkt de app ook **offline** (service worker).
- In de browser worden alleen bewaard: instellingen, sjablonen (alleen posities van vakken) en de
  OCR-taalmodellen (openbare data, voor offline gebruik). Nooit scans of namen. Sluit je het
  tabblad, dan zijn alle geopende documenten weg.

## Echt verwijderen

Een zwart vlak óp een PDF leggen is niet veilig: de oorspronkelijke scan zit er nog onder. NamenWeg
bouwt daarom elke pagina opnieuw op:

1. de pagina wordt gerenderd naar pixels;
2. de pixels van de gemarkeerde vakken worden overschreven (wit of zwart) en de vervangende tekst
   wordt erin getekend;
3. alleen díé nieuwe afbeelding gaat in een gloednieuwe PDF – zonder originele beeldlagen,
   tekstlagen of metadata (auteur, scanner, datum, bestandsnaam).

Na de export wordt elk bestand automatisch gecontroleerd: geen tekstlaag, precies één afbeelding per
pagina, en geen namen of de oorspronkelijke bestandsnaam in de metadata (Info en XMP).

## Functies

- Automatische detectie van naam, examen-/leerlingnummer en klas (instelbare trefwoorden),
  ook bij lichtgrijze, gerasterde voorgedrukte labels
- Vakken groeien mee met het handschrift en met invulhokjes onder een label
- Vangnet: mist de OCR een label op één pagina, dan wordt het vak aangevuld op basis van
  dezelfde kop op andere pagina's/documenten
- Zoekt de naam uit de bestandsnaam (bijv. `jansen piet.pdf`) ook elders op de pagina
- Werkt ook op gedraaide pagina's (bijv. liggende uitwerkbijlagen)
- Controle-overzicht: van elke pagina een uitsnede van het eindresultaat in één scherm
- Waarschuwing als een pagina geen vak heeft terwijl dezelfde pagina bij anderen wel vakken heeft
- Sjablonen: vaklayout opslaan en op een volgende klas toepassen (alleen posities, geen namen)
- Vakken tekenen, verplaatsen, schalen, verwijderen; ongedaan maken/opnieuw
- Vakken kopiëren naar alle pagina's / alle documenten
- Willekeurige, unieke kandidaatnummers (niet herleidbaar uit de volgorde)
- Instelbare vervangende tekst (`Kandidaat {n}`), kleur, hoekstempel op elke pagina
- Voorbeeldweergave van het resultaat
- Export per document, als ZIP of als één samengevoegde PDF
- Optioneel sleutelbestand (CSV) om later terug te vinden wie wie was – blijft op je computer
- Resolutie, JPEG-kwaliteit (standaard automatisch: ongeveer even groot als het origineel) en
  grijswaarden instelbaar
- Licht en donker thema, sneltoetsen, offline bruikbaar

## Zelf draaien

```bash
npm install
npm run dev      # ontwikkelserver op http://localhost:5178
npm run build    # productiebuild in dist/
```

Detectie testen op eigen (lokale!) scans in `scans/`:

```bash
npm run test:render   # pagina's renderen naar .testdata/ (vereist Python + PyMuPDF + Pillow)
npm run test:detect   # OCR + detectie in Node, tekent vakken in .testdata/vis-*.png
```

`npm run dev`/`build` kopiëren eerst de OCR-engine, taalmodellen en pdf.js-bestanden naar `public/`
(zie `scripts/copy-assets.mjs`).

> ⚠ Zet nooit echte scans in deze repository. `.gitignore` sluit `scans/`, PDF's, afbeeldingen en
> CSV-bestanden uit.

## Techniek

Vite + TypeScript, [pdf.js](https://mozilla.github.io/pdf.js/) (inlezen/renderen),
[pdf-lib](https://pdf-lib.js.org/) (nieuwe PDF), [Tesseract.js](https://tesseract.projectnaptha.com/)
(OCR), [fflate](https://github.com/101arrowz/fflate) (ZIP).

## Licentie

MIT
