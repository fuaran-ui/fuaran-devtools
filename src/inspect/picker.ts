// ============================================================================
//  inspect/picker — click-to-select in the page.
//
//  While picking, hovering previews the node under the cursor and a click
//  selects it. Both listeners are registered in the CAPTURE phase and the
//  selecting click is swallowed (`preventDefault` + `stopPropagation` +
//  `stopImmediatePropagation`), so picking a button does not also press it —
//  an inspector that fires the app's own handlers is not an inspector.
//
//  Escape cancels. Every listener is removed by the returned disposer, so a
//  cancelled pick leaves the page exactly as it found it.
// ============================================================================

import { nodeIdForElement } from './detect.js';

export interface PickerHandlers {
  /** The node under the cursor changed (`undefined` — nothing marked there). */
  readonly onHover: (nodeId: string | undefined) => void;
  /** A node was clicked. */
  readonly onPick: (nodeId: string) => void;
  /** Picking ended without a selection (Escape, or a click on bare page). */
  readonly onCancel: () => void;
}

/**
 * Start picking. Returns a disposer that stops picking; calling it twice is
 * safe, and the picker calls it itself once a pick or cancel has fired.
 */
export const startPicking = (doc: Document, handlers: PickerHandlers): (() => void) => {
  let stopped = false;
  let last: string | undefined;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    doc.removeEventListener('mousemove', onMove, true);
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKey, true);
  };

  const onMove = (event: Event): void => {
    const nodeId = nodeIdForElement(event.target as Element | null);
    if (nodeId === last) return;
    last = nodeId;
    handlers.onHover(nodeId);
  };

  const onClick = (event: Event): void => {
    const nodeId = nodeIdForElement(event.target as Element | null);
    // Swallow the click whether or not it landed on a node: while picking, the
    // page must not receive pointer input at all.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    stop();
    if (nodeId === undefined) handlers.onCancel();
    else handlers.onPick(nodeId);
  };

  const onKey = (event: Event): void => {
    if ((event as KeyboardEvent).key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    stop();
    handlers.onCancel();
  };

  doc.addEventListener('mousemove', onMove, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKey, true);
  return stop;
};
