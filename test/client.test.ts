import { describe, expect, it, vi } from 'vitest';

import { RelayClient, windowTransport, type RelayTransport } from '../src/relay/client.js';
import { ok, refusal, RELAY_PROFILE, type RelayEnvelope } from '../src/relay/protocol.js';

const harness = (reply?: (envelope: RelayEnvelope) => RelayEnvelope | undefined) => {
  const sent: RelayEnvelope[] = [];
  let handler: ((envelope: RelayEnvelope) => void) | undefined;
  const transport: RelayTransport = {
    post(envelope) {
      sent.push(envelope);
      const response = reply?.(envelope);
      if (response !== undefined) queueMicrotask(() => handler?.(response));
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
    helloTimeoutMs: 5,
    requestTimeoutMs: 5,
  });
  return { peer, sent, deliver: (envelope: RelayEnvelope) => handler?.(envelope) };
};

describe('request shape (§6.2)', () => {
  it('sends the profile, a unique id, and a non-empty accepts list', async () => {
    const { peer, sent } = harness((envelope) =>
      ok(envelope.id, 'hello', {
        host: 'h',
        hostVersion: '1',
        surfaceVersion: '1',
        profile: RELAY_PROFILE,
        capabilities: ['read.tree'],
        treeRevision: 'r-1',
      }),
    );
    await peer.hello();
    await peer.readTree();

    expect(sent).toHaveLength(2);
    expect(sent[0]?.$relay).toBe(RELAY_PROFILE);
    expect(sent[0]?.payload['accepts']).toEqual([RELAY_PROFILE]);
    expect(sent[0]?.id).not.toBe(sent[1]?.id);
    // §7.2: `read.tree` takes an empty payload — never absent, never a bare
    // value; a type with no data carries `{}` (§4).
    expect(sent[1]?.payload).toEqual({});
  });
});

describe('correlation (§4.1, §10.4)', () => {
  it('ignores a response whose id matches nothing outstanding', async () => {
    const { peer, deliver } = harness();
    const pending = peer.readTree();
    deliver(ok('c-999', 'read.tree', { id: 'root', kind: 'Box', bindings: [], childIds: [] }));
    const result = await pending;
    // The stray response changed nothing; the request timed out on its own.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('silent');
  });

  it('reports silence rather than hanging when no peer answers', async () => {
    const { peer } = harness();
    const result = await peer.hello();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('silent');
  });

  it('waits at least a second before concluding no peer is present (§6.1)', () => {
    const schedule = vi.fn((_fn: () => void, ms: number) => ms);
    const peer = new RelayClient(
      { post: () => undefined, listen: () => () => undefined },
      { client: 'c', clientVersion: '1', schedule, cancel: () => undefined },
    );
    void peer.hello();
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(1000);
  });
});

describe('capability pre-check (§6.4)', () => {
  it('does not put a known-absent capability on the wire at all', async () => {
    const { peer, sent } = harness((envelope) =>
      ok(envelope.id, 'hello', {
        host: 'h',
        hostVersion: '1',
        surfaceVersion: '1',
        profile: RELAY_PROFILE,
        capabilities: ['read.tree'],
        treeRevision: 'r-1',
      }),
    );
    await peer.hello();
    const before = sent.length;

    const result = await peer.readNodeState('metric-1');
    expect(sent).toHaveLength(before);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('capabilityAbsent');
  });

  it('issues freely before a handshake, since nothing is yet known', async () => {
    const { peer, sent } = harness();
    await peer.readNodeState('metric-1');
    expect(sent).toHaveLength(1);
  });
});

describe('response validation (§4.2)', () => {
  it('rejects a response whose type is neither <type>.ok nor refusal', async () => {
    const { peer } = harness((envelope) => ok(envelope.id, 'read.nodeState', {}));
    const result = await peer.readTree();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('malformed');
  });

  it('rejects a well-typed response carrying the wrong payload shape', async () => {
    const { peer } = harness((envelope) => ok(envelope.id, 'read.tree', { id: 7 }));
    const result = await peer.readTree();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('malformed');
  });

  it('carries a refusal through by class', async () => {
    const { peer } = harness((envelope) =>
      refusal(envelope.id, 'read.tree', 'NOT_OPTED_IN', 'off.'),
    );
    const result = await peer.readTree();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.failure.kind !== 'refusal') return;
    expect(result.failure.refusal.class).toBe('NOT_OPTED_IN');
  });
});

describe('the window transport (§3.2, §3.3)', () => {
  it('posts to the window origin, never to a wildcard', () => {
    const post = vi.fn();
    const win = {
      origin: 'https://app.example',
      postMessage: post,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as Window;

    windowTransport(win).post(ok('c-1', 'hello', {}));
    expect(post).toHaveBeenCalledWith(expect.anything(), 'https://app.example');
    expect(post).not.toHaveBeenCalledWith(expect.anything(), '*');
  });

  it('drops a cross-origin, cross-source, or foreign-profile message', () => {
    const listeners: ((event: MessageEvent) => void)[] = [];
    const win = {
      origin: 'https://app.example',
      postMessage: () => undefined,
      addEventListener: (_type: string, fn: (event: MessageEvent) => void) => listeners.push(fn),
      removeEventListener: () => undefined,
    } as unknown as Window;

    const seen: RelayEnvelope[] = [];
    windowTransport(win).listen((envelope) => seen.push(envelope));

    const good = ok('c-1', 'hello', {});
    const fire = (event: Partial<MessageEvent>): void =>
      listeners.forEach((fn) => fn(event as MessageEvent));

    fire({ source: {} as never, origin: 'https://app.example', data: good });
    fire({ source: win as never, origin: 'https://evil.example', data: good });
    fire({
      source: win as never,
      origin: 'https://app.example',
      data: { $relay: 'relay@2.0', dir: 'response', id: 'c-1', type: 'hello.ok', payload: {} },
    });
    // §4: a client ignores requests.
    fire({
      source: win as never,
      origin: 'https://app.example',
      data: { ...good, dir: 'request' },
    });
    expect(seen).toEqual([]);

    fire({ source: win as never, origin: 'https://app.example', data: good });
    expect(seen).toEqual([good]);
  });
});
