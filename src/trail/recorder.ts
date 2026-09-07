// ============================================================================
//  trail/recorder — what this session did to this page, and what it can undo.
//
//  ── Session boundary: what starts and ends a recording ─────────────────────
//
//  The extension did not load the page, does not own it, and cannot outlive it.
//  So the boundary is stated rather than assumed:
//
//   * A recording STARTS at the first tree the panel reads on the current page.
//     That snapshot is the base the trail claims to build on. Starting there
//     rather than at the first edit means the base is the tree as the session
//     found it, which is what "what did I change on this page" means.
//   * A recording ENDS when the page does: a navigation, a reload, or the tab
//     closing. `chrome.devtools.network.onNavigated` resets it, because the
//     tree on the other side of a navigation is a different tree whose node
//     ids mean something else — carrying a trail across would let an op
//     address a node that merely happens to share an id.
//   * A recording is also ended DELIBERATELY, by the panel's reset, when
//     someone wants a clean record of what they are about to do.
//   * A recording does NOT survive any of those. Nothing is persisted, and
//     that is a choice: persistence needs a storage permission, and this
//     extension's manifest requests none at all — a stated security property
//     worth more than surviving a reload. The panel says so where the export
//     button is, so the trade is visible at the moment it matters rather than
//     discovered afterwards.
//
//  ── Only applied ops are recorded ──────────────────────────────────────────
//
//  A refusal is not part of the trail. The contract guarantees a refused op
//  left the tree unchanged (§8.3), so recording one would put an entry in a
//  document whose claim is that its ops built its tree. Local pre-refusals
//  (a value that is not a number, a root with no parent) never reach the relay
//  at all, so they were never candidates.
//
//  ── What is captured, and exactly when ─────────────────────────────────────
//
//  Two wire-JSON reads make an undo exact rather than best-effort, and both are
//  taken at the only moment that makes them true:
//
//   * the BASE TREE, at the session's first edit and BEFORE that edit is
//     applied. It is the page as the session found it, so it answers "what did
//     this field hold before I touched it" for every field the recording never
//     set. Attempted once: a base re-read after some edits had landed would
//     describe a tree the recording did not start from, and would restore values
//     this session itself wrote.
//   * a REMOVED SUBTREE, immediately before the removal that destroys it. After
//     the op there is nothing left to read, which is precisely why the removal
//     used to have no inverse at all.
//
//  Both go through `prepare`, which the write route calls before it proposes an
//  op — so the ordering is a property of there being one route, not of every
//  caller remembering. A capture that fails does not block the edit: the edit is
//  the user's, the capture is a convenience the page may decline, and what
//  changes is that the undo says why rather than that the edit does not happen.
//
//  The FINAL tree is read at export instead of after each op. There is one
//  export and three places an op is confirmed (an edit, an undo, a redo), and a
//  final tree captured at all but one of them is a tree the recorded ops do not
//  build — silently. One call site cannot be missed.
//
//  ── When the captured base stops being usable ──────────────────────────────
//
//  A `changed` event says the tree moved, never how. So once another writer has
//  edited the page, the captured base can no longer answer for a field it did
//  not itself set — the value it holds may have been overwritten by an edit this
//  session cannot see. The base is therefore withheld from the inverse
//  derivation from that moment on, and the undo refuses by name instead of
//  restoring a value that was true an hour ago. Note the barrier below already
//  refuses every entry recorded BEFORE the change, so what this covers is
//  exactly the entries recorded after it.
//
//  ── Undo, redo, and the redo tail ──────────────────────────────────────────
//
//  The log holds every op recorded; the CURSOR says how many of them are
//  currently applied. Undo moves the cursor back, redo moves it forward, and a
//  new edit while undone truncates everything past the cursor — linear history,
//  no branching, exactly as the playground's session log behaves.
//
//  What differs is the mechanism: the cursor moves only AFTER the host confirms
//  the compensating op (undo) or the original op (redo). The extension never
//  moves its own record on the strength of an edit the page might refuse.
//
//  ── When something else is driving the same page ───────────────────────────
//
//  This is the genuinely ambiguous case, and the posture is deliberate: an undo
//  must never silently revert someone else's work.
//
//  When a change lands that this session did not cause, a BARRIER is set at the
//  current cursor. Undo stops there — the ops before it were composed against a
//  tree that no longer exists, and their recorded inverses name sibling orders
//  and property values that may since have moved. Everything the session does
//  AFTER the barrier is still fully undoable, because those ops were composed
//  against the tree as it is now.
//
//  The redo tail is DISCARDED at the same moment, for the sharper version of
//  the same reason: replaying an op composed before an external change is how
//  an edit lands somewhere nobody chose, successfully.
//
//  Recording continues across the barrier. The trail is the record of what this
//  session did, and that does not stop being true because someone else also did
//  something.
//
//  One race is left open honestly: a change landing between the panel composing
//  an op and the host applying it is not seen until the event arrives, so that
//  op is recorded with the snapshot the panel had. The contract offers no
//  compare-and-swap on `treeRevision`, so nothing here can close it; what it can
//  do is not pretend otherwise.
// ============================================================================

