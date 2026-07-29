import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'tsup';

// The canonical wire schema ships WITH the extension, copied from the
// specification checkout rather than vendored into this repo. One home for the
// artefact, beside the conformance corpus the test suite already resolves at
// the same path — so the schema the editor derives from and the fixtures the
// suite runs against can never be two different versions of the format.
//
// Its absence is a DEGRADED BUILD, not a failed one: the panel still inspects,
// still subscribes, still reports refusals, and says plainly that it derived no
// fields. Failing the build here would make the corpus a hard dependency of
// producing an extension at all, which it is not.
const SCHEMA_SOURCE = resolve(__dirname, '../wire-format-fixtures/schema.json');
const SCHEMA_TARGET = resolve(__dirname, 'dist/wire-schema.json');

const copyWireSchema = (): void => {
  if (!existsSync(SCHEMA_SOURCE)) {
    console.warn(
      `[fuaran-devtools] No wire schema at ${SCHEMA_SOURCE}.\n` +
        '  The panel will load without schema-derived fields (read-only property rows).\n' +
        '  Clone the specification repository as a sibling checkout to include it.',
    );
    return;
  }
  copyFileSync(SCHEMA_SOURCE, SCHEMA_TARGET);
};

// Five extension entry points, each bundled as a self-contained classic script.
// MV3 content scripts and the service worker cannot use ESM imports, and the
// page-relay is injected as a plain `<script src>`, so `iife` everywhere keeps
// one load model across the whole extension.
//
// `public/` is the static extension shell (manifest, pages, css) and is copied
// verbatim into `dist/`, which is the load-unpacked root.
export default defineConfig({
  entry: {
    'page-relay': 'src/page-relay.ts',
    content: 'src/content.ts',
    background: 'src/background.ts',
    devtools: 'src/devtools.ts',
    panel: 'src/panel/panel.ts',
  },
  format: ['iife'],
  outExtension: () => ({ js: '.js' }),
  target: 'chrome111',
  dts: false,
  clean: true,
  sourcemap: true,
  treeshake: true,
  publicDir: 'public',
  // After the bundle, because `clean` empties dist/ at the start of a build.
  onSuccess: async () => copyWireSchema(),
});
