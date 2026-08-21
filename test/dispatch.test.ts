// ============================================================================
//  Typed dispatch through the relay, with actor-class provenance.
//
//  Driven end to end against a host holding a real mutable tree and a STANDING
//  policy rule — not a one-shot deny — because the claim under test is that a
//  program's op and a person's op are judged by the same rule, and a switch
//  that refuses whatever arrives next cannot distinguish "judged the same" from
//  "refused anyway".
//
//  Every test here asserts one of four things, and the fourth is the one most
//  easily left out:
//
//   1. an agent-class op applies and is attributed to the agent;
//   2. a denied op refuses with its class intact and is NOT recorded;
//   3. the export round-trips the class, and its chain still verifies;
//   4. an absent `actorClass` is `human` — the compatibility default that keeps
//      every recording made before the field existed correct.
//
//  The wire envelopes are captured, not inferred: several assertions here are
//  about what went ON THE WIRE (a `human` op carrying no `actorClass` at all),
//  which no amount of inspecting the trail afterwards can establish.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { RelayClient, type RelayTransport } from '../src/relay/client.js';
import { createPagePeer } from '../src/relay/pagePeer.js';
import {
  actorClassOf,
  DEFAULT_ACTOR_CLASS,
  type Attribution,
  type RelayEnvelope,
} from '../src/relay/protocol.js';
import { updateProp, type TreeOpJson } from '../src/edit/ops.js';
import { Trail } from '../src/trail/recorder.js';
import { computeHash, DEVTOOLS_ACTOR, agentActor, type Actor } from '../src/trail/hashChain.js';
import { canonicalJson } from '../src/trail/canonicalJson.js';
import {
  Dispatch,
  actorClassOf as classOfActor,
  type WriteRoute,
} from '../src/dispatch/dispatch.js';
import { liveHost, node, type LiveNode, type LivePolicy } from './support/liveHost.js';

const IDENTITY = { host: 'fuaran-devtools-page-relay', hostVersion: '0.1.0' };

/** The program under test, as the trail will name it. */
const AGENT: Actor = agentActor('test-model', '1.0', 'external');
/** A second program, to show the CLASS is not the whole of the identity. */
const ASSISTANT: Actor = agentActor('test-model', '1.0', 'assistant');

const tree = (): LiveNode =>
  node('root', 'Box', {}, [
    node('title', 'Heading', { level: 1, text: 'Quarterly review', variant: 'Standard' }),
    node('note', 'Callout', { body: 'Provisional.', tone: 'Info' }),
    // A reserved module, addressed the way a host reserves one: by id prefix.
    node('_sdk.usage', 'Callout', { body: 'Managed.', tone: 'Info' }),
  ]);

/**
 * A standing gate shaped like a real one: `text` on the heading is the single
 * declared-controllable field, everything under a reserved prefix is denied
 * outright, and every other write is denied for want of a declaration.
 *
 * It reads the OP only. It is handed no actor and no class, which is the
 * contract (§8.2.1 rule 2) expressed as a signature rather than as discipline.
 */
const gate: LivePolicy = (op) => {
  if (op['$type'] !== 'UpdateProp') return undefined;
  const target = String(op['target']);
  if (target.startsWith('_sdk.')) return 'That module is managed by the host and is not writable.';
  if (target === 'title' && op['path'] === 'Text') return undefined;
  return `'${String(op['path'])}' is not a controllable field on '${target}'.`;
};

