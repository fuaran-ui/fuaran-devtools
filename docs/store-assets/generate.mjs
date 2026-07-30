// Regenerates every raster brand asset in this repo from the canonical brand
// SVGs — the extension icons in public/icons/ and the store assets beside this
// script. Run it after any brand change, or to add a size.
//
// The brand is canonical in the fuaran-live repo (see its app/brand/ and
// public/brand/), expected as a sibling checkout — the same convention as the
// specification corpus:
//
//   git clone https://github.com/fuaran-ui/fuaran-live ../fuaran-live
//
// Dependencies are not repo dependencies (a plain npm i cannot graft into the
// pnpm layout; the same pattern as the screenshot harness):
//
//   npm i --prefix docs/store-assets @resvg/resvg-js wawoff2
//   node docs/store-assets/generate.mjs        (from the repo root)
//
// Size split, deliberate: at 48px and below the spring mark's dots and ripples
// mud out, so the extension icons carry the favicon design (paper square +
// the italic f) — the same split the brand itself makes between
// fuaran-mark.svg and fuaran-favicon.svg. At 300px and up the mark reads, so
// the store assets carry the real mark and lockup.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import wawoff2 from 'wawoff2';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const LIVE = resolve(REPO, '../fuaran-live');
const ICONS = resolve(REPO, 'public/icons');

const brand = (file) => readFileSync(resolve(LIVE, 'public/brand', file), 'utf8');

// resvg reads ttf/otf, not woff2 — decompress the self-hosted brand font.
const woff2 = readFileSync(resolve(LIVE, 'app/brand/fonts/eb-garamond-500-italic-latin.woff2'));
const ttfPath = resolve(HERE, 'eb-garamond-italic.ttf');
writeFileSync(ttfPath, Buffer.from(await wawoff2.decompress(woff2)));

const font = {
  fontFiles: [ttfPath],
  loadSystemFonts: false,
  defaultFontFamily: 'EB Garamond',
};

const render = (svg, width, out) => {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font }).render().asPng();
  writeFileSync(out, png);
  console.log(`${out.replace(/\\/g, '/').split('/').slice(-2).join('/')} ${png.length} bytes`);
};

// ── Extension icons: the favicon design at 16/32/48/128 ────────────────
mkdirSync(ICONS, { recursive: true });
const favicon = brand('fuaran-favicon.svg');
for (const size of [16, 32, 48, 128]) render(favicon, size, resolve(ICONS, `icon-${size}.png`));

// ── logo-300: the spring mark on the paper ground ──────────────────────
const mark = brand('fuaran-mark.svg')
  .replace(/<\?xml[^?]*\?>\s*/, '')
  .replace(
    /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512" width="512" height="512">/,
    '<svg x="18" y="24" width="264" height="264" viewBox="0 0 512 512">',
  );
render(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300">
  <rect width="300" height="300" rx="46" fill="#EFE9DC"/>
  ${mark}
</svg>`,
  300,
  resolve(HERE, 'logo-300.png'),
);

// ── promo-440x280: the horizontal lockup + the DevTools line ───────────
const lockup = brand('fuaran-horizontal.svg')
  .replace(/<\?xml[^?]*\?>\s*/, '')
  .replace(
    /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 833\.04 400" width="833\.04" height="400">/,
    '<svg x="20" y="6" width="400" height="192" viewBox="0 0 833.04 400">',
  )
  // The lockup's own product tagline gives way to the DevTools line below.
  .replace(/<text[^>]*IBM Plex Mono[^>]*>[\s\S]*?<\/text>/, '');
render(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 280" width="440" height="280">
  <rect width="440" height="280" fill="#EFE9DC"/>
  ${lockup}
  <text x="220" y="228" text-anchor="middle" font-family="'EB Garamond'" font-style="italic"
    font-weight="500" font-size="46" fill="#1E4754">DevTools</text>
  <text x="220" y="258" text-anchor="middle" font-family="'EB Garamond'" font-style="italic"
    font-size="16" fill="#22333B" opacity="0.72">the typed tree, inspected in place</text>
</svg>`,
  440,
  resolve(HERE, 'promo-440x280.png'),
);