import type { TreeSnapshot } from '../relay/protocol.js';
import type { TreeOpJson } from '../edit/ops.js';
import { canonicalJson, type JsonValue } from './canonicalJson.js';
import { computeHashOf, DEVTOOLS_ACTOR, type Actor } from './hashChain.js';
import {
  capture,
  chainSeed,
  NO_WIRE_READER,
  NOT_ATTEMPTED,
  STALE,
  type Capture,
  type WireReader,
} from './capture.js';
import { flattenOps, inverseOf, type Inverse, type InverseRefusal } from './inverse.js';
import { writeTrailDocument, type LoggedOp, type SessionNote } from './sessionLog.js';

export interface TrailEntry {
  readonly seq: number;
  readonly actor: Actor;
  readonly prevHash: string;
  readonly hash: string;
  /** The op's canonical bytes — what the chain hashed and the export carries. */
  readonly opJson: string;
  /** The structured op, kept so a redo re-sends exactly what was applied. */
  readonly op: TreeOpJson;
  /** The relay attribution reason, for the panel's history list. */
  readonly reason: string;
  /** The structural tree from immediately before this op landed. */
  readonly treeBefore: TreeSnapshot;
  /**
   * Wire JSON read immediately before this op, keyed by node id — today, the
   * subtrees it was about to remove. A failed capture is kept rather than
   * dropped, so the undo's refusal can name the page's own reason.
   */
  readonly captured: ReadonlyMap<string, Capture>;
}

/** What the panel needs to render the history surface. */
export interface TrailView {
  readonly recorded: number;
  readonly applied: number;
  readonly undone: number;
  readonly entries: readonly TrailEntry[];
  /** Present when an undo is on offer. */
  readonly undoable: TrailEntry | undefined;
  /**
   * Present when an undo is NOT on offer but an entry exists — why not, as a
   * class and a message. The class is what makes the panel able to say which
   * KIND of "no" this is, in the shape the relay's own refusals take.
   */
  readonly undoBlocked: InverseRefusal | undefined;
  readonly redoable: TrailEntry | undefined;
  /** True once a change this session did not cause has landed. */
  readonly interrupted: boolean;
  /**
   * The session's base tree, or why there is none — so the surface can say what
   * an export will and will not carry BEFORE it is pressed.
   *
   * The final tree is not here, and cannot be: it is read at export, so at
   * render time nothing truthful can be said about it beyond that it will be
   * attempted.
   */
  readonly baseTree: Capture;
}

export interface PageIdentity {
  readonly host: string;
  readonly hostVersion: string;
  readonly profile: string;
}

const UNKNOWN_PAGE: PageIdentity = { host: '', hostVersion: '', profile: '' };

/** Injected so an export is deterministic under test. */
export type Clock = () => string;

const systemClock: Clock = () => new Date().toISOString();

export class Trail {
  private readonly clock: Clock;
  private readonly reader: WireReader;
  private log: TrailEntry[] = [];
  private cursor = 0;
  /** Undo may not walk back past this — see the external-change posture. */
  private barrier = 0;
  private interrupted = false;
  private base: TreeSnapshot | undefined;
  private latest: TreeSnapshot | undefined;
  /** The session's base tree in wire form, or why there is none. */
  private baseCapture: Capture = NOT_ATTEMPTED;
  /** Captures taken by `prepare` for the op that has not been recorded yet. */
  private pending = new Map<string, Capture>();
  private identity: PageIdentity = UNKNOWN_PAGE;
  private startRevision = '';
  private endRevision = '';
  private startedAt: string | undefined;

  constructor(clock: Clock = systemClock, reader: WireReader = NO_WIRE_READER) {
    this.clock = clock;
    this.reader = reader;
  }

