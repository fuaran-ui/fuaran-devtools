import { describe, expect, it } from 'vitest';

import {
  adaptBindingValue,
  adaptFoundNodes,
  capabilitiesOf,
  createPagePeer,
  digest,
  type HostSurface,
} from '../src/relay/pagePeer.js';
import { request } from '../src/relay/protocol.js';
import { bareHost, taggedHost } from './support/fakeHost.js';

const IDENTITY = { host: 'fuaran-devtools-page-relay', hostVersion: '0.1.0' };
// NOT a default parameter: `peer(undefined)` would then silently mean
// `peer(bareHost)`, and the absent-surface tests would assert nothing.
const peer = (surface: HostSurface = bareHost) => createPagePeer(surface, IDENTITY);
const peerWithNoSurface = () => createPagePeer(undefined, IDENTITY);

describe('the §1.4 adaptations', () => {
  it('wraps a bare findNodes array into an object', () => {
    // A bare array in one payload slot blocks additive fields and makes generic
    // envelope handling special-case one type — hence the canonical object.
    expect(adaptFoundNodes(['a', 'b'])).toEqual({ nodeIds: ['a', 'b'] });
    expect(adaptFoundNodes(undefined)).toEqual({ nodeIds: [] });
    expect(adaptFoundNodes([1, 'b', null])).toEqual({ nodeIds: ['b'] });
  });

  it('recovers the binding identity a bare resolution drops', () => {
    const identity = { expression: '$state.revenue', source: 'State' };
    expect(adaptBindingValue({ kind: 'Resolved', value: 42 }, identity)).toEqual({
      status: 'resolved',
      value: 42,
      ...identity,
    });
    expect(adaptBindingValue({ kind: 'NotResolved' }, identity)).toEqual({
      status: 'notResolved',
      ...identity,
    });
    expect(adaptBindingValue({ kind: 'Errored', message: 'boom' }, identity)).toEqual({
      status: 'errored',
      message: 'boom',
      ...identity,
    });
    expect(adaptBindingValue({ kind: 'I18nUnresolved', key: 'greeting' }, identity)).toEqual({
      status: 'i18nUnresolved',
      key: 'greeting',
      ...identity,
    });
  });

  it('passes an already-tagged envelope through, keeping its own identity', () => {
    const tagged = { status: 'noOverride', expression: '$none', source: 'Static' };
    expect(adaptBindingValue(tagged, { expression: '$state.x', source: 'State' })).toEqual(tagged);
  });

  it('preserves a resolved null, which is a value and not an absence', () => {
    const identity = { expression: '$static', source: 'Static' };
    const adapted = adaptBindingValue({ kind: 'Resolved', value: null }, identity);
    expect(adapted).toEqual({ status: 'resolved', value: null, ...identity });
  });
});

describe('tree revision (§5.4)', () => {
  it('is stable for equal input and differs for different input', () => {
    expect(digest('abc')).toBe(digest('abc'));
    expect(digest('abc')).not.toBe(digest('abd'));
    expect(digest('')).toMatch(/^r-[0-9a-f]{8}$/);
  });

  it('changes when the tree changes', () => {
    const first = peer().handle(request('c-1', 'hello', { accepts: ['relay@1.0'] }));
    const mutated: HostSurface = { ...bareHost, inspectTree: () => ({ id: 'root', kind: 'Card' }) };
    const second = createPagePeer(mutated, IDENTITY).handle(
      request('c-2', 'hello', { accepts: ['relay@1.0'] }),
    );
    expect(first?.payload['treeRevision']).not.toBe(second?.payload['treeRevision']);
  });
});

describe('capability advertisement (§6.3, §6.4)', () => {
  it('advertises only what the surface offers, and never a mutation', () => {
    expect(capabilitiesOf(bareHost)).toEqual([
      'read.nodeState',
      'read.bindingValue',
      'read.renderedDom',
      'read.tree',
      'read.findNodes',
    ]);
    expect(capabilitiesOf({ inspectTree: () => ({}) })).toEqual(['read.tree']);
    expect(capabilitiesOf({})).toEqual([]);
  });

  it('refuses an un-advertised read with CAPABILITY_ABSENT, not UNKNOWN_MESSAGE', () => {
    // §10.1: reporting the wrong one tells the client something false — either
    // that a real entry point does not exist, or that a fictional one is off.
    const thin = peer({ inspectTree: () => ({ id: 'root', kind: 'Box' }) });
    const denied = thin.handle(request('c-1', 'read.findNodes', { kind: 'Metric' }));
    expect(denied?.payload['class']).toBe('CAPABILITY_ABSENT');
    expect(denied?.payload['detail']).toEqual({ capability: 'read.findNodes' });
  });
});

