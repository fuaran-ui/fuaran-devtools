# Screenshot harness

Stages the panel against a small hand-styled page for the store-listing screenshots
(`../screenshots/`, 1280×800), without loading the extension into a browser.

Three things are real and one is staged, and the line matters: `content.js`, `page-relay.js`, and
`panel.js` are the **built artifacts from `dist/`, byte-for-byte** — every pixel the panel draws is
the product of real relay traffic through the real bridge protocol. What is staged is the host:
`host.js` is the same shape as the test suite's live host (`test/support/liveHost.ts`) with a real
mutable tree, bindings, DOM-read geometry, and a render projection onto the page's markup — i.e. the
part a Fuaran host supplies, minimally implemented. `chrome-shim-*.js` replace only the MV3
plumbing (`runtime.connect` / `tabs.sendMessage` routing) that the test suite also leaves to manual
verification.

## Run

```
pnpm build
npm i --prefix docs/screenshot-harness puppeteer-core   # its own node_modules — a plain npm i
                                                        # cannot graft into the pnpm layout
npx --yes http-server . -p 24190 -c-1 --silent          # from the repo root
node docs/screenshot-harness/capture.mjs                # writes docs/screenshots/*.png
```

`FUARAN_SHOTS_BROWSER` overrides the browser executable (defaults to the standard Windows Edge
path). Or open `http://localhost:24190/docs/screenshot-harness/harness.html` in any browser and
capture by hand at a 1280×800 viewport.
