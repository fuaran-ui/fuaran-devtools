// ============================================================================
//  inspect/overlay — the highlight overlay.
//
//  Draws an inspect-element-style box over a node's rendered region so the
//  panel's selection is visible in the page.
//
//  NO REFLOW, by construction. The overlay is a single `position: fixed`
//  element appended to `<body>` and removed again; it is taken out of flow, so
//  it cannot displace the app's own layout, and `pointer-events: none` keeps it
//  from intercepting a click meant for the page. This matters more than it
//  looks: an inspector that perturbs the layout it is measuring changes the
//  very geometry `read.renderedDom` reports.
//
//  It runs in the extension's ISOLATED world. A content script shares the page
//  DOM but not its JS world, so the overlay needs no page-context privilege at
//  all — only the page peer, which must reach `window.__fuaran`, does.
// ============================================================================

import { elementForNodeId } from './detect.js';

export const OVERLAY_ID = 'fuaran-devtools-highlight';

const OVERLAY_STYLE = [
  'position:fixed',
  'pointer-events:none',
  'z-index:2147483646',
  'box-sizing:border-box',
  'background:rgba(56,132,255,0.18)',
  'outline:1px solid rgba(56,132,255,0.95)',
  'border-radius:2px',
  'transition:none',
].join(';');

const LABEL_STYLE = [
  'position:absolute',
  'left:0',
  'top:-18px',
  'font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  'background:rgba(56,132,255,0.95)',
  'color:#fff',
  'padding:0 4px',
  'border-radius:2px',
  'white-space:nowrap',
  'pointer-events:none',
].join(';');

/** Remove any overlay this extension drew. Idempotent. */
export const hideHighlight = (doc: Document): void => {
  doc.getElementById(OVERLAY_ID)?.remove();
};

/**
 * Draw the overlay over `nodeId`'s rendered element, labelled with the node id
 * (and its kind, when the caller knows it). Returns `false` when the node has
 * no mounted element — the caller reports "not on screen" rather than silently
 * showing nothing.
 */
export const showHighlight = (doc: Document, nodeId: string, label?: string): boolean => {
  hideHighlight(doc);
  const target = elementForNodeId(doc, nodeId);
  if (target === null || doc.body === null) return false;

  const rect = target.getBoundingClientRect();
  const overlay = doc.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.setAttribute(
    'style',
    `${OVERLAY_STYLE};left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`,
  );

  const caption = doc.createElement('span');
  caption.setAttribute('style', LABEL_STYLE);
  // textContent, never innerHTML: node ids and kinds are application data and
  // therefore untrusted strings (DEVTOOLS_RELAY §11.5).
  caption.textContent = label === undefined ? nodeId : `${label} · ${nodeId}`;
  overlay.appendChild(caption);

  doc.body.appendChild(overlay);
  return true;
};
