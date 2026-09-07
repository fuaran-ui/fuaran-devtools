// ============================================================================
//  dispatch — one write route, two kinds of author.
//
//  ── What this module exists to make TRUE, not merely to assert ─────────────
//
//  The claim a provenance-bearing editor has to earn is that a program's edit
//  went the same way a person's did: the same relay `apply`, the same host
//  decode → validate → policy sequence (DEVTOOLS_RELAY §8.3), the same refusal
//  classes, the same record-only-on-confirmation rule. The cheap way to get
//  that is to write a second path and assert the two agree, which holds until
//  someone changes one of them.
//
//  So there is no second path. `submit` is the ONLY route from a composed op to
//  the host's apply, and the panel's own editing surface calls it with the
//  panel's human identity. "Identical to a navigator edit" is then a property
//  of there being one function, not of two functions currently matching.
//
//  ── The class is a label on the record, never an input to the decision ─────
//
//  `actorClass` rides along to the host as advisory attribution (§8.2.1 rule 2)
//  and reaches no branch on the way. A dispatch from a program against a field
//  the host will not let anyone write is refused exactly as the same dispatch
//  from the panel would be, with the same class and the same message — which is
//  the point of the write side of §11.3's "the relay has no side door". An
//  agent gains nothing here except a record saying it was an agent.
//
//  ── What a refused dispatch leaves behind: nothing ─────────────────────────
//
//  A refusal is reported to the caller with its machine-readable class intact
//  and is NOT recorded. §8.3 guarantees a refused op left the tree unchanged,
//  so an entry for it would put an op in a document whose whole claim is that
//  its ops built its tree. The caller learns what happened; the record does not
//  learn something that did not.
//
//  ── What this module deliberately does NOT do ──────────────────────────────
//
//  It exposes no externally-reachable entry point — no `externally_connectable`
//  origin, no message listener a page or another extension could reach. A
//  dispatching program is one running INSIDE this extension and holding a
//  reference to a `Dispatch`. Opening the surface outward is a real security
//  decision (it would let any origin that can reach the extension drive a
//  page's typed state through a channel the page never opted into offering
//  *that* caller), and it is not one this module makes on anyone's behalf.
// ============================================================================

import type { ApplyResult } from '../bridge.js';
import type { TreeOpJson } from '../edit/ops.js';
import type { ActorClass } from '../relay/protocol.js';
import { agentActor, DEVTOOLS_ACTOR, type Actor } from '../trail/hashChain.js';
import type { Trail } from '../trail/recorder.js';

export { agentActor, DEVTOOLS_ACTOR };
export type { Actor };

/**
 * The relay class an actor is, for the `attribution.actorClass` field.
 *
 * The body is `actor.kind` because the two vocabularies are the same closed
 * set — the wire field was specified to match the op-stream's own actor
 * discriminator so a relayed op joins a recording untranslated (§8.2.1 rule 4).
 * This one-line function is also where that agreement is CHECKED: it compiles
 * only while `Actor['kind']` remains assignable to `ActorClass`, so a third
 * case added to either side fails the typecheck here rather than silently
 * producing a class the contract does not define.
 */
export const actorClassOf = (actor: Actor): ActorClass => actor.kind;

/**
 * The one way an op reaches the host.
 *
 * An interface rather than a direct call so the module is testable without an
 * extension around it, and so the panel's transport plumbing (panel → service
 * worker → content script → relay client) stays in the panel where it belongs.
 * It is deliberately narrow: an implementation gets an op, a reason and a
 * class, and can do nothing else.
 */
export interface WriteRoute {
  apply(op: TreeOpJson, reason: string, actorClass: ActorClass): Promise<ApplyResult>;
}

/**
 * What a dispatching caller learns.
 *
 * Structurally an {@link ApplyResult} plus `recorded`, so the panel's edit
 * surface consumes it unchanged. `recorded` is not redundant with `ok`: the two
 * coincide today and stating both is what makes a future divergence — an op the
 * host applied while the trail had no base tree to record against — reportable
 * rather than invisible.
 */
export type DispatchOutcome =
  | { readonly ok: true; readonly treeRevision: string; readonly recorded: boolean }
  | {
      readonly ok: false;
      readonly class: string;
      readonly message: string;
      readonly detail?: Readonly<Record<string, unknown>>;
      readonly recorded: false;
    };

/** A program's identity, as the trail will record it. */
export interface AgentIdentity {
  readonly model: string;
  readonly version: string;
  readonly id: string;
}

export const identityActor = (identity: AgentIdentity): Actor =>
  agentActor(identity.model, identity.version, identity.id);

export class Dispatch {
  private readonly route: WriteRoute;
  private readonly trail: Trail;

  constructor(route: WriteRoute, trail: Trail) {
    this.route = route;
    this.trail = trail;
  }

  /**
   * Propose one op on `actor`'s behalf and record it if the host confirms.
   *
   * The order is load-bearing and is the same order the panel has always used:
   * the host decides FIRST, the record follows. Recording optimistically and
   * unwinding on a refusal would mean the trail briefly claimed an edit that
   * never happened, and there is no moment at which that is safe to export.
   *
   * One thing happens BEFORE the host decides, and it has to: the trail reads
   * what this op is about to make unreadable — the session's base tree at the
   * first edit, and any subtree the op removes. After the apply, both answers
   * are gone. Putting it here rather than in each caller is the same argument
   * this whole module makes: there is one write route, so a program's dispatch
   * and a person's edit are prepared identically because they are the same call.
   * A capture that fails does not stop the edit; it changes what the undo can
   * later say, which is where the consequence belongs.
   */
  async submit(actor: Actor, op: TreeOpJson, reason: string): Promise<DispatchOutcome> {
    await this.trail.prepare(op);
    const result = await this.route.apply(op, reason, actorClassOf(actor));
    if (!result.ok) return { ...result, recorded: false };
    const recorded = await this.trail.record(op, reason, result.treeRevision, actor);
    return { ok: true, treeRevision: result.treeRevision, recorded };
  }

  /** Dispatch on behalf of a program, by identity rather than by `Actor`. */
  submitAs(identity: AgentIdentity, op: TreeOpJson, reason: string): Promise<DispatchOutcome> {
    return this.submit(identityActor(identity), op, reason);
  }
}
