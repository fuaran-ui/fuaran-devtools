// ============================================================================
//  The write side, end to end: client → page peer → host → back.
//
//  Both halves of the relay this extension ships, wired to each other over a
//  transport that does what `window.postMessage` does, against a host holding a
//  real tree. So an assertion here is about the whole path — op composition,
//  the client's capability pre-check, the envelope, the peer's §8.3 mapping,
//  the host's gate, and what the tree became — rather than about any one link.
//
//  This is where the phase's acceptance criteria are actually driven:
//
//   * a label edit and a size edit round-trip and change the tree;
//   * an insert-before-sibling emits the exact Batch and lands where placed;
//   * a validator-rejected edit surfaces the host's error and changes NOTHING;
//   * a concurrent writer's mutation keeps the panel coherent, with the
//     selection re-resolved by id rather than by index.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { RelayClient, type RelayTransport } from '../src/relay/client.js';
import { createPagePeer } from '../src/relay/pagePeer.js';
import type { RelayEnvelope, TreeSnapshot } from '../src/relay/protocol.js';
import { insertOp, removeNode, updateProp } from '../src/edit/ops.js';
import { reresolve, siblingIds } from '../src/panel/treeModel.js';
import { liveHost, node, type LiveHost, type LiveNode } from './support/liveHost.js';

const IDENTITY = { host: 'fuaran-devtools-page-relay', hostVersion: '0.1.0' };

/**
 * A page: one host, one peer, one client. The transport is synchronous-ish
 * (a microtask, as postMessage is), and events the peer emits arrive on the
 * same channel — which is what makes the coherence test exercise the real
 * event path rather than a hand-delivered envelope.
 */
