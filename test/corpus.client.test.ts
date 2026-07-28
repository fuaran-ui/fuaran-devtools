// ============================================================================
//  The relay conformance corpus, driven through the CLIENT PEER.
//
//  The consumer side of the same fixtures. Where the page-peer suite asks
//  "does this implementation PRODUCE the contract's shapes", this one asks
//  "does it CONSUME every shape the contract permits" — including shapes a
//  read-only peer can never produce, because a client meets hosts it did not
//  build. §10.3 is explicit that an unrecognised enumerated value is the
//  generic case and never a crash, and that is only testable from this side.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { RelayClient, type RelayTransport } from '../src/relay/client.js';
import type { RelayEnvelope } from '../src/relay/protocol.js';
import { isRelayEnvelope } from '../src/relay/protocol.js';
import { readFixture, readManifest } from './support/corpus.js';

/**
 * A transport that answers with a fixture response, re-stamped with the id the
 * client actually issued. The fixtures' own ids are the fixture author's
 * choice; correlation is asserted directly in `client.test.ts`.
 */
const harness = (reply: (envelope: RelayEnvelope) => Record<string, unknown> | undefined) => {
  let handler: ((envelope: RelayEnvelope) => void) | undefined;
  const transport: RelayTransport = {
    post(envelope) {
      const response = reply(envelope);
      if (response === undefined) return;
      queueMicrotask(() => handler?.({ ...response, id: envelope.id } as RelayEnvelope));
    },
    listen(next) {
      handler = next;
      return () => {
        handler = undefined;
      };
    },
  };
  const peer = new RelayClient(transport, {
    client: 'fuaran-devtools',
    clientVersion: '0.1.0',
  });
  /** Push an unsolicited envelope at the client, as a page peer would. */
  const deliver = (envelope: RelayEnvelope): void => handler?.(envelope);
  return { peer, deliver };
};

const client = (reply: (envelope: RelayEnvelope) => Record<string, unknown> | undefined) =>
  harness(reply).peer;

const manifest = readManifest();
const fixture = (id: string) => manifest.fixtures.find((entry) => entry.id === id);

const respondWith = (file: string) => () => readFixture(file);

describe('relay@1.0 corpus — client peer', () => {
  it('completes the read-only handshake and keeps the advertised capabilities', async () => {
    const entry = fixture('hello-read-only');
    expect(entry?.responseFile).toBeDefined();
    const peer = client(respondWith(entry!.responseFile!));

    const result = await peer.hello();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.profile).toBe('relay@1.0');
    expect(result.value.capabilities).toContain('read.tree');
    expect(peer.can('read.tree')).toBe(true);
    // §6.4: the client must not issue a request for a capability that was not
    // advertised, so a read-only handshake makes `apply` locally unavailable.
    expect(peer.can('apply')).toBe(false);
  });

  it('keeps capabilities it does not itself know about (§10.2)', async () => {
    const entry = fixture('hello-apply-capable');
    const peer = client(respondWith(entry!.responseFile!));
    const result = await peer.hello();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.capabilities).toContain('apply');
    expect(peer.can('subscribe')).toBe(true);
  });

  it('reads the typed node snapshot', async () => {
    const peer = client(respondWith(fixture('read-node-state')!.responseFile!));
    const result = await peer.readNodeState('metric-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('Metric');
    expect(result.value.bindings[0]).toEqual({
      slot: 'Value',
      expression: '$state.revenue',
      source: 'State',
    });
  });

  it('reads the recursive tree snapshot', async () => {
    const peer = client(respondWith(fixture('read-tree')!.responseFile!));
    const result = await peer.readTree();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('root');
    expect(result.value.children.map((child) => child.kind)).toEqual(['Metric', 'DataGrid']);
    // §7.2: `children` mirrors `childIds` in order, and a leaf carries `[]`.
    expect(result.value.children.map((child) => child.id)).toEqual([...result.value.childIds]);
    expect(result.value.children[0]?.children).toEqual([]);
  });

  it.each([
    ['read-binding-value-resolved', 'resolved'],
    ['read-binding-value-no-override', 'noOverride'],
  ])('reads the tagged resolution envelope — %s', async (id, status) => {
    const peer = client(respondWith(fixture(id)!.responseFile!));
    const result = await peer.readBindingValue('metric-1', 'Value');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe(status);
    // §7.3: the binding identity is carried on EVERY status, so a client can
    // always render what the binding IS, even with no value.
    expect(result.value.expression).not.toBe('');
    expect(result.value.source).not.toBe('');
  });

  it('reads live geometry', async () => {
    const peer = client(respondWith(fixture('read-rendered-dom')!.responseFile!));
    const result = await peer.readRenderedDom('metric-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.value.width).toBe('number');
    expect(result.value.hidden).toBe(false);
  });

  it.each([
    ['read-find-nodes', 2],
    ['read-find-nodes-empty', 0],
  ])('reads found node ids — %s', async (id, count) => {
    const peer = client(respondWith(fixture(id)!.responseFile!));
    const result = await peer.findNodes('Metric');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nodeIds).toHaveLength(count);
  });

  // Every refusal class in the corpus, surfaced by class — including the three
  // apply-path classes a read-only peer never emits. A client that only handled
  // the classes its usual host produces would break on the first host that
  // offers more.
  const refusals = manifest.fixtures.filter((entry) => entry.kind === 'relay-refusal');

  it('covers every refusal class the corpus declares', () => {
    expect(refusals.length).toBeGreaterThanOrEqual(10);
  });

  for (const entry of refusals)
    it(`surfaces ${entry.expectedClass} by class, never by message`, async () => {
      const peer = client(respondWith(entry.responseFile!));
      const result = await peer.readTree();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.kind).toBe('refusal');
      if (result.failure.kind !== 'refusal') return;
      expect(result.failure.refusal.class).toBe(entry.expectedClass);
    });

  it('tolerates a refusal class it has never heard of (§10.3)', async () => {
    const peer = client(() => ({
      $relay: 'relay@1.0',
      dir: 'response',
      type: 'refusal',
      payload: { class: 'HEAT_DEATH', requestType: 'read.tree', message: 'later.' },
    }));
    const result = await peer.readTree();
    expect(result.ok).toBe(false);
    if (result.ok || result.failure.kind !== 'refusal') return;
    expect(result.failure.refusal.class).toBe('HEAT_DEATH');
  });

  it('accepts the change-event envelopes without settling a pending read (§10.4)', async () => {
    const events = manifest.fixtures.filter((entry) => entry.kind === 'relay-event');
    expect(events.length).toBeGreaterThan(0);

    for (const entry of events) {
      const envelope = readFixture(entry.eventFile!);
      expect(isRelayEnvelope(envelope)).toBe(true);
      expect(envelope['dir']).toBe('event');

      // Deliver the event MID-FLIGHT, before the response. A client that let an
      // event settle a pending request would resolve the read with an event
      // payload — which is exactly the confusion §10.4 exists to forbid.
      let deliverEvent: (() => void) | undefined;
      const { peer, deliver } = harness((request) => {
        // Re-stamped with the PENDING request's id, so id correlation alone
        // cannot save the client — only the `dir: "event"` check can.
        deliverEvent = () => deliver({ ...envelope, id: request.id } as unknown as RelayEnvelope);
        return readFixture(fixture('read-tree')!.responseFile!);
      });
      const pending = peer.readTree();
      deliverEvent?.();

      const result = await pending;
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe('root');
    }
  });
});
