// Captures the store-listing screenshots (1280×800) against the harness.
//
// Prereqs: `pnpm build` (the harness runs the real dist/ artifacts), a static
// server on the repo root, and puppeteer-core (not a repo dependency —
// `npm i --no-save puppeteer-core`). Then:
//
//   npx --yes http-server . -p 24190 -c-1 --silent   (from the repo root)
//   node docs/screenshot-harness/capture.mjs
//
// Browser: set FUARAN_SHOTS_BROWSER to a Chrome/Edge executable; defaults to
// the standard Windows Edge path.
import puppeteer from 'puppeteer-core';

const BROWSER =
  process.env.FUARAN_SHOTS_BROWSER ??
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'http://localhost:24190/docs/screenshot-harness/harness.html';
const OUT = 'docs/screenshots';

const browser = await puppeteer.launch({ executablePath: BROWSER, headless: 'shell' });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
await page.goto(URL, { waitUntil: 'networkidle0' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const panelFrame = async () => {
  for (let i = 0; i < 40; i += 1) {
    const frame = page.frames().find((f) => f.url().endsWith('panel-frame.html'));
    if (frame) return frame;
    await sleep(250);
  }
  throw new Error('panel frame never appeared');
};

const panel = await panelFrame();

// The first hello can race the peer injection, exactly as in a live tab:
// press Refresh until connected.
for (let i = 0; i < 10; i += 1) {
  const status = await panel.$eval('#status', (el) => el.textContent ?? '');
  if (status.includes('Connected')) break;
  await panel.$eval('#refresh', (el) => el.click());
  await sleep(600);
}
const status = await panel.$eval('#status', (el) => el.textContent ?? '');
if (!status.includes('Connected')) throw new Error(`never connected: ${status}`);

// ── Shot 1: tree + selected bound node (bindings, geometry, editor) ──
await panel.evaluate(() => {
  const rows = [...document.querySelectorAll('#tree *')].filter((e) =>
    e.textContent?.includes('metric-revenue'),
  );
  rows[rows.length - 1].click();
});
await sleep(900);
await page.screenshot({ path: `${OUT}/shot-1-inspect.png` });
console.log('shot-1-inspect.png');

// ── Shot 2: an applied edit + the recording bar ──────────────────────
await panel.evaluate(() => {
  const rows = [...document.querySelectorAll('#tree *')].filter(
    (e) => e.textContent?.trim() === 'title',
  );
  rows[rows.length - 1].click();
});
await sleep(700);
const edited = await panel.evaluate(() => {
  const card = document.querySelector('#card');
  // Editor rows are `.field` divs reading like "TextSet" / "LevelSet".
  const field = [...card.querySelectorAll('.field')].find((row) =>
    (row.textContent ?? '').startsWith('Text'),
  );
  const textInput = field?.querySelector('input.field-input');
  if (!textInput) return { ok: false, why: 'no Text field input' };
  const proto = Object.getPrototypeOf(textInput);
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(textInput, 'Quarterly review — final');
  textInput.dispatchEvent(new Event('input', { bubbles: true }));
  const set = [...field.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Set');
  if (!set) return { ok: false, why: 'no Set button' };
  set.click();
  return { ok: true };
});
if (!edited.ok) throw new Error(`edit failed: ${edited.why}`);
await sleep(1100);
await page.screenshot({ path: `${OUT}/shot-2-edit-trail.png` });
console.log('shot-2-edit-trail.png');

await browser.close();
