// ============================================================================
//  Two peers, one window — and why the injected one yields.
//
//  A host tier ships its own relay peer. This extension injects one too. Both
//  then listen on the same window and both answer the same request, and on the
//  READ side that is merely wasteful: a client keeps the first `hello.ok` and
//  discards the second, and two identical tree snapshots are still one tree.
//
//  On the WRITE side it is a correctness failure. Each peer independently calls
//  the host's apply path, so a single `apply` is applied TWICE. An `UpdateProp`
//  hides it; an `InsertChild` inserts two subtrees or half-fails on a duplicate
//  id. These tests pin the yielding, including the case that makes it necessary.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { foreignPeerTell, installPagePeer, PEER_IDENTITY } from '../src/page-relay.js';
import type { RelayEnvelope } from '../src/relay/protocol.js';

/**
 * A window that delivers `postMessage` to its own `message` listeners, as a
 * real one does — and keeps listeners PER EVENT TYPE, which is not a detail:
 * a fake that fires every listener on every event delivers `pagehide` to the
 * teardown handler on the first message, and the peer tears itself down before
 * answering anything.
 */
const fakeWindow = () => {
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  const posted: RelayEnvelope[] = [];
  const win = {
    origin: 'https://example.test',
    addEventListener: (type: string, handler: (event: MessageEvent) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, handler: (event: MessageEvent) => void) => {
      listeners.get(type)?.delete(handler);
    },
    postMessage: (data: unknown) => {
      posted.push(data as RelayEnvelope);
      for (const handler of [...(listeners.get('message') ?? [])])
        handler({ source: win, origin: win.origin, data } as unknown as MessageEvent);
    },
  };
  return {
    win: win as unknown as Window,
    posted,
    listenerCount: () => listeners.get('message')?.size ?? 0,
  };
};

const surface = (record: (op: unknown) => void) => ({
  version: '0.1.0',
  canApply: true,
  treeRevision: () => 'r-1',
  inspectTree: () => ({ id: 'root', kind: 'Box', bindings: [], childIds: [], children: [] }),
  getNodeState: () => ({ id: 'root', kind: 'Box', bindings: [], childIds: [] }),
  apply: (op: unknown) => {
    record(op);
    return { ok: true, status: 'applied', treeRevision: 'r-2' };
  },
});

const request = (id: string, type: string, payload: Record<string, unknown> = {}) => ({
  $relay: 'relay@1.0',
  dir: 'request' as const,
  id,
  type,
  payload,
});

describe('detecting a second peer', () => {
  it('reads a hello.ok from a different host as another peer', () => {
    const envelope = {
      $relay: 'relay@1.0',
      dir: 'response',
      id: 'c-1',
      type: 'hello.ok',
      payload: { host: 'fuaran-ts' },
    } as RelayEnvelope;
    expect(foreignPeerTell(envelope, new Map(), PEER_IDENTITY.host)).toBe(true);
  });

  it('does not mistake its OWN reply coming back for another peer', () => {
    // A window delivers `postMessage` to itself, so a peer always sees its own
    // response. Counting that as a second peer would make the injected peer
    // stand down on every page, including the ones where it is the only one.
    const envelope = {
      $relay: 'relay@1.0',
      dir: 'response',
      id: 'c-1',
      type: 'hello.ok',
      payload: { host: PEER_IDENTITY.host },
    } as RelayEnvelope;
    expect(foreignPeerTell(envelope, new Map([['c-1', 0]]), PEER_IDENTITY.host)).toBe(false);
  });

  it('reads a SECOND response for one id as another peer', () => {
    // The tell that does not need a handshake: both peers answer with the same
    // correlation id, so only the count distinguishes "mine came back" from
    // "someone else answered too".
    const envelope = {
      $relay: 'relay@1.0',
      dir: 'response',
      id: 'c-4',
      type: 'read.tree.ok',
      payload: {},
    } as RelayEnvelope;
    expect(foreignPeerTell(envelope, new Map([['c-4', 1]]), PEER_IDENTITY.host)).toBe(true);
  });

  it('ignores requests entirely — a request is not evidence of a peer', () => {
    expect(
      foreignPeerTell(request('c-1', 'hello') as RelayEnvelope, new Map(), PEER_IDENTITY.host),
    ).toBe(false);
  });
});

describe('the injected peer yields to a host peer', () => {
  it('serves normally when it is the only peer on the page', () => {
    const applied: unknown[] = [];
    const { win, posted } = fakeWindow();
    (win as unknown as Record<string, unknown>)['__fuaran'] = surface((op) => applied.push(op));
    const uninstall = installPagePeer(win);

    win.postMessage(request('c-1', 'hello', { accepts: ['relay@1.0'] }), win.origin);
    expect(posted.filter((entry) => entry.type === 'hello.ok')).toHaveLength(1);

    win.postMessage(request('c-2', 'apply', { op: { $type: 'UpdateProp' } }), win.origin);
    expect(applied).toHaveLength(1);
    uninstall();
  });

  it('stops answering once another peer has replied, so an op applies ONCE', () => {
    const applied: unknown[] = [];
    const { win, posted, listenerCount } = fakeWindow();
    (win as unknown as Record<string, unknown>)['__fuaran'] = surface((op) => applied.push(op));
    installPagePeer(win);
    const before = listenerCount();

    // The host's own peer answers the handshake first.
    win.postMessage(
      {
        $relay: 'relay@1.0',
        dir: 'response',
        id: 'c-1',
        type: 'hello.ok',
        payload: { host: 'fuaran-ts' },
      },
      win.origin,
    );
    expect(listenerCount()).toBe(before - 1);

    // Now the client proposes an op. The host's peer will serve it; ours must
    // not, or the op lands twice.
    posted.length = 0;
    win.postMessage(request('c-2', 'apply', { op: { $type: 'UpdateProp' } }), win.origin);
    expect(applied).toEqual([]);
    expect(posted.filter((entry) => entry.dir === 'response')).toEqual([]);
  });

  it('yields on a duplicated response even with no handshake to learn from', () => {
    const applied: unknown[] = [];
    const { win } = fakeWindow();
    (win as unknown as Record<string, unknown>)['__fuaran'] = surface((op) => applied.push(op));
    installPagePeer(win);

    // Our peer answers (its own reply comes back, count 0 → 1), then the other
    // peer's reply for the same id arrives (count 1 → stand down).
    win.postMessage(request('c-1', 'read.tree'), win.origin);
    win.postMessage(
      { $relay: 'relay@1.0', dir: 'response', id: 'c-1', type: 'read.tree.ok', payload: {} },
      win.origin,
    );

    win.postMessage(request('c-2', 'apply', { op: { $type: 'UpdateProp' } }), win.origin);
    expect(applied).toEqual([]);
  });

  it('releases its listener and subscriptions when uninstalled', () => {
    const { win, listenerCount } = fakeWindow();
    (win as unknown as Record<string, unknown>)['__fuaran'] = surface(() => undefined);
    const before = listenerCount();
    const uninstall = installPagePeer(win);
    expect(listenerCount()).toBe(before + 1);
    uninstall();
    uninstall(); // idempotent — a second teardown must not remove someone else's listener
    expect(listenerCount()).toBe(before);
  });
});
