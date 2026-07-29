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

It also **edits**, where the page allows it. Select a node and the panel offers a property editor and
a structural palette — insert, remove, move, reorder. Every edit is proposed to the page as a tree-op
and applied by the page's own gated apply path; the panel proposes, the host disposes. A page that
offers no mutation capability is inspected exactly as before, with the edit affordances absent rather
than disabled.

Nothing here is per-kind code. The fields offered for a node and the candidates offered by the
palette are **derived from the canonical wire schema**, so a kind added to the vocabulary shows up
with no change to this extension — and a kind this build has never heard of degrades to read-only
rows with the reason on screen, rather than to an empty panel.

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
| `src/panel/`        | the DevTools panel page    | tree view, breadcrumb, node card, property editor, structural palette                    |
| `src/schema/`       | (pure)                     | derive per-kind fields and minimal-valid candidates from the wire schema                 |
| `src/edit/`         | (pure)                     | compose the tree-ops the panel proposes                                                  |

Only the page peer needs the page's JS world, because a page global is invisible from a content
script. Everything else — the overlay, the picker, the relay client — is ordinary DOM work in the
isolated world, so the privileged surface stays as small as it can be.

Relay traffic never leaves the tab. What crosses to the panel is already-shaped result data on a
separate, extension-private envelope; the relay contract governs the page boundary and nothing else.

### Placement is addressed by id, never by index

An insert or a move is expressed as the node plus, when placement needs it, a reorder naming the
**full** sibling id list — never an integer position. An op carrying a position means something
different depending on what the tree looked like when it was composed, and between composing it and
applying it, anything else driving the page (an AI, another panel, the app itself) can insert a
sibling. The op then lands somewhere nobody chose, successfully. Ids do not have that failure mode,
and the panel's selection is remembered as a path of ids for the same reason: when the tree changes
underneath it, the deepest surviving id wins and the selection still addresses a live node.

### Two peers on one page

A host tier may install its own relay peer. Both peers would then answer the same request — merely
wasteful on the read side, but on the write side a single edit would be **applied twice**. So the
injected peer yields: it watches the traffic it already receives and stands down permanently as soon
as another peer's reply proves one is there.

## Security posture

The relay specification treats this as part of the contract rather than deployment advice, and so
does this implementation:

- **Nothing happens on a page with no Fuaran markup.** No injection, no probe, no listener.
- **The extension adds no capability the page did not already have.** `window.__fuaran` is
  registered by the host itself, only in a debug build, and is already reachable by any script on
  the page — it exists to be typed at in the browser console. The injected peer wraps it in a
  structured envelope; it opens no new door.
- **Every mutation crosses the host's own gate.** The extension contributes no apply engine, no
  validator and no policy of its own. `window.__fuaran.apply` is the host's already-registered,
  policy-gated path — gate, decode, apply, validate, fold — and the peer maps its outcomes onto the
  contract's refusal classes and nothing more.
- **Capability is derived from the page, never assumed.** The peer advertises `apply` only when the
  host says it wired one, and `subscribe` only when the surface exposes one. A host that wired
  neither is inspected read-only, which the contract declares fully conformant.
- **Refusals are kept distinct.** A validation rejection, a policy denial and an absent capability
  each mean a different thing for the user to do, and the panel renders each differently. Collapsing
  them into one red line would send someone to fix a tree that was never the problem.
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

Change events are driven from the other end: take a subscription, make the host change, and compare
what the peer put on the wire. Nothing asks for an event, so a request-driven runner cannot reach one
— and without this leg the peer could advertise a subscription, answer it, and emit nothing at all
while every other fixture still passed.

Beside the corpus, two suites carry the write side:

- **op shapes**, asserted on bytes — an op is not environment-specific, and a renamed field or a
  silently-added leg is exactly the regression worth catching. The last test there is a negative
  sweep over every op the suite emits, checking that no integer-position key has appeared anywhere.
  A per-op assertion only catches that in the op someone thought to check.
- **end to end**, client → peer → host, against a host holding a real mutable tree: an edit
  round-trips, an insert lands where it was placed, a refused edit leaves the tree byte-identical,
  and a concurrent writer's mutation keeps the panel coherent.

### What the suite does not cover

The `chrome.*` plumbing — the service-worker router, the panel's port, the devtools page — is not
exercised: it needs a real extension host, and a mock of it would assert only that the mock matches
the mock. Verify it by loading the unpacked extension and, on a page whose host wired an apply path:
edit a text field and a numeric field and watch the page re-render; insert a node before a sibling
and confirm the order; attempt an illegal edit and read the refusal class; and mutate the tree from
the browser console (`__fuaran.apply(…)`) while the panel is open, confirming the panel follows
without losing its selection.

## What the panel cannot know

Worth stating plainly, because each of these shapes the UI and none of them is a defect to be worked
around locally:

- **Property values are not readable.** The relay profile's reads answer what is in the tree
  structurally — kind, bound slots, child ids, geometry, one slot's resolved value. None returns a
  node's property values, so the property editor is a **set** surface: a field commits what you type
  and no field claims to show what is there now. The panel says so rather than showing a blank box
  that reads as "currently empty".
- **There is no dry-run.** `apply` applies. A candidate cannot be tried before it is offered, so the
  palette is optimistic: it offers what it can construct and what the schema does not rule out, and
  the host's gate has the last word. The two local gates only ever REMOVE offers — a kind whose
  requirements cannot be synthesised is not offered at all, and a parent the schema says holds no
  children cannot take one.
- **Style is not editable here.** The style op replaces a node's whole style block, and with no read
  of the current one, committing a single token would silently discard the rest. An edit that
  destroys what it cannot see is not worth offering.

A profile that served a node's own wire JSON would close the first and third of these, and make the
second unnecessary. That is a change to the contract, not to this extension, and belongs upstream.

## Dependencies

None at runtime. The relay contract is a specification document, not a package: a relay
implementation is written from the document and needs no host's source. The same reasoning covers
the write side — the op shapes are specified and fixture-pinned, and the contract puts canonical
serialisation on the page peer, so the client sends a structured object and needs no codec.

The extension deliberately takes no dependency on a Fuaran package either. It attaches to whatever
host is on the page, which may be a different tier at a different version; pinning its vocabulary to
one implementation's release cadence would mean tracking that package rather than the format, with
no way to notice the page disagreed.

The one artefact it does carry is **data, not code**: the canonical wire schema, copied into `dist/`
at build time from the specification checkout. It is the same source of truth as the conformance
corpus, shipped alongside it, and its absence is a degraded build rather than a failed one — the
panel then inspects exactly as before and derives no fields.

## Licence

Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
