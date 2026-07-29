// ============================================================================
//  panel/history — the recording surface: undo, redo, export, reset.
//
//  Session-level rather than node-level, so it lives in its own strip under the
//  breadcrumb rather than inside the selected node's card: a recording spans
//  the page, and putting it in the card would make it look like a property of
//  whichever node happened to be selected.
//
//  Three things this surface refuses to do, each an honesty rule rather than a
//  styling one:
//
//   * It never shows an enabled Undo that would fail. When the last edit has no
//     recoverable inverse, the button is disabled and the REASON is on screen —
//     "a removed subtree cannot be restored", not a greyed rectangle.
//   * It never claims the export is a replayable session log. The line beside
//     the button says what the document carries and what it does not.
//   * It says out loud that a recording does not survive a reload, beside the
//     button that would have saved it. That is where the information is worth
//     something; in a README it is worth nothing at the moment it is needed.
// ============================================================================

import { el, note } from './dom.js';
import type { TrailView } from '../trail/recorder.js';

export interface HistoryContext {
  readonly view: TrailView;
  /** True when the page offers `apply` — nothing here works without it. */
  readonly canApply: boolean;
  undo(): void;
  redo(): void;
  exportTrail(): void;
  reset(): void;
}

const button = (
  label: string,
  disabled: boolean,
  onClick: () => void,
  className = 'field-commit',
): HTMLButtonElement => {
  const control = el('button', className, label);
  control.type = 'button';
  control.disabled = disabled;
  control.addEventListener('click', onClick);
  return control;
};

export const renderHistory = (context: HistoryContext): HTMLElement => {
  const strip = el('div', 'history');

  if (!context.canApply) {
    strip.appendChild(el('span', 'history-count', 'no recording'));
    strip.appendChild(note('This page offers no apply capability — there is nothing to record.'));
    return strip;
  }

  const view = context.view;
  strip.appendChild(
    el(
      'span',
      'history-count',
      view.recorded === 0
        ? 'nothing recorded yet'
        : `${view.applied} applied${view.undone > 0 ? ` · ${view.undone} undone` : ''}`,
    ),
  );

  strip.appendChild(button('Undo', view.undoable === undefined, () => context.undo()));
  strip.appendChild(button('Redo', view.redoable === undefined, () => context.redo()));
  strip.appendChild(button('Export', view.applied === 0, () => context.exportTrail()));
  strip.appendChild(
    button('New recording', view.recorded === 0, () => context.reset(), 'field-commit danger'),
  );

  // The last applied edit, named, so Undo says what it will undo.
  const last = view.entries[view.entries.length - 1];
  if (last !== undefined) strip.appendChild(el('span', 'history-last', `last: ${last.reason}`));

  if (view.undoBlocked !== undefined)
    strip.appendChild(el('span', 'history-why', view.undoBlocked));

  if (view.interrupted)
    strip.appendChild(
      el(
        'span',
        'history-why',
        'Another writer has changed this page. Undo stops at that point, and anything that was ' +
          'undone before it can no longer be redone.',
      ),
    );

  if (view.applied > 0)
    strip.appendChild(
      el(
        'span',
        'history-why',
        'Export writes the ops and their attributed hash chain. It carries no base or final tree ' +
          '— this relay profile cannot read one — so it is a provenance record, not a replayable ' +
          'session. The recording is lost on reload; export first.',
      ),
    );

  return strip;
};

/**
 * Hand the document to the browser as a download.
 *
 * A blob URL and an anchor, rather than `chrome.downloads`: that API needs a
 * `downloads` permission, and this extension's manifest requests none at all.
 * Keeping it that way is worth more than a nicer save dialog.
 */
export const downloadDocument = (filename: string, contents: string): void => {
  const blob = new Blob([contents], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoked on the next turn: revoking synchronously can race the download in
  // some builds, and the object would otherwise be held for the panel's life.
  setTimeout(() => URL.revokeObjectURL(url), 0);
};
