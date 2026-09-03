// ============================================================================
//  Read-modify-write, end to end: panel → client → page peer → host → back.
//
//  `readModifyWrite.test.ts` drives the editor's DOM against a stubbed context;
//  this drives the WHOLE PATH against a host holding a real mutable tree, with
//  both halves of the relay this extension ships wired to each other over a
//  transport that behaves as `window.postMessage` does.
//
//  The two are not redundant, and the division is deliberate. A DOM test can
//  assert that the panel composed the right op; only this can assert that the
//  op, having crossed the wire and been applied by a host, left the tree in the
//  state the user asked for — which is where the phase's acceptance criteria
//  actually live:
//
//   * a style edit through the real `UpdateStyle` leaves every other token
//     standing, on RE-READ rather than in the op the panel composed;
//   * an indexed path derived from a read addresses the column it named, after
//     a concurrent writer moved the tree;
//   * the staleness path is driven against a host mutating its own tree
//     mid-session, per the 737 write-side test shape.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { RelayClient, type RelayTransport } from '../src/relay/client.js';
import { createPagePeer } from '../src/relay/pagePeer.js';
import type { RelayEnvelope } from '../src/relay/protocol.js';
import { updateProp, updateStyle } from '../src/edit/ops.js';
import { collectionLength, styleBlock, valueAtPath } from '../src/panel/nodeJson.js';
import { liveHost, node, type LiveNode } from './support/liveHost.js';

const IDENTITY = { host: 'fuaran-devtools-page-relay', hostVersion: '0.1.0' };

