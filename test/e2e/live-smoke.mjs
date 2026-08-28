// Live-extension smoke test — the REAL inject → handshake path, no shims.
//
// The unit suite and the screenshot harness both drive dist/ through
// chrome-API shims, which is how two defects shipped to two stores without
// the real path ever running: the first-hello race (every first inspection
// failed) and the dead-port suspension failure. This script loads the PACKED
// extension into a real Chromium and asserts the one thing a shim cannot:
// that a bridge `status` against a Fuaran page connects ON THE FIRST ATTEMPT.
//
// It drives the bridge from the extension's own service worker via
// `chrome.tabs.sendMessage` — the same API hop the background router uses for
// a panel request — because DevTools-panel UI automation is not scriptable.
// The panel-side port lifecycle (reconnect across worker suspension) is unit
// tested in test/connection.test.ts.
//
// Prereqs, mirroring docs/screenshot-harness/capture.mjs:
//   pnpm build                                     (the packed extension in dist/)
//   npm i --no-save puppeteer-core                 (not a repo dependency)
//   node test/e2e/live-smoke.mjs
//
// Browser: set FUARAN_SHOTS_BROWSER to a Chrome/Edge executable; defaults to
// the standard Windows Edge path. Extensions need real (or "new"-headless)
// Chromium — never the "shell" headless the screenshot harness uses.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import puppeteer from 'puppeteer-core';

const ROOT = resolve(import.meta.dirname, '../..');
// FUARAN_E2E_DIST points the run at another packed build — how this test is
// proven able to fail: pointed at the shipped v0.1.1 zip's contents, it
// reports the first-hello race as 'no-peer' and exits 1.
const DIST = process.env.FUARAN_E2E_DIST ?? join(ROOT, 'dist');
const BROWSER =
  process.env.FUARAN_SHOTS_BROWSER ??
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

if (!existsSync(join(DIST, 'manifest.json')))
  fail('no dist/manifest.json — run `pnpm build` first.');
if (!existsSync(BROWSER)) fail(`no browser at ${BROWSER} — set FUARAN_SHOTS_BROWSER.`);

// ─── A tiny static server for the harness test page ─────────────────
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (request, response) => {
  try {
    const path = join(ROOT, new URL(request.url, 'http://x').pathname);
    const body = await readFile(path);
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'text/plain' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const pageUrl = `http://127.0.0.1:${server.address().port}/docs/screenshot-harness/test-page.html`;

// ─── Launch with the packed extension ───────────────────────────────
const browser = await puppeteer.launch({
  executablePath: BROWSER,
  headless: false,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
});

try {
  const workerTarget = await browser.waitForTarget(
    (target) =>
      target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'),
    { timeout: 15_000 },
  );
  const worker = await workerTarget.worker();

  const page = await browser.newPage();
  await page.goto(pageUrl, { waitUntil: 'networkidle0' });

  // The FIRST status against a fresh page. Before the fix this reliably came
  // back 'no-peer': the hello raced the relay injection and was lost.
  const status = await worker.evaluate(async () => {
    // A zero-permission extension cannot see tab URLs (`tabs.url` is gated on
    // the "tabs" permission this manifest deliberately lacks), so identify the
    // test page the way the router would: probe each tab's content script and
    // keep the answers. Only the test page has one to answer with.
    const tabs = await chrome.tabs.query({});
    const answers = [];
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          $fuaranDevtools: 1,
          dir: 'request',
          id: 1,
          method: 'status',
        });
        if (response !== undefined) answers.push(response);
      } catch {
        // No content script in that tab — not the test page.
      }
    }
    if (answers.length !== 1) return { error: `expected 1 answering tab, got ${answers.length}` };
    return answers[0];
  });

  if (status?.error !== undefined) fail(status.error);
  if (status?.ok !== true) fail(`bridge error: ${JSON.stringify(status)}`);
  const result = status.result;
  if (result.state !== 'connected')
    fail(
      `first status was '${result.state}' (${result.message ?? 'no message'}) — expected 'connected' on the FIRST attempt.`,
    );
  if (result.markedElements !== 13)
    fail(`expected 13 marked elements on the test page, saw ${result.markedElements}.`);

  console.log(
    `PASS: first-attempt handshake connected — host '${result.host}', profile '${result.profile}', ` +
      `${result.markedElements} marked elements, capabilities [${(result.capabilities ?? []).join(', ')}].`,
  );
} finally {
  await browser.close();
  server.close();
}