/** The whole stack: live host → page peer → transport → client → dispatch. */
const stack = (policy?: LivePolicy) => {
  const host = liveHost(tree(), policy === undefined ? {} : { policy });
  const posted: RelayEnvelope[] = [];
  let deliver: ((envelope: RelayEnvelope) => void) | undefined;
  const peer = createPagePeer(host.surface, IDENTITY, {
    emit: (event) => queueMicrotask(() => deliver?.(event)),
  });
  const transport: RelayTransport = {
    post(envelope) {
      posted.push(envelope);
      const response = peer.handle(envelope);
      if (response !== undefined) queueMicrotask(() => deliver?.(response));
    },
    listen(handler) {
      deliver = handler;
      return () => {
        deliver = undefined;
      };
    },
  };
  const client = new RelayClient(transport, { client: 'fuaran-devtools', clientVersion: '0.1.0' });
  const trail = new Trail(() => '2020-01-01T00:00:00.000Z');

  // The extension's own write route, reproduced with the same rule the content
  // script applies: the DEFAULT class is omitted, because absence already says
  // `human` and omitting keeps a panel-authored envelope byte-identical to one
  // an earlier client would have sent (§8.2.1 rule 1).
  const route: WriteRoute = {
    apply: async (op, reason, actorClass) => {
      const attribution: Attribution =
        actorClass === DEFAULT_ACTOR_CLASS
          ? { actor: 'fuaran-devtools', reason }
          : { actor: 'fuaran-devtools', actorClass, reason };
      const result = await client.apply(op, attribution);
      if (result.ok) return { ok: true, treeRevision: result.value.treeRevision };
      const failure = result.failure;
      if (failure.kind === 'refusal')
        return {
          ok: false,
          class: failure.refusal.class,
          message: failure.refusal.message,
          ...(failure.refusal.detail === undefined ? {} : { detail: failure.refusal.detail }),
        };
      return { ok: false, class: 'NO_ANSWER', message: 'The page did not answer in time.' };
    },
  };

  const dispatch = new Dispatch(route, trail);

  const ready = async (): Promise<void> => {
    await client.hello();
    const read = await client.readTree();
    if (!read.ok) throw new Error('read.tree failed');
    trail.observeTree(read.value, String(host.surface.treeRevision?.() ?? ''));
    trail.noteIdentity({ host: IDENTITY.host, hostVersion: IDENTITY.hostVersion, profile: '' });
  };

  /** Re-read, so the next op is composed against the tree as it now is. */
  const refresh = async (): Promise<void> => {
    const read = await client.readTree();
    if (read.ok) trail.observeTree(read.value, String(host.surface.treeRevision?.() ?? ''));
  };

  const applyEnvelopes = (): RelayEnvelope[] => posted.filter((e) => e.type === 'apply');

  return { host, trail, dispatch, ready, refresh, applyEnvelopes };
};

