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
> (React Developer Tools, Vue.js devtools). The suggested alternatives do not fit this class of
> extension: `activeTab` is granted only by a gesture on the extension itself (toolbar click,
> context menu, command), which opening a DevTools panel is not, and it would require adding the
> `scripting` permission to inject — strictly more privilege than the current manifest, which
> requests no permissions at all. Site-scoping is impossible by definition for a developer tool
> that attaches to the page under inspection. The content script's first act on any page is a
> passive check for Fuaran-rendered markup (`data-fuaran-node-id` attributes); on a page without
> it, nothing is injected, no listener is registered, and no further work happens. The extension
> cannot read browsing history, storage, or cookies, and performs no network requests.

## Edge Add-ons listing

Same zip, same copy — the sections above fill Edge's Partner Center forms one-to-one. What follows
is only what Edge asks for beyond the CWS set.

**Assets** (in [`store-assets/`](store-assets/)):

| Field                          | Value                                                           |
| ------------------------------ | --------------------------------------------------------------- |
| Store logo (300×300, required) | `store-assets/logo-300.png`                                     |
| Promotional tile (440×280)     | `store-assets/promo-440x280.png`                                |
| Screenshots                    | the same two 1280×800 shots from [`screenshots/`](screenshots/) |

**Properties:**

| Field              | Value                                                             |
| ------------------ | ----------------------------------------------------------------- |
| Category           | Developer tools                                                   |
| Privacy policy URL | https://github.com/fuaran-ui/fuaran-devtools/blob/main/PRIVACY.md |
| Website            | https://github.com/fuaran-ui/fuaran-devtools                      |
| Support contact    | https://github.com/fuaran-ui/fuaran-devtools/issues               |
| Search terms       | fuaran, devtools, inspector, typed tree, ui debugging             |

**Notes for certification** _(Edge's reviewer-facing field — testing instructions):_

> This is a DevTools panel for pages rendered by Fuaran hosts (an open UI-as-data format —
> https://github.com/fuaran-ui/fuaran-ui-specification). It requests no permissions, performs no
> network requests, and collects no data.
>
> On any ordinary page the extension is inert by design: the content script's only act is a passive
> check for `data-fuaran-node-id` markup, and without it nothing is injected and no listener is
> registered. To verify this state: open DevTools on any site → the "Fuaran" panel reports "This
> page has no Fuaran-rendered markup."
>
> To see the panel active against a Fuaran page: the extension's public repository carries a
> self-contained test page — clone https://github.com/fuaran-ui/fuaran-devtools, serve the repo
> root (`npx http-server . -p 24190`), and open
> `http://localhost:24190/docs/screenshot-harness/test-page.html` in a tab (no build needed — the
> page is static markup plus a debug host surface). With the extension loaded, the DevTools
> "Fuaran" panel shows the page's typed node tree; selecting nodes highlights them in the page, and
> edits round-trip through the page's own gated apply path.
>
> The content script matches `<all_urls>` because a DevTools panel must attach to whatever page the
> developer is inspecting; `activeTab` does not fit (no qualifying gesture exists for opening a
> DevTools panel, and it would require adding the `scripting` permission — more privilege, not
> less). This is the established pattern of framework devtools (React Developer Tools, Vue.js
> devtools).
