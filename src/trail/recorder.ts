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
import { computeHashOf, DEVTOOLS_ACTOR, GENESIS_PREVIOUS_HASH, type Actor } from './hashChain.js';
import { inverseOf, type Inverse } from './inverse.js';
import {
  relayIntegrity,
  trailAppendix,
  writeTrail,
  type LoggedOp,
  type SessionNote,
} from './sessionLog.js';

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
}

/** What the panel needs to render the history surface. */
export interface TrailView {
  readonly recorded: number;
  readonly applied: number;
  readonly undone: number;
  readonly entries: readonly TrailEntry[];
  /** Present when an undo is on offer. */
  readonly undoable: TrailEntry | undefined;
  /** Present when an undo is NOT on offer but an entry exists — why not. */
  readonly undoBlocked: string | undefined;
  readonly redoable: TrailEntry | undefined;
  /** True once a change this session did not cause has landed. */
  readonly interrupted: boolean;
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
  private log: TrailEntry[] = [];
  private cursor = 0;
  /** Undo may not walk back past this — see the external-change posture. */
  private barrier = 0;
  private interrupted = false;
  private base: TreeSnapshot | undefined;
  private latest: TreeSnapshot | undefined;
  private identity: PageIdentity = UNKNOWN_PAGE;
  private startRevision = '';
  private endRevision = '';
  private startedAt: string | undefined;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
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

  /**
   * Record one op the host CONFIRMED it applied.
   *
   * The redo tail is truncated first, so the chain is taken against the op that
   * genuinely precedes this one rather than against an op that was undone.
   */
  async record(op: TreeOpJson, reason: string, revision?: string): Promise<void> {
    const tree = this.latest;
    if (tree === undefined) return;

    this.log = this.log.slice(0, this.cursor);
    const previous = this.log[this.log.length - 1];
    const prevHash = previous?.hash ?? GENESIS_PREVIOUS_HASH;
    const seq = this.cursor + 1;
    const opJson = canonicalJson(op as unknown as JsonValue);
    const hash = await computeHashOf(prevHash, op as unknown as JsonValue, seq, DEVTOOLS_ACTOR);

    this.log.push({
      seq,
      actor: DEVTOOLS_ACTOR,
      prevHash,
      hash,
      opJson,
      op,
      reason,
      treeBefore: tree,
    });
    this.cursor = this.log.length;
    if (revision !== undefined) this.endRevision = revision;
  }

  /** The compensating op for the last applied entry, or why there is none. */
  undoOp(): Inverse | undefined {
    const entry = this.log[this.cursor - 1];
    if (entry === undefined || this.cursor <= this.barrier) return undefined;
    return inverseOf(
      entry.op,
      entry.treeBefore,
      this.log.slice(0, this.cursor - 1).map((recorded) => recorded.op),
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
            ? 'Another writer changed this page after that edit, so undoing it here could revert ' +
              'work this session did not do.'
            : undo.ok
              ? undefined
              : undo.reason,
      redoable: this.log[this.cursor],
      interrupted: this.interrupted,
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

  /** The whole document, ready to download. */
  exportDocument(): string {
    const session: SessionNote = {
      host: this.identity.host,
      hostVersion: this.identity.hostVersion,
      profile: this.identity.profile,
      startedAt: this.startedAt ?? '',
      endedAt: this.clock(),
      startRevision: this.startRevision,
      endRevision: this.endRevision,
    };
    return writeTrail(
      this.loggedOps(),
      trailAppendix({
        integrity: relayIntegrity(),
        session,
        baseStructure: (this.base ?? null) as unknown as JsonValue | null,
        finalStructure: (this.latest ?? null) as unknown as JsonValue | null,
      }),
    );
  }
}