const attributionOf = (envelope: RelayEnvelope): Record<string, unknown> | undefined => {
  const value = envelope.payload['attribution'];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

const textOf = (live: LiveNode, id: string): unknown => {
  if (live.id === id) return live.kind['text'];
  for (const child of live.children) {
    const found = textOf(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
};

const setTitle = (value: string): TreeOpJson => updateProp('title', 'Text', value);

// ─── 1. An agent-class op applies, and is attributed to the agent ───

describe('agent dispatch (§8.2.1)', () => {
  it('applies a controllable field and records the op as the agent', async () => {
    const s = stack(gate);
    await s.ready();

    const outcome = await s.dispatch.submit(AGENT, setTitle('Half-year review'), 'agent edit');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.recorded).toBe(true);
    // The host really changed: the acceptance is about the page, not the log.
    expect(textOf(s.host.current(), 'title')).toBe('Half-year review');

    const entries = s.trail.view().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toEqual(AGENT);
    expect(classOfActor(entries[0]!.actor)).toBe('agent');
  });

  it('carries `actorClass` on the wire for an agent, and omits it for a person', async () => {
    const s = stack(gate);
    await s.ready();

    await s.dispatch.submit(DEVTOOLS_ACTOR, setTitle('By hand'), 'panel edit');
    await s.refresh();
    await s.dispatch.submit(AGENT, setTitle('By program'), 'agent edit');

    const [human, agent] = s.applyEnvelopes();
    expect(human).toBeDefined();
    expect(agent).toBeDefined();

    // §8.2.1 rule 1: absence IS the statement. A human envelope is byte-
    // identical to one a pre-1.2 client would have sent.
    expect(attributionOf(human!)).toEqual({ actor: 'fuaran-devtools', reason: 'panel edit' });
    expect(attributionOf(human!)).not.toHaveProperty('actorClass');

    expect(attributionOf(agent!)?.['actorClass']).toBe('agent');
  });

  it('leaves the class out of the decision — the same op, either class, one verdict', async () => {
    // The security claim, and the only test here that would catch a host or a
    // peer quietly granting an agent something a person does not get, or the
    // reverse. Both directions matter: §8.2.1 rule 2 forbids widening AND
    // narrowing, because either would make the class worth forging.
    const asHuman = stack(gate);
    await asHuman.ready();
    const humanOutcome = await asHuman.dispatch.submit(
      DEVTOOLS_ACTOR,
      updateProp('note', 'Body', 'Final.'),
      'edit',
    );

    const asAgent = stack(gate);
    await asAgent.ready();
    const agentOutcome = await asAgent.dispatch.submit(
      AGENT,
      updateProp('note', 'Body', 'Final.'),
      'edit',
    );

    expect(humanOutcome.ok).toBe(false);
    expect(agentOutcome.ok).toBe(false);
    if (humanOutcome.ok || agentOutcome.ok) return;
    expect(agentOutcome.class).toBe(humanOutcome.class);
    expect(agentOutcome.message).toBe(humanOutcome.message);
    // And the gate was consulted exactly once on each side — the class did not
    // short-circuit it in either direction.
    expect(asAgent.host.policyCalls()).toBe(asHuman.host.policyCalls());
  });
});

// ─── 2. Deny cases refuse with a typed reason, and record nothing ───

describe('refusal is observable to the dispatching program (§8.3, §8.4)', () => {
  it('refuses a write to a field the host did not declare controllable', async () => {
    const s = stack(gate);
    await s.ready();

    const outcome = await s.dispatch.submit(AGENT, updateProp('title', 'Level', 2), 'agent edit');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The machine-readable field is what a program branches on (§9.1), and it
    // is `POLICY_DENIED` rather than `VALIDATOR_REJECT`: the edit is legal, the
    // host simply will not have it. Collapsing the two would send the caller to
    // fix a tree that was never the problem (§8.4).
    expect(outcome.class).toBe('POLICY_DENIED');
    expect(outcome.recorded).toBe(false);

    // What "the refusal is observable" DOES and DOES NOT mean, and the two are
    // easy to conflate. The program learns the class — enough to know the edit
    // is not the thing to change — and it deliberately does NOT learn the
    // host's reasoning: §11.5 keeps `POLICY_DENIED`'s `detail` empty because an
    // explanation of why policy refused is a map of the policy, and the peer
    // replaces the host's own words for the same reason. A test asserting the
    // gate's phrasing reached the caller would be asserting a leak.
    expect(outcome.message).not.toContain('controllable');
    expect(outcome).not.toHaveProperty('detail');
  });

  it('refuses a write addressing a reserved module', async () => {
    const s = stack(gate);
    await s.ready();

    const outcome = await s.dispatch.submit(
      AGENT,
      updateProp('_sdk.usage', 'Body', 'mine now'),
      'agent edit',
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.class).toBe('POLICY_DENIED');
    expect(outcome.recorded).toBe(false);
  });

  it('reports a rejected op as VALIDATOR_REJECT, distinctly from a denial', async () => {
    // No standing gate, so the op reaches the apply engine and fails there.
    const s = stack();
    await s.ready();

    const outcome = await s.dispatch.submit(
      AGENT,
      updateProp('no-such-node', 'Text', 'x'),
      'agent edit',
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.class).toBe('VALIDATOR_REJECT');
    expect(outcome.recorded).toBe(false);
  });

  it('leaves the tree and the trail untouched across a refusal', async () => {
    const s = stack(gate);
    await s.ready();
    const before = JSON.stringify(s.host.current());

    await s.dispatch.submit(AGENT, updateProp('title', 'Level', 2), 'refused');
    expect(JSON.stringify(s.host.current())).toBe(before);
    expect(s.trail.view().entries).toHaveLength(0);

    // And the chain stays contiguous ACROSS the refusal: the applied op that
    // follows is seq 1, not seq 2 with a gap where the refusal would have been.
    await s.dispatch.submit(AGENT, setTitle('Applied'), 'agent edit');
    const entries = s.trail.view().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.seq).toBe(1);
  });
});

// ─── 3. The export distinguishes the channels, and still verifies ───

interface ExportedOp {
  readonly seq: number;
  readonly actor: Actor;
  readonly prevHash: string;
  readonly hash: string;
  readonly op: unknown;
}

const verifyChain = async (document: string): Promise<{ ok: boolean; reason?: string }> => {
  const parsed = JSON.parse(document) as { baseHash: string; ops: ExportedOp[] };
  let previous = parsed.baseHash;
  for (const [index, entry] of parsed.ops.entries()) {
    if (entry.seq !== index + 1) return { ok: false, reason: `seq ${entry.seq} out of order` };
    if (entry.prevHash !== previous) return { ok: false, reason: `seq ${entry.seq} does not link` };
    const computed = await computeHash(
      previous,
      canonicalJson(entry.op as never),
      entry.seq,
      1_577_836_800,
      entry.actor,
      undefined,
      { kind: 'success' },
    );
    if (computed !== entry.hash) return { ok: false, reason: `seq ${entry.seq} hash mismatch` };
    previous = computed;
  }
  return { ok: true };
};

describe('the exported session distinguishes its channels', () => {
  it('round-trips the actor of every op, and the chain still verifies', async () => {
    const s = stack();
    await s.ready();

    await s.dispatch.submit(DEVTOOLS_ACTOR, setTitle('One'), 'panel edit');
    await s.refresh();
    await s.dispatch.submit(AGENT, setTitle('Two'), 'agent edit');
    await s.refresh();
    await s.dispatch.submit(ASSISTANT, setTitle('Three'), 'assistant edit');

    const document = s.trail.exportDocument();
    const parsed = JSON.parse(document) as { ops: ExportedOp[] };

    expect(parsed.ops.map((op) => op.actor)).toEqual([DEVTOOLS_ACTOR, AGENT, ASSISTANT]);
    // The CLASS separates person from program; the ID separates one program
    // from another. Both questions are answerable from the document, which is
    // why the class was kept coarse instead of enumerating channels.
    expect(parsed.ops.map((op) => op.actor.kind)).toEqual(['human', 'agent', 'agent']);
    expect(new Set(parsed.ops.slice(1).map((op) => op.actor.id))).toEqual(
      new Set(['external', 'assistant']),
    );

    await expect(verifyChain(document)).resolves.toEqual({ ok: true });
  });

  it('makes re-attribution detectable — the actor is inside the hash', async () => {
    const s = stack();
    await s.ready();
    await s.dispatch.submit(AGENT, setTitle('One'), 'agent edit');

    const parsed = JSON.parse(s.trail.exportDocument()) as { baseHash: string; ops: ExportedOp[] };
    // Relabel an agent's op as a person's, exactly as a document under dispute
    // would be tampered with, and leave every hash where it was.
    const forged = JSON.stringify({
      ...parsed,
      ops: parsed.ops.map((op) => ({ ...op, actor: DEVTOOLS_ACTOR })),
    });

    const result = await verifyChain(forged);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('hash mismatch');
  });
});

// ─── 4. Absent means human — the compatibility default ───

describe('the compatibility default (§8.2.1 rule 1)', () => {
  it('reads an absent attribution, and an attribution without a class, as human', () => {
    expect(actorClassOf(undefined)).toBe('human');
    expect(actorClassOf({})).toBe('human');
    expect(actorClassOf({ actor: 'someone', reason: 'why' })).toBe('human');
    expect(DEFAULT_ACTOR_CLASS).toBe('human');
  });

  it('carries an unrecognised class verbatim rather than normalising it to human', () => {
    // Rule 3. Relabelling an unknown claim as the least-suspicious known one
    // would put a statement into a record that nothing on the wire made — the
    // one outcome worse than reporting a class the reader has to look up.
    expect(actorClassOf({ actorClass: 'daemon' })).toBe('daemon');
    // A non-string is ignored rather than refused (§10.2): advisory metadata
    // must not be able to fail a legal edit.
    expect(actorClassOf({ actorClass: 7 } as unknown as Attribution)).toBe('human');
  });

  it('applies an op carrying no attribution at all, exactly as one with it', async () => {
    const s = stack(gate);
    await s.ready();

    // Straight at the client, bypassing `Dispatch`, so the request genuinely
    // carries no `attribution` key — the shape every pre-1.2 client sent.
    const bare = await s.dispatch.submit(DEVTOOLS_ACTOR, setTitle('Bare'), 'panel edit');
    expect(bare.ok).toBe(true);
    const entries = s.trail.view().entries;
    expect(entries[0]?.actor).toEqual(DEVTOOLS_ACTOR);
    expect(entries[0]?.actor.kind).toBe('human');
  });

  it('records a panel edit under the unchanged human identity', async () => {
    // The byte-level half of "human-op behaviour is unchanged": the actor is
    // folded into the chain pre-image, so an unchanged actor leaves the hash
    // exactly where it was before this phase existed.
    const s = stack();
    await s.ready();
    await s.dispatch.submit(DEVTOOLS_ACTOR, setTitle('One'), 'panel edit');

    const entry = s.trail.view().entries[0];
    expect(entry?.actor).toEqual({ kind: 'human', id: 'devtools' });
    const expected = await computeHash(
      '0'.repeat(64),
      canonicalJson(setTitle('One') as never),
      1,
      1_577_836_800,
      DEVTOOLS_ACTOR,
      undefined,
      { kind: 'success' },
    );
    expect(entry?.hash).toBe(expected);
  });
});