  /**
   * The tree as the panel has just read it.
   *
   * The FIRST such tree becomes the recording's base — the session started when
   * the panel could first see the page, not when the user first typed.
   */
  observeTree(tree: TreeSnapshot, revision?: string): void {
    if (this.base === undefined) {
      this.base = tree;
      this.startedAt = this.clock();
      this.startRevision = revision ?? '';
    }
    this.latest = tree;
    if (revision !== undefined) this.endRevision = revision;
  }

  noteIdentity(identity: PageIdentity): void {
    this.identity = identity;
  }

  /** The tree an op about to be sent will be composed against. */
  get currentTree(): TreeSnapshot | undefined {
    return this.latest;
  }

  /** The session's base tree in wire form, or why there is none. */
  get baseTree(): Capture {
    return this.baseCapture;
  }

  /**
   * Read what `op` is about to make unreadable, BEFORE it is proposed.
   *
   * Called by the write route, so every op — a person's and a program's alike —
   * is prepared the same way. It never throws and never blocks the edit: a page
   * that will not serve a read has declined a convenience, not vetoed a
   * mutation, and the consequence lands where it belongs, on the undo that then
   * says why it cannot run.
   */
  async prepare(op: TreeOpJson): Promise<void> {
    // Cleared first, so each op's captures are its own. Carrying a capture
    // forward from a REFUSED op would read correctly right up until the session
    // edited that node in between, at which point the entry would hold a subtree
    // that is a version behind — and putting that back is the fabrication this
    // whole module is arranged against. A second read costs one round trip.
    this.pending = new Map();
    const root = this.latest?.id;
    // Nothing has been read, so there is no root to ask about and `record` will
    // decline this op anyway.
    if (root === undefined) return;

    // Attempted ONCE, at the first edit. A later attempt would capture a tree
    // this session had already changed, and the values it holds would then be
    // this session's own writes presented as what the page started with.
    if (!this.baseCapture.ok && this.baseCapture.why === 'not-attempted')
      this.baseCapture = await capture(await this.reader(root));

    for (const leg of flattenOps(op)) {
      if (leg['$type'] !== 'RemoveNode') continue;
      const target = leg['target'];
      if (typeof target !== 'string' || this.pending.has(target)) continue;
      this.pending.set(target, await capture(await this.reader(target)));
    }
  }

  /**
   * Record one op the host CONFIRMED it applied, attributed to `actor`.
   *
   * The redo tail is truncated first, so the chain is taken against the op that
   * genuinely precedes this one rather than against an op that was undone.
   *
   * `actor` defaults to the panel's own human identity, so every existing
   * caller records exactly what it recorded before — byte-identically, since
   * the actor is folded into the chain pre-image and an unchanged actor leaves
   * every hash where it was. A program dispatching through `Dispatch` passes
   * its own, and the resulting entry is distinguishable in the export by the
   * one field that cannot be re-attributed without moving every hash after it.
   */
  async record(
    op: TreeOpJson,
    reason: string,
    revision?: string,
    actor: Actor = DEVTOOLS_ACTOR,
  ): Promise<boolean> {
    const tree = this.latest;
    // No tree has been read, so there is nothing to record AGAINST: an entry
    // here would carry no `treeBefore` and could never be inverted. Reported
    // rather than silently swallowed, because a dispatching caller whose op the
    // host applied is entitled to know the trail did not keep it.
    if (tree === undefined) return false;

    this.log = this.log.slice(0, this.cursor);
    const previous = this.log[this.log.length - 1];
    // Seeded at the captured base tree's hash, and at genesis only when there is
    // no base tree — the session-log family's own rule, so a document this
    // recording emits verifies under the same procedure as one the reference
    // exporter emits.
    const prevHash = previous?.hash ?? chainSeed(this.baseCapture);
    const seq = this.cursor + 1;
    const opJson = canonicalJson(op as unknown as JsonValue);
    const hash = await computeHashOf(prevHash, op as unknown as JsonValue, seq, actor);

    this.log.push({
      seq,
      actor,
      prevHash,
      hash,
      opJson,
      op,
      reason,
      treeBefore: tree,
      captured: this.pending,
    });
    this.pending = new Map();
    this.cursor = this.log.length;
    if (revision !== undefined) this.endRevision = revision;
    return true;
  }

