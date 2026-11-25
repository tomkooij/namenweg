import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { execSync } from 'node:child_process';

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}
const COMMIT = process.env.GITHUB_SHA || git('rev-parse HEAD');

/**
 * Na het bouwen: zet de lijst met ALLE app-bestanden (en een versie) in dist/sw.js, zodat de
 * service worker alles bij de installatie in één keer opslaat en de app daarna volledig
 * offline werkt, ook als bepaalde onderdelen (OCR, pdf.js-decoders) nog nooit gebruikt zijn.
 */
function precacheManifest(): Plugin {
  // Niet nodig in de browser: licenties, en OCR-varianten zonder LSTM (de app gebruikt alleen LSTM).
  const skip = [/(^|\/)LICENSE/, /^sw\.js$/, /^tesseract\/core\/tesseract-core(-simd|-relaxedsimd)?\.wasm\.js$/, /quickjs/];
  return {
    name: 'namenweg-precache',
    apply: 'build',
    closeBundle() {
      const dist = 'dist';
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          if (statSync(p).isDirectory()) walk(p);
          else files.push(relative(dist, p).split(sep).join('/'));
        }
      };
      walk(dist);
      const list = files.filter((f) => !skip.some((r) => r.test(f))).sort();
      const swPath = join(dist, 'sw.js');
      // Ook de service worker zelf meetellen: gewijzigd gedrag = nieuwe cache.
      const hash = createHash('sha256').update(readFileSync(swPath));
      for (const f of list) hash.update(f).update(readFileSync(join(dist, f)));
      const version = hash.digest('hex').slice(0, 12);
      const sw = readFileSync(swPath, 'utf8')
        .replace("const VERSION = 'dev';", `const VERSION = '${version}';`)
        .replace('const PRECACHE = [];', `const PRECACHE = ${JSON.stringify(list)};`);
      if (!sw.includes(version)) throw new Error('sw.js: VERSION-placeholder niet gevonden');
      writeFileSync(swPath, sw);
      const mb = list.reduce((a, f) => a + statSync(join(dist, f)).size, 0) / 1e6;
      console.log(`Offline-cache: ${list.length} bestanden, ${mb.toFixed(1)} MB (versie ${version})`);
    },
  };
}

export default defineConfig({
  base: './',
  define: { __COMMIT__: JSON.stringify(COMMIT) },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  plugins: [precacheManifest()],
  server: { port: 5178 },
});
