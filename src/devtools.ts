// ============================================================================
//  devtools — the `devtools_page` entry: register the "Fuaran" panel.
//
//  Registration is unconditional. A DevTools panel cannot be added lazily once
//  DevTools is already open, so the panel always exists and detects for itself
//  whether the inspected page renders Fuaran — that detection result is what
//  it renders, and its four states are the interesting part of the UI, not an
//  error path (see `bridge.PageState`).
// ============================================================================

chrome.devtools.panels.create('Fuaran', '', 'panel.html');