  /** The compensating op for the last applied entry, or why there is none. */
  undoOp(): Inverse | undefined {
    const entry = this.log[this.cursor - 1];
    if (entry === undefined || this.cursor <= this.barrier) return undefined;
    return inverseOf(
      entry.op,
      entry.treeBefore,
      this.log.slice(0, this.cursor - 1).map((recorded) => recorded.op),
      {
        // Withheld once another writer has been here: the base was true when it
        // was read, and a `changed` event does not say what it stopped being
        // true about. The per-op captures stay — each was taken immediately
        // before the op it belongs to, so nothing can have moved in between.
        base: this.interrupted ? STALE : this.baseCapture,
        captured: entry.captured,
      },
    );
  }

  /** The host confirmed the compensating op — the entry is no longer applied. */
  confirmUndo(revision?: string): void {
    if (this.cursor > this.barrier) this.cursor -= 1;
    if (revision !== undefined) this.endRevision = revision;
  }

  /** The op to re-send, or `undefined` when nothing is undone. */
  redoOp(): TreeOpJson | undefined {
    return this.log[this.cursor]?.op;
  }

  confirmRedo(revision?: string): void {
    if (this.cursor < this.log.length) this.cursor += 1;
    if (revision !== undefined) this.endRevision = revision;
  }

  /**
   * A change landed that this session did not cause.
   *
   * The redo tail goes; the undo barrier moves to the cursor. Recording
   * continues — the trail is what this session did, and it is still doing it.
   */
  externalChange(revision?: string): void {
    this.log = this.log.slice(0, this.cursor);
    this.barrier = this.cursor;
    this.interrupted = true;
    if (revision !== undefined) this.endRevision = revision;
  }

  /** End the recording. The page changed, or someone asked for a clean one. */
  reset(): void {
    this.log = [];
    this.cursor = 0;
    this.barrier = 0;
    this.interrupted = false;
    this.base = undefined;
    this.latest = undefined;
    this.baseCapture = NOT_ATTEMPTED;
    this.pending = new Map();
    this.startedAt = undefined;
    this.startRevision = '';
    this.endRevision = '';
  }

  view(): TrailView {
    const undoTarget = this.log[this.cursor - 1];
    const undo = this.undoOp();
    return {
      recorded: this.log.length,
      applied: this.cursor,
      undone: this.log.length - this.cursor,
      entries: this.log.slice(0, this.cursor),
      undoable: undo !== undefined && undo.ok ? undoTarget : undefined,
      undoBlocked:
        undoTarget === undefined
          ? undefined
          : undo === undefined
            ? {
                class: 'EXTERNAL_CHANGE',
                message:
                  'Another writer changed this page after that edit, so undoing it here could ' +
                  'revert work this session did not do.',
              }
            : undo.ok
              ? undefined
              : { class: undo.class, message: undo.message },
      redoable: this.log[this.cursor],
      interrupted: this.interrupted,
      baseTree: this.baseCapture,
    };
  }

  /** The applied prefix, as the export records it. The redo tail is excluded. */
  private loggedOps(): readonly LoggedOp[] {
    return this.log.slice(0, this.cursor).map((entry) => ({
      seq: entry.seq,
      actor: entry.actor,
      prevHash: entry.prevHash,
      hash: entry.hash,
      opJson: entry.opJson,
    }));
  }

  /**
   * The tree as it is NOW, read at export.
   *
   * Read here rather than after each confirmed op because there is one export
   * and three confirmations — an edit, an undo and a redo — and a final tree
   * captured at all but one of them is a tree the recorded ops do not build,
   * with nothing in the document to say so. It is also correct at every cursor
   * position: an undo is itself an applied op, so what the page holds after one
   * is exactly what the shortened applied prefix builds.
   */
  private async captureFinal(): Promise<Capture> {
    const root = this.latest?.id;
    if (root === undefined) return NOT_ATTEMPTED;
    return capture(await this.reader(root));
  }

  /** The whole document, ready to download. */
  async exportDocument(): Promise<string> {
    const session: SessionNote = {
      host: this.identity.host,
      hostVersion: this.identity.hostVersion,
      profile: this.identity.profile,
      startedAt: this.startedAt ?? '',
      endedAt: this.clock(),
      startRevision: this.startRevision,
      endRevision: this.endRevision,
    };
    return writeTrailDocument({
      ops: this.loggedOps(),
      base: this.baseCapture,
      final: await this.captureFinal(),
      interrupted: this.interrupted,
      session,
      baseStructure: (this.base ?? null) as unknown as JsonValue | null,
      finalStructure: (this.latest ?? null) as unknown as JsonValue | null,
    });
  }
}
