// Service worker: maakt de app volledig offline bruikbaar. Slaat alleen de app-bestanden zelf
// op (van deze website), nooit gebruikersbestanden.
//
// Bij het bouwen worden VERSION en PRECACHE ingevuld met ALLE app-bestanden (zie
// vite.config.ts): de app-code, de OCR-engine en taalmodellen, en de pdf.js-decoders. Die
// worden bij de installatie in één keer opgeslagen, zodat de app daarna zonder netwerk werkt,
// ook voor onderdelen die nog nooit gebruikt zijn.
const VERSION = 'dev';
const PRECACHE = [];
const CACHE = `namenweg-${VERSION}`;
/** Markering dat alles binnen is; de app toont dan "klaar voor offline gebruik". */
const READY = './__offline-ready';
// ignoreVary: de server stuurt bijv. "Vary: Origin" mee; een module-script stuurt een
// Origin-header, het opslagverzoek niet. Zonder ignoreVary "past" het opgeslagen bestand dan
// niet en faalt de app offline (lege pagina). Het zijn statische bestanden, dus dit is veilig.
const MATCH = { ignoreSearch: true, ignoreVary: true };

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    (async () => {
      const c = await caches.open(CACHE);
      // Eerst de app zelf (moet lukken), dan de grote bestanden (OCR, pdf.js).
      const shell = ['./', ...PRECACHE.filter((f) => !/^(tesseract|pdfjs)\//.test(f))];
      await c.addAll(shell);
      const big = PRECACHE.filter((f) => /^(tesseract|pdfjs)\//.test(f));
      const res = await Promise.allSettled(big.map((f) => c.add(f)));
      if (res.every((r) => r.status === 'fulfilled')) await c.put(READY, new Response('ok'));
    })(),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('namenweg-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Pagina: netwerk eerst (updates), anders uit de cache.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          if (r.ok) {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put('./', copy));
          }
          return r;
        })
        .catch(() => caches.match('./', { ...MATCH, cacheName: CACHE }).then((r) => r || caches.match('./index.html', MATCH))),
    );
    return;
  }
  // fetch()-verzoeken (OCR-taalmodellen, pdf.js-wasm, lettertypes): uit de cache als ze daar
  // staan, anders gewoon van het netwerk. Niet zelf bijschrijven (dat gaf problemen in workers).
  if (e.request.destination === '') {
    e.respondWith(caches.match(e.request, MATCH).then((hit) => hit || fetch(e.request)));
    return;
  }
  // Scripts, opmaak, afbeeldingen: cache eerst.
  e.respondWith(
    caches.match(e.request, MATCH).then(
      (hit) =>
        hit ||
        fetch(e.request).then((r) => {
          if (r.ok) {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return r;
        }),
    ),
  );
});
