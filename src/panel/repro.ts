// ============================================================================
//  panel/repro — the "Copy repro" button: read the board snapshot the page
//  publishes, verify it, put its canonical text on the clipboard, and say what
//  happened in one line. The verification is `repro/boardSnapshot`'s; this
//  module only wires it to the three things a panel holds (the inspected page,
//  the relay's root read, the clipboard), each injected so the whole action is
//  testable without a browser.
// ============================================================================

import { capture, type WireRead } from '../trail/capture.js';
import { asPublishedRecords, reproFrom } from '../repro/boardSnapshot.js';

export interface ReproDeps {
  /** Every published record on the page, as the page evaluation returned them. */
  readonly readPublished: () => Promise<unknown>;
  /** The page's root as canonical wire JSON, or why there is none. */
  readonly readRoot: () => Promise<WireRead>;
  /** Write text to the clipboard; `false` when the write was refused. */
  readonly copy: (text: string) => Promise<boolean>;
}

/** What the button reports. `copied` is true only when the clipboard holds the record. */
export interface ReproReport {
  readonly copied: boolean;
  readonly message: string;
}

export const copyRepro = async (deps: ReproDeps): Promise<ReproReport> => {
  let published: unknown;
  try {
    published = await deps.readPublished();
  } catch {
    return { copied: false, message: 'Copy repro: the page could not be read.' };
  }
  const repro = await reproFrom(
    asPublishedRecords(published),
    await capture(await deps.readRoot()),
  );
  if (!repro.ok) return { copied: false, message: `Copy repro refused: ${repro.reason}.` };
  if (!(await deps.copy(repro.text)))
    return {
      copied: false,
      message: `Copy repro: the clipboard refused the write (${repro.hash}).`,
    };
  return {
    copied: true,
    message: repro.treeChecked
      ? `Copied repro ${repro.hash}.`
      : `Copied repro ${repro.hash} — the page serves no canonical tree, so its tree went unchecked.`,
  };
};

/**
 * The clipboard write a devtools panel can actually make. The async Clipboard
 * API is refused in a panel that does not hold focus, so the selection-based
 * copy is the fallback rather than an afterthought.
 */
export const writeClipboard = async (doc: Document, text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    doc.body.appendChild(area);
    area.select();
    const ok = doc.execCommand('copy');
    area.remove();
    return ok;
  }
};
