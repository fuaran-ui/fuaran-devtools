# fuaran-devtools

A browser extension that inspects a **Fuaran-rendered page at the typed-tree level**.

Open DevTools on a page rendered by any Fuaran host, and the **Fuaran** panel shows the node tree the
app is actually running: each node's kind, its bound binding slots with their wire-form expressions
and resolved values, and its live geometry. Click **Select** to pick a node in the page; hover a row
to highlight it. Selection is bidirectional.

The panel reads the **typed layer**, never the DOM. A DOM walk produces a plausible-looking tree that
is not the one the application is running: one typed node can project to several elements, and the
projection carries neither the node's kind nor its binding slots. Reading the wrong tree is worse
than reading none.

Read-only. This release inspects; it does not edit.

## Status

Early. The extension is not yet published to any browser store — load it unpacked (below).

## Install (unpacked)

```
pnpm install
pnpm build
```

Then in Chrome or Edge: `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select this repo's `dist/` directory. Reload any page you want to inspect afterwards.

On Windows, `pwsh ./run.ps1` does the whole gate — install, format check, typecheck, test, build.

## What it needs from the page

Two things, and the second is the one people miss:

1. **Fuaran-rendered markup.** The renderer marks each rendered node's element with
   `data-fuaran-node-id`. Without it there is nothing to click on, and the panel says so.
2. **The host's in-page debug surface.** Fuaran hosts register a debug-only introspection object on
   the page (`window.__fuaran`) when the app runs in a debug build. That object is what this
   extension reads through.

Those are separate conditions, and the panel keeps them separate: "no Fuaran markup here" and
"Fuaran page, no debug surface exposed" are different states with different fixes. The second is
usually one debug flag away, and reporting it as "nothing here" would send you looking for a problem
that is not there.

## How it works

The extension speaks the **`relay@1.0`** page↔extension contract, specified in
[`DEVTOOLS_RELAY.md`](https://github.com/fuaran-ui/fuaran-ui-specification) alongside the Fuaran UI
wire format. Four pieces:

| Piece               | Where it runs              | Job                                                                                      |
| ------------------- | -------------------------- | ---------------------------------------------------------------------------------------- |
| `src/content.ts`    | extension's isolated world | detect, inject, speak the relay as the **client peer**, draw the overlay, run the picker |
| `src/page-relay.ts` | the page's own JS world    | the relay **page peer** — wraps the host's in-page surface in relay envelopes            |
| `src/background.ts` | MV3 service worker         | route panel ↔ content-script messages for the inspected tab                              |
| `src/panel/`        | the DevTools panel page    | tree view, breadcrumb, node card                                                         |

Only the page peer needs the page's JS world, because a page global is invisible from a content
script. Everything else — the overlay, the picker, the relay client — is ordinary DOM work in the
isolated world, so the privileged surface stays as small as it can be.

Relay traffic never leaves the tab. What crosses to the panel is already-shaped result data on a
separate, extension-private envelope; the relay contract governs the page boundary and nothing else.

## Security posture

The relay specification treats this as part of the contract rather than deployment advice, and so
does this implementation:

- **Nothing happens on a page with no Fuaran markup.** No injection, no probe, no listener.
- **The extension adds no capability the page did not already have.** `window.__fuaran` is
  registered by the host itself, only in a debug build, and is already reachable by any script on
  the page — it exists to be typed at in the browser console. The injected peer wraps it in a
  structured envelope; it opens no new door.
- **Read-only by construction.** The page peer advertises the five read entry points and neither
  advertises nor serves the contract's mutation or subscription entry points. A read-only peer is
  fully conformant.
- **Origin discipline is enforced on both sides.** Messages are posted to the page's own origin and
  never to a wildcard; inbound messages are checked for source, origin, and shape, and anything
  failing is ignored in silence — a refusal sent to an unverified peer is itself a disclosure.
- **Page strings are untrusted in the panel.** Node ids, kinds, binding expressions and resolved
  values all originate in application data. The panel renders them as text and never as markup: a
  DevTools panel is a privileged context, and injecting page-controlled strings into it is the
  classic extension escalation path.
- **Permissions: none.** The manifest requests no `permissions` at all. The page peer is delivered
  as a web-accessible resource rather than through scripting injection, precisely so the extension
  asks for strictly less.

## Development

```
pnpm install
pnpm typecheck      # tsc --noEmit, strict
pnpm test           # vitest — unit + relay conformance
pnpm format         # prettier --write
pnpm build          # tsup -> dist/ (the load-unpacked root)
```

### Conformance

The test suite runs the relay contract's own **fixture corpus** as golden request/response tests, in
both directions: the page peer is driven with each fixture request and its response asserted against
the fixture's declared shape, and the client is driven with each fixture response — including the
ones a read-only peer can never produce, because a client meets hosts it did not build.

The corpus is expected as a sibling checkout:

```
git clone https://github.com/fuaran-ui/fuaran-ui-specification ../wire-format-fixtures
```

A missing corpus fails the suite loudly. A conformance run that quietly passes when its fixtures are
absent turns the one gate that catches a protocol regression into a green tick that means nothing.

Fixtures are compared by **shape and enumerated value, not bytes** — tree revisions, geometry
numbers, resolved values and human-readable messages are environment-specific and legitimately
differ. Asserting byte equality on them would test the fixture author's choices rather than the
implementation.

## Dependencies

None at runtime. The relay contract is a specification document, not a package: a relay
implementation is written from the document and needs no host's source. The extension deliberately
takes no dependency on a Fuaran package either — a client must treat node kinds as opaque tokens and
tolerate ones it has never heard of, so typing them against a fixed vocabulary would be wrong as
well as unnecessary.

## Licence

Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