describe('refusal ordering and the malformed cases', () => {
  it('answers NOT_OPTED_IN before anything else, disclosing nothing (§11.1, §11.4)', () => {
    const absent = peerWithNoSurface();
    for (const type of ['hello', 'read.tree', 'apply'] as const) {
      const denied = absent.handle(request('c-1', type, {}));
      expect(denied?.payload['class']).toBe('NOT_OPTED_IN');
      // No `supported`, no capabilities, no version — a prober learns only
      // that a host is here.
      expect('detail' in (denied?.payload ?? {})).toBe(false);
    }
  });

  it('refuses an empty accepts array as malformed, naming the path', () => {
    const denied = peer().handle(request('c-1', 'hello', { accepts: [] }));
    expect(denied?.payload['class']).toBe('MALFORMED_MESSAGE');
    expect(denied?.payload['detail']).toEqual({ path: 'payload.accepts' });
  });

  it('refuses a hello whose accepts names no profile it speaks', () => {
    const denied = peer().handle(request('c-1', 'hello', { accepts: ['relay@9.9'] }));
    expect(denied?.payload['class']).toBe('FOREIGN_PROFILE');
  });

  it.each([
    ['read.nodeState', {}, 'payload.nodeId'],
    ['read.renderedDom', {}, 'payload.nodeId'],
    ['read.findNodes', {}, 'payload.kind'],
    ['read.bindingValue', { nodeId: 'metric-1' }, 'payload.slot'],
    ['read.bindingValue', {}, 'payload.nodeId'],
  ] as const)('refuses %s with a missing field as malformed', (type, payload, path) => {
    const denied = peer().handle(request('c-1', type, payload));
    expect(denied?.payload['class']).toBe('MALFORMED_MESSAGE');
    expect(denied?.payload['detail']).toEqual({ path });
  });

  it('answers an unknown kind with an empty list, never a refusal (§7.5)', () => {
    const answer = peer().handle(request('c-1', 'read.findNodes', { kind: 'Nonexistent' }));
    expect(answer?.type).toBe('read.findNodes.ok');
    expect(answer?.payload['nodeIds']).toEqual([]);
  });

  it('keeps noOverride and SLOT_NOT_DECLARED distinct (§7.3)', () => {
    // A declared-but-unset slot on a relay-shaped surface is a STATUS…
    const status = createPagePeer(taggedHost, IDENTITY).handle(
      request('c-1', 'read.bindingValue', { nodeId: 'metric-1', slot: 'Trend' }),
    );
    expect(status?.type).toBe('read.bindingValue.ok');
    expect(status?.payload['status']).toBe('noOverride');

    // …while a slot that is not a binding slot at all is a REFUSAL.
    const denied = createPagePeer(taggedHost, IDENTITY).handle(
      request('c-2', 'read.bindingValue', { nodeId: 'metric-1', slot: 'Source' }),
    );
    expect(denied?.payload['class']).toBe('SLOT_NOT_DECLARED');
  });

  it('never synthesises noOverride from a bare surface that cannot tell them apart', () => {
    const denied = peer().handle(
      request('c-1', 'read.bindingValue', { nodeId: 'metric-1', slot: 'Trend' }),
    );
    expect(denied?.payload['class']).toBe('SLOT_NOT_DECLARED');
  });

  it('answers exactly one response per request, even when the surface throws', () => {
    const hostile: HostSurface = {
      inspectTree: () => {
        throw new Error('the host blew up');
      },
    };
    const answer = peer(hostile).handle(request('c-1', 'read.tree', {}));
    expect(answer?.type).toBe('refusal');
    expect(answer?.payload['message']).toBe('the host blew up');
  });
});

describe('what the peer ignores entirely', () => {
  it.each([
    ['a response', { $relay: 'relay@1.0', dir: 'response', id: 'c-1', type: 'x.ok', payload: {} }],
    ['an event', { $relay: 'relay@1.0', dir: 'event', id: 'c-1', type: 'changed', payload: {} }],
    ['a non-envelope', { hello: true }],
    ['a string', 'relay@1.0'],
    ['null', null],
  ])('says nothing at all to %s', (_label, message) => {
    expect(peer().handle(message)).toBeUndefined();
  });
});