const page = (initial: LiveNode, options: { canApply?: boolean } = {}) => {
  const host = liveHost(initial, options);
  let deliver: ((envelope: RelayEnvelope) => void) | undefined;

  const peer = createPagePeer(host.surface, IDENTITY, {
    emit: (event) => queueMicrotask(() => deliver?.(event)),
  });

  const transport: RelayTransport = {
    post(envelope) {
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
  return { host, peer, client };
};

const tree = (): LiveNode =>
  node('root', 'Box', {}, [
    node('metric-1', 'Metric', { label: 'Revenue' }),
    node('card', 'Box', {}),
    node('c', 'Heading', { level: 1, text: 'Title', variant: 'Standard' }),
  ]);

const kindOf = (host: LiveHost, id: string): Record<string, unknown> => {
  const walk = (live: LiveNode): LiveNode | undefined => {
    if (live.id === id) return live;
    for (const child of live.children) {
      const found = walk(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(host.current())!.kind;
};

describe('property edits round-trip through the relay', () => {
  it('applies a label edit and a size edit, and the tree carries both', async () => {
    const { host, client } = page(tree());
    await client.hello();

    const label = await client.apply(updateProp('metric-1', 'Label', 'Net revenue'), {
      actor: 'fuaran-devtools',
      reason: 'set Label',
    });
    expect(label.ok).toBe(true);
    expect(kindOf(host, 'metric-1')['label']).toBe('Net revenue');

    const size = await client.apply(updateProp('c', 'Level', 3));
    expect(size.ok).toBe(true);
    expect(kindOf(host, 'c')['level']).toBe(3);

    // The post-op revision moves, which is what a client compares to know its
    // cached read went stale.
    if (!size.ok) return;
    expect(size.value.treeRevision).not.toBe('r-0');
  });

  it('advertises apply only when the host wired one', async () => {
    const { client } = page(tree(), { canApply: false });
    const handshake = await client.hello();
    expect(handshake.ok).toBe(true);
    if (!handshake.ok) return;
    // Read-only degradation, from the capability set the panel reads: the
    // affordances are absent because the capability is, not because a button
    // was disabled somewhere.
    expect(handshake.value.capabilities).not.toContain('apply');
    expect(handshake.value.capabilities).toContain('read.tree');

    const refused = await client.apply(updateProp('c', 'Level', 3));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.kind).toBe('capabilityAbsent');
  });
});

describe('structural edits land where they were placed', () => {
  it('inserts before a sibling with the exact Batch, and the order follows', async () => {
    const { host, client } = page(tree());
    await client.hello();

    const snapshot = (await client.readTree()) as { ok: true; value: TreeSnapshot };
    const siblings = snapshot.value.children.map((child) => child.id);
    expect(siblings).toEqual(['metric-1', 'card', 'c']);

    const child = { id: 'heading-1', kind: { $type: 'Heading', level: 1, text: 'Text' } };
    const op = insertOp(
      siblings,
      { parentId: 'root', placement: { at: 'before', anchor: 'card' } },
      child,
    );
    expect(JSON.stringify(op)).toBe(
      '{"$type":"Batch","ops":[' +
        '{"$type":"InsertChild","child":{"id":"heading-1","kind":{"$type":"Heading","level":1,"text":"Text"}},"parentId":"root"},' +
        '{"$type":"ReorderChildren","newOrder":["metric-1","heading-1","card","c"],"parentId":"root"}' +
        ']}',
    );

    expect((await client.apply(op)).ok).toBe(true);
    expect(host.current().children.map((entry) => entry.id)).toEqual([
      'metric-1',
      'heading-1',
      'card',
      'c',
    ]);
  });

  it('leaves the tree untouched when a Batch fails on its second leg', async () => {
    const { host, client } = page(tree());
    await client.hello();
    const before = JSON.stringify(host.current());

    // The insert is legal; the order names a sibling that is not there. A
    // partly-applied batch would leave a tree no op describes.
    const op = {
      $type: 'Batch',
      ops: [
        {
          $type: 'InsertChild',
          child: { id: 'heading-9', kind: { $type: 'Heading' } },
          parentId: 'root',
        },
        { $type: 'ReorderChildren', newOrder: ['metric-1', 'ghost'], parentId: 'root' },
      ],
    };
    const result = await client.apply(op);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(host.current())).toBe(before);
  });
});

describe('a refused edit changes nothing, and says which kind of refusal it was', () => {
  it('surfaces the host validator error verbatim, tree byte-identical', async () => {
    const { host, client } = page(tree());
    await client.hello();
    const before = JSON.stringify(host.current());

    const result = await client.apply(removeNode('root'));
    expect(result.ok).toBe(false);
    if (result.ok || result.failure.kind !== 'refusal') return;
    expect(result.failure.refusal.class).toBe('VALIDATOR_REJECT');
    expect(result.failure.refusal.message).toContain('root cannot be removed');
    expect(result.failure.refusal.detail).toEqual({ code: 'FUARAN-APPLY-ROOT-REMOVAL' });
    expect(JSON.stringify(host.current())).toBe(before);
  });

  it('keeps a policy refusal distinct from a validator one', async () => {
    const { host, client } = page(tree());
    await client.hello();
    const before = JSON.stringify(host.current());

    host.denyNext();
    const result = await client.apply(updateProp('c', 'Level', 2));
    expect(result.ok).toBe(false);
    if (result.ok || result.failure.kind !== 'refusal') return;
    // Nothing about the edit can fix this one, which is precisely why it must
    // not arrive as VALIDATOR_REJECT.
    expect(result.failure.refusal.class).toBe('POLICY_DENIED');
    // And nothing about the policy is disclosed beyond the fact of it (§11.5).
    expect(result.failure.refusal.detail).toBeUndefined();
    expect(JSON.stringify(host.current())).toBe(before);
  });

  it('reports an op it could not decode as a decode failure, not an illegal edit', async () => {
    const { client } = page(tree());
    await client.hello();
    const result = await client.apply({ $type: 'UpdatePropertyValue', target: 'c', value: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok || result.failure.kind !== 'refusal') return;
    expect(result.failure.refusal.class).toBe('DECODE_FAILED');
    expect(result.failure.refusal.detail).toMatchObject({ Code: 'UNKNOWN_DU_CASE' });
  });

  it('refuses an edit to a field the kind does not declare, and changes nothing', async () => {
    const { host, client } = page(tree());
    await client.hello();
    const before = JSON.stringify(host.current());
    const result = await client.apply(updateProp('c', 'NotAField', 'x'));
    expect(result.ok).toBe(false);
    if (result.ok || result.failure.kind !== 'refusal') return;
    expect(result.failure.refusal.class).toBe('VALIDATOR_REJECT');
    expect(JSON.stringify(host.current())).toBe(before);
  });
});

describe('coherence while something else drives the same page', () => {
  const readTree = async (client: RelayClient): Promise<TreeSnapshot> => {
    const result = await client.readTree();
    if (!result.ok) throw new Error('read.tree failed');
    return result.value;
  };

  it('reports a host-caused change through the subscription, marked as such', async () => {
    const { host, client } = page(tree());
    await client.hello();
    const changes: { revision: string; cause: string }[] = [];
    client.onChanged((change) =>
      changes.push({ revision: change.treeRevision, cause: change.cause }),
    );
    await client.subscribe();

    host.mutate({ $type: 'RemoveNode', target: 'card' });
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    expect(changes).toHaveLength(1);
    // `host`, not `apply`: this client did not cause it, and crediting itself
    // would make a concurrent writer's change look like its own echo.
    expect(changes[0]?.cause).toBe('host');
  });

  it('re-resolves a selection whose node another writer removed', async () => {
    const { host, client } = page(
      node('root', 'Box', {}, [
        node('card', 'Box', {}, [
          node('inner', 'Heading', { level: 1, text: 'T', variant: 'Standard' }),
        ]),
      ]),
    );
    await client.hello();

    const before = await readTree(client);
    const selectedPath = ['root', 'card', 'inner'];
    expect(reresolve(before, selectedPath)).toEqual(selectedPath);

    host.mutate({ $type: 'RemoveNode', target: 'inner' });
    const after = await readTree(client);

    // The deepest SURVIVING id on the path wins: the user's place in the tree
    // is roughly where it was, and the selection still addresses a live node.
    expect(reresolve(after, selectedPath)).toEqual(['root', 'card']);
  });

  it('falls back to the root when nothing on the path survives', async () => {
    const { host, client } = page(tree());
    await client.hello();
    host.mutate({ $type: 'RemoveNode', target: 'card' });
    const after = await readTree(client);
    expect(reresolve(after, ['root', 'card'])).toEqual(['root']);
  });

  it('addresses an edit by id after a concurrent insert shifted the indices', async () => {
    const { host, client } = page(tree());
    await client.hello();
    const before = await readTree(client);
    const target = before.children[2]!.id; // 'c' — the third child, today.

    // An AI inserts above it. An op composed against an INDEX would now land on
    // the wrong node and succeed, which is the failure this whole design is
    // arranged to prevent.
    host.mutate({
      $type: 'Batch',
      ops: [
        {
          $type: 'InsertChild',
          child: { id: 'ai-1', kind: { $type: 'Heading', level: 2, text: 'AI' } },
          parentId: 'root',
        },
        { $type: 'ReorderChildren', newOrder: ['ai-1', 'metric-1', 'card', 'c'], parentId: 'root' },
      ],
    });

    expect((await client.apply(updateProp(target, 'Level', 4))).ok).toBe(true);
    expect(kindOf(host, 'c')['level']).toBe(4);
    // The node now at index 2 is a different node, and it was not touched.
    const after = await readTree(client);
    expect(after.children[2]?.id).toBe('card');
  });

  it('refuses cleanly for a node that vanished under the affordance', async () => {
    const { host, client } = page(tree());
    await client.hello();
    host.mutate({ $type: 'RemoveNode', target: 'card' });

    const result = await client.apply(removeNode('card'));
    expect(result.ok).toBe(false);
    if (result.ok || result.failure.kind !== 'refusal') return;
    // A refusal naming the vanished node, not silence and not a crash.
    expect(result.failure.refusal.message).toContain('card');
  });

  it('keeps the sibling list a reorder must name in step with the live tree', async () => {
    const { host, client } = page(tree());
    await client.hello();
    host.mutate({
      $type: 'InsertChild',
      child: { id: 'ai-2', kind: { $type: 'Heading', level: 2, text: 'AI' } },
      parentId: 'root',
    });
    const after = await readTree(client);
    // Read from the tree AS IT IS NOW: a cached sibling list would be missing
    // `ai-2`, and a reorder that omits a sibling is refused outright.
    expect(siblingIds(after, 'card')).toEqual(['metric-1', 'card', 'c', 'ai-2']);
  });
});
