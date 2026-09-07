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
//     recoverable inverse, the button is disabled and both the CLASS and the
//     REASON are on screen — "NO_PRIOR_VALUE: … the page refused to encode its
//     root as canonical wire JSON", not a greyed rectangle.
//   * It claims the export is a replayable session log only when it is one. The
//     line beside the button is composed from what the recording actually holds
//     — whether the base tree was captured, and whether another writer has been
//     here — so it says what that document will carry rather than a fixed
//     sentence that was true when it was written.
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

  // The CLASS beside the sentence, exactly as an inline refusal renders one: the
  // prose says what happened, and the class is the part a developer matches
  // against the contract rather than against this panel's phrasing. A page that
  // will not serve a tree read and a batch this build has no inverse for are
  // both "cannot undo", and they are not the same problem.
  if (view.undoBlocked !== undefined) {
    const why = el('span', 'history-why');
    why.appendChild(el('span', 'refusal-class', view.undoBlocked.class));
    why.appendChild(el('span', 'refusal-message', ` ${view.undoBlocked.message}`));
    strip.appendChild(why);
  }

  if (view.interrupted)
    strip.appendChild(
      el(
        'span',
        'history-why',
        'Another writer has changed this page. Undo stops at that point, and anything that was ' +
          'undone before it can no longer be redone.',
      ),
    );

  if (view.applied > 0) strip.appendChild(el('span', 'history-why', exportNote(view)));

  return strip;
};

/**
 * What the export will carry, said before it is pressed.
 *
 * Stated from what is KNOWN at render time and no further. The base tree either
 * was captured or was not, and that is settled; another writer either has been
 * here or has not. The final tree is read at export, so the strongest honest
 * form is "and the final one at export" — a promise about what will be
 * attempted, never about what will succeed.
 */
const exportNote = (view: TrailView): string => {
  const tail = ' The recording is lost on reload; export first.';
  if (!view.baseTree.ok)
    return (
      `Export writes the ops and their attributed hash chain. It carries no base tree — ` +
      `${view.baseTree.reason} — so it is a provenance record, not a replayable session.${tail}`
    );
  if (view.interrupted)
    return (
      'Export writes the base tree, the ops and their attributed hash chain. Another writer has ' +
      'changed this page, so those ops do not by themselves build the tree you see, and the ' +
      `document says so rather than claiming to be a replayable session.${tail}`
    );
  return (
    'Export writes the base tree captured at your first edit, the final one at export, and the ' +
    `ops between them with their attributed hash chain — a replayable session log.${tail}`
  );
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