const page = (initial: LiveNode) => {
  const host = liveHost(initial);
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

const column = (label: string): Record<string, unknown> => ({
  kind: { $type: 'Text' },
  label,
  value: '<closure>',
});

const tree = (): LiveNode =>
  node('root', 'Box', {}, [
    node('metric-1', 'Metric', { label: 'Revenue', value: '<closure>' }, [], {
      emphasis: 'Loud',
      tone: 'Success',
      weight: 'Spacious',
    }),
    node('grid-1', 'DataGrid', { columns: [column('Channel'), column('Revenue')] }),
  ]);

/** The node's wire JSON, read the way the panel reads it. */
const readJson = async (client: RelayClient, nodeId: string) => {
  const result = await client.readNodeJson(nodeId);
  expect(result.ok, 'the read was refused').toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
};

describe('the read arrives, whole, and with what the tree holds', () => {
  it('is advertised and served, at the profile that introduced it', async () => {
    const { client } = page(tree());
    const handshake = await client.hello();
    expect(handshake.ok).toBe(true);
    if (!handshake.ok) return;
    expect(handshake.value.profile).toBe('relay@1.3');
    expect(handshake.value.capabilities).toContain('read.nodeJson');
  });

  it('carries the whole subtree and the values a structural read omits', async () => {
    const { client } = page(tree());
    await client.hello();
    const read = await readJson(client, 'root');

    // The structural read reports a kind DISCRIMINATOR and no values; this one
    // reports the kind OBJECT and every value, for the whole subtree.
    const kind = read.node['kind'] as Record<string, unknown>;
    expect(kind['$type']).toBe('Box');
    expect(JSON.stringify(read.node)).toContain('metric-1');
    // Children live INSIDE `kind` in the wire form, not beside it as the
    // structural snapshot puts them — so `Children` is an ordinary kind
    // property that resolves like any other. (It is excluded from the editable
    // field set for a different reason: node-valued fields belong to the
    // structural ops, which address them by id rather than by value.)
    expect((valueAtPath(read.node, 'Children') as unknown[]).length).toBe(2);
    expect(kind['children']).toBe(valueAtPath(read.node, 'Children'));
    expect(read.treeRevision).not.toBe('');
  });

  it('refuses a node that is not there, and says which class', async () => {
    const { client } = page(tree());
    await client.hello();
    const result = await client.readNodeJson('nope');
    expect(result.ok).toBe(false);
    if (result.ok || result.failure.kind !== 'refusal') return;
    expect(result.failure.refusal.class).toBe('NODE_NOT_FOUND');
  });
});

describe('a style edit preserves the rest of the block — on re-read', () => {
  it('changes one token and leaves the others standing', async () => {
    const { client } = page(tree());
    await client.hello();

    // The panel's own sequence: read the block, merge one token over it, commit
    // the whole thing.
    const before = await readJson(client, 'metric-1');
    const block = styleBlock(before.node);
    expect(block).toEqual({ emphasis: 'Loud', tone: 'Success', weight: 'Spacious' });

    const applied = await client.apply(updateStyle('metric-1', { ...block, tone: 'Critical' }));
    expect(applied.ok).toBe(true);

    const after = await readJson(client, 'metric-1');
    // The falsifier the phase asks for: the host REPLACED the block, so if the
    // panel had committed `{ tone }` alone the other two would be gone here.
    expect(styleBlock(after.node)).toEqual({
      emphasis: 'Loud',
      tone: 'Critical',
      weight: 'Spacious',
    });
  });

  it('goes red if the whole block is not carried — the falsifier, falsified', async () => {
    const { client } = page(tree());
    await client.hello();
    // Committing the one token the way a panel with no read would have had to.
    await client.apply(updateStyle('metric-1', { tone: 'Critical' }));
    const after = await readJson(client, 'metric-1');
    // This is what the surface was withheld to avoid, shown happening: two
    // tokens the user never touched are gone.
    expect(styleBlock(after.node)).toEqual({ tone: 'Critical' });
  });
});

describe('indexed paths, against a host that moves under them', () => {
  it('addresses the column the read named', async () => {
    const { client } = page(tree());
    await client.hello();

    const read = await readJson(client, 'grid-1');
    expect(collectionLength(read.node, 'Columns')).toBe(2);
    expect(valueAtPath(read.node, 'Columns[1].Label')).toBe('Revenue');

    const applied = await client.apply(updateProp('grid-1', 'Columns[1].Label', 'Turnover'));
    expect(applied.ok).toBe(true);

    const after = await readJson(client, 'grid-1');
    expect(valueAtPath(after.node, 'Columns[1].Label')).toBe('Turnover');
    // The neighbour is untouched: an indexed path names one member of one
    // element, and nothing else.
    expect(valueAtPath(after.node, 'Columns[0].Label')).toBe('Channel');
  });

  it('re-derives the length after a concurrent writer shortened the collection', async () => {
    const { host, client } = page(tree());
    await client.hello();

    const stale = await readJson(client, 'grid-1');
    expect(collectionLength(stale.node, 'Columns')).toBe(2);

    // Something else drives the page — an AI, another panel, the app itself.
    host.mutate(updateProp('grid-1', 'Columns', [column('Channel')]));

    const fresh = await readJson(client, 'grid-1');
    expect(fresh.treeRevision).not.toBe(stale.treeRevision);
    // The re-derived length is what the panel checks an index against before
    // composing an op, which is why `Columns[1]` is refused rather than sent.
    expect(collectionLength(fresh.node, 'Columns')).toBe(1);
  });
});

describe('the staleness posture, against a host mutating its own tree', () => {
  it('reports a revision that moves, so a stale read is detectable at all', async () => {
    const { host, client } = page(tree());
    await client.hello();

    const read = await readJson(client, 'metric-1');
    host.mutate(updateProp('metric-1', 'Label', 'Set by something else'));
    const after = await readJson(client, 'metric-1');

    // Compared, never parsed (§5.4). Equality is the whole specified property,
    // and it is what the editor's re-anchor decision rests on.
    expect(after.treeRevision).not.toBe(read.treeRevision);
    expect(valueAtPath(after.node, 'Label')).toBe('Set by something else');
  });

  it('lets a re-derived edit land on the tree that actually exists', async () => {
    const { host, client } = page(tree());
    await client.hello();

    const stale = await readJson(client, 'metric-1');
    host.mutate(updateProp('metric-1', 'Label', 'Someone else was here'));

    // The panel's staleness path: re-read, re-diff, then commit. The value the
    // user typed is still what they meant; what changed is the tree it lands
    // on, and re-diffing is how the panel finds out whether it is still an edit.
    const fresh = await readJson(client, 'metric-1');
    expect(valueAtPath(fresh.node, 'Label')).not.toBe(valueAtPath(stale.node, 'Label'));

    const applied = await client.apply(updateProp('metric-1', 'Label', 'Net revenue'));
    expect(applied.ok).toBe(true);
    const after = await readJson(client, 'metric-1');
    expect(valueAtPath(after.node, 'Label')).toBe('Net revenue');
    // And the concurrent writer's OTHER work is untouched, because the op named
    // one field rather than re-asserting everything the panel had read.
    expect(styleBlock(after.node)).toEqual({
      emphasis: 'Loud',
      tone: 'Success',
      weight: 'Spacious',
    });
  });
});

describe('sentinels cross the wire verbatim, and are never sent back', () => {
  it('serves a sentinel rather than refusing the node that carries one', async () => {
    const { client } = page(tree());
    await client.hello();
    const read = await readJson(client, 'metric-1');
    // §7.7 rule 2: an encoding WITH sentinels is the canonical encoding of that
    // node, so withholding it would withhold the answer that was asked for.
    expect(valueAtPath(read.node, 'Value')).toBe('<closure>');
    expect(valueAtPath(read.node, 'Label')).toBe('Revenue');
  });

  it('shows what round-tripping one would do, which is why nothing does', async () => {
    const { client } = page(tree());
    await client.hello();
    // Not a path the panel offers — the sentinel rows carry no control and the
    // commit guard checks the value again. Driven here to pin the CONSEQUENCE
    // the rule exists to prevent: the sentinel lands as the literal string it
    // looks like, and the affordance it stood for is gone.
    await client.apply(updateProp('metric-1', 'Value', '<closure>'));
    const after = await readJson(client, 'metric-1');
    expect(valueAtPath(after.node, 'Value')).toBe('<closure>');
    // Indistinguishable, on the wire, from the closure it replaced. That is the
    // whole argument for the guard being in the editor rather than the host.
  });
});
