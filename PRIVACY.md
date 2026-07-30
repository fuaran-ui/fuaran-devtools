# Privacy policy — Fuaran DevTools

_Last updated: 2026-07-30._

Fuaran DevTools is a browser DevTools panel for inspecting and editing pages rendered by Fuaran
hosts. This policy is short because the extension is built not to have a privacy surface.

## What the extension collects

Nothing.

- **No data leaves your browser.** The extension performs no network requests of its own — no
  analytics, no telemetry, no error reporting, no update checks beyond the browser store's own
  mechanism.
- **No data is stored.** The extension requests no storage permission and keeps nothing between
  page loads. A session recording (the op trail) lives in the DevTools panel's memory and is gone
  when the page or the panel closes.
- **No browsing data is read.** The manifest's `permissions` array is empty: the extension cannot
  read your history, cookies, or storage on any site.

## What the extension reads, and where it goes

When you open its DevTools panel on a page, the extension reads structural information from that
page's own debug introspection surface (node kinds, binding expressions, resolved values, layout
geometry). That information is shown to you in the panel and goes nowhere else. On pages without
Fuaran markup the extension does nothing at all — no injection, no probe, no listener.

The one way anything is written out of the panel is the **Export** button, which downloads the
session's op trail as a JSON file to your machine, at your request. Nothing is uploaded, anywhere,
ever.

## Changes

Any change to this policy lands as a commit to this file in the public repository, alongside the
code change that motivates it.

## Contact

Open an issue at <https://github.com/fuaran-ui/fuaran-devtools/issues>.
