import { defineConfig } from 'tsup';

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
});
