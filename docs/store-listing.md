# Store listing copy

The reviewable, versioned source for the Chrome Web Store and Edge Add-ons listings. The listing is
filled from this file; a change to what the extension does changes this file in the same change-set.

The uploaded zip is always a tagged GitHub Release asset — never a hand-built one. The release
workflow's version gate (tag = `package.json` = `manifest.json`) is what makes the listed version a
claim someone can check.

## Item name

Fuaran DevTools

## Short description

_(CWS limit: 132 characters.)_

> Inspect and edit any Fuaran-rendered page at the typed-tree level: node kinds, bindings, geometry,
> and gated tree-op editing.

## Category

Developer Tools

## Detailed description

> Open DevTools on a page rendered by a Fuaran host and the Fuaran panel shows the typed node tree
> the application is actually running — not a DOM walk. Each node's kind, its bound binding slots
> with their wire-form expressions and resolved values, and its live geometry. Click Select to pick
> a node in the page; hover a row to highlight it. Selection is bidirectional.
>
> Where the page allows it, the panel also edits: a property editor and a structural palette
> (insert, remove, move, reorder), derived entirely from the canonical wire schema — no per-kind
> code, so kinds this build has never seen degrade to read-only rows with the reason on screen.
> Every edit is proposed to the page as a tree-op and applied by the page's own gated apply path:
> the panel proposes, the host disposes. A page that offers no mutation capability is inspected
> read-only, with the edit affordances absent rather than disabled.
>
> Every applied edit is recorded in an attributed, hash-chained op trail you can undo, redo, and
> export as a JSON document. Nothing is persisted and nothing leaves the tab.
>
> What it needs from the page: Fuaran-rendered markup, and the host's debug introspection surface
> (registered by Fuaran hosts in debug builds). The panel reports each of those conditions
> separately when absent.
>
> This extension requests no permissions at all. Free and open source, Apache-2.0:
> https://github.com/fuaran-ui/fuaran-devtools

## Screenshots

_(1280×800, 2–4 of them — to capture against a Fuaran-rendered page with a debug-build host, e.g.
the playground in debug mode.)_

1. The tree view with a node selected in the page and its binding slots open.
2. The property editor + structural palette on an editable page.
3. The op trail with an undo available and the Export button visible.
4. _(optional)_ A refusal rendered by class after an edit the host declined.

## Privacy

**Single purpose.** A DevTools panel for inspecting and editing pages rendered by Fuaran hosts, at
the typed-tree level.

**Data collected: none.** The extension has no storage, no analytics, no network access of its own,
and no remote code. Everything it reads comes from the inspected tab; everything it shows stays in
the DevTools panel. The one export (the op trail) is a user-initiated file download.

**Permissions requested: none.** The manifest's `permissions` array is empty. There is no storage
permission (recordings are deliberately session-only), no host permission grant, and no scripting
permission — the page-side relay peer is delivered as a web-accessible resource.

**Remote code: none.** All code ships in the package.

## Broad-host justification (`<all_urls>` content script)

_(CWS review asks for this whenever a content script matches all sites.)_

> The extension is a DevTools panel: it must be able to attach to whatever page the developer has
> DevTools open on, which cannot be known in advance — the same posture as other framework devtools
> (React Developer Tools, Vue.js devtools). The content script's first act on any page is a passive
> check for Fuaran-rendered markup (`data-fuaran-node-id` attributes); on a page without it, nothing
> is injected, no listener is registered, and no further work happens. The extension requests no
> permissions: it cannot read browsing history, storage, or cookies, and performs no network
> requests.

## Edge Add-ons deltas

Same zip, same copy. Edge's dashboard asks for the same privacy declarations in its own form; the
answers above map one-to-one.
