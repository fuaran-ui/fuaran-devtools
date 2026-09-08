// ============================================================================
//  The relay conformance corpus, driven through the PAGE PEER.
//
//  For every fixture the read-only peer can serve: feed the fixture's request
//  envelope in, and assert the response satisfies §12.3 — the request's type
//  plus `.ok` (or `refusal` with the declared class), the request's id echoed
//  verbatim, and every field the fixture's payload declares present with the
//  stated JSON type.
//
//  The fixtures this peer CANNOT serve are enumerated with a reason, and the
//  partition is asserted to be total: a fixture added to the corpus that falls
//  into neither list fails the suite rather than being silently unexercised.
//  That check is the point of the table — a conformance run whose coverage can
//  drift without anyone noticing is not a conformance run.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { createPagePeer, type HostSurface } from '../src/relay/pagePeer.js';
import { negotiate, RELAY_PROFILE, type RelayEnvelope } from '../src/relay/protocol.js';
import { readFixture, readManifest } from './support/corpus.js';
import { describeMismatches, shapeMismatches } from './support/shape.js';
import {
  applyHost,
  applyHostWith,
  bareHost,
  encodeFailingHost,
  nodeJsonHost,
  taggedHost,
  unreachableUpstreamHost,
  upstreamHost,
} from './support/fakeHost.js';

const IDENTITY = { host: 'fuaran-devtools-page-relay', hostVersion: '0.1.0' };

/** Which surface each servable fixture is driven against. */
const SERVED: Record<string, HostSurface | undefined> = {
  'hello-read-only': bareHost,
  'read-node-state': bareHost,
  'read-tree': bareHost,
  'read-binding-value-resolved': bareHost,
  'read-rendered-dom': bareHost,
  'read-find-nodes': bareHost,
  'read-find-nodes-empty': bareHost,
  'refusal-node-not-found': bareHost,
  'refusal-slot-not-declared': bareHost,
  'refusal-capability-absent': bareHost,
  'refusal-unknown-message': bareHost,
  'refusal-foreign-profile': bareHost,
  // A host whose surface already emits the canonical tagged envelope is the
  // only one that can report `noOverride` (§7.3) — see `fakeHost`.
  'read-binding-value-no-override': taggedHost,
  // The absent-surface case: `undefined` is the "no in-page debug surface"
  // state, and §11.1 permits the minimal listener that answers NOT_OPTED_IN.
  'refusal-not-opted-in': undefined,

  // ── the write side ──
  //
  // Every one of these is driven against a host that wired an apply path and a
  // change hub. What the peer contributes is the §8.3 MAPPING — the host's own
  // envelope status onto the contract's refusal classes — so a fixture passing
  // here is evidence about the mapping, not about the fake.
  'hello-apply-capable': applyHost,
  'apply-accepted': applyHost,
  subscribe: applyHost,
  unsubscribe: applyHost,
  'refusal-validator-reject': applyHost,
  'refusal-policy-denied': applyHost,
  'refusal-decode-failed': applyHost,
  'refusal-malformed-message': applyHost,
  // (`refusal-capability-absent` stays on the READ-ONLY host above: the
  // fixture's whole content is a host that does not offer apply, so serving it
  // from an apply-capable one would assert nothing.)

  // ── `relay@1.3` — the node's own wire JSON (§7.7) ──
  //
  // A surface that serves the read, so the peer advertises and serves it. The
  // two `relay@1.0` handshakes above stay on hosts WITHOUT it — that pairing is
  // what makes the corpus evidence about §6.3's per-minor gating rather than
  // about one host's capability list.
  'hello-node-json': nodeJsonHost,
  'read-node-json': nodeJsonHost,
  'read-node-json-subtree': nodeJsonHost,
  'refusal-encode-failed': encodeFailingHost,

  // ── `relay@1.4` — the peer whose tree is not in the page (§6.5) ──
  //
  // These are the corpus's first `"peer": "upstream"` fixtures, and this
  // extension serves them because it BUILDS such a peer: a page carrying the
  // server-driven shim and no in-page introspection global gets the treeless
  // surface (`inspect/serverDriven`), which is what `upstreamHost` stands in
  // for here. A page-tree host has no peer of this shape and never will, which
  // is why the manifest declares the shape at all.
  'hello-treeless': upstreamHost,
  'hello-treeless-1-3-client': upstreamHost,
  'refusal-capability-absent-treeless': upstreamHost,
  // The later-stage peer: it advertises the proxied reads and cannot reach the
  // far side. Stubbed exactly as `refusal-encode-failed` is, and for the same
  // reason — what the fixture pins is the peer's mapping of "the request would
  // not leave" onto the class.
  'refusal-upstream-unavailable': unreachableUpstreamHost,
};

/**
 * Fixtures no REQUEST can reach, because they are not responses.
 *
 * The change events are covered separately below — they are emitted, not
 * answered, so the request-driven loop cannot exercise them. Enumerating them
 * here keeps the partition total: a fixture added to the corpus that falls
 * into neither list still fails the suite.
 */
const NOT_SERVED: Record<string, string> = {
  'changed-apply': 'an event: emitted by a subscription, never a response to a request',
  'changed-host': 'an event: emitted by a subscription, never a response to a request',
};

const manifest = readManifest();

describe('relay corpus — page peer', () => {
  it('serves every minor the corpus reaches', () => {
    // The manifest's `profile` is the HIGHEST minor the fixtures reach, not a
    // claim that every minor below it is covered — the corpus legitimately
    // holds fixtures at two minors, because a minor's fixtures land when a
    // SECOND host serves it and minors do not reach their second host in order.
    //
    // So the assertion is that this peer can SERVE that minor, not that it
    // equals it. Pinning equality is what made this line go red the moment the
    // corpus advanced, which was the right alarm and the wrong assertion: it
    // says a peer is only conformant against a corpus frozen at its own
    // version.
    expect(negotiate(manifest.profile)).not.toBe('Foreign');
    expect(negotiate(manifest.profile)).toBe('Current');
  });

  it('classifies every fixture as served or explicitly out of reach', () => {
    const unclassified = manifest.fixtures
      .map((fixture) => fixture.id)
      .filter((id) => !(id in SERVED) && !(id in NOT_SERVED));
    expect(unclassified).toEqual([]);
  });

  for (const fixture of manifest.fixtures) {
    if (!(fixture.id in SERVED)) continue;
    const requestFile = fixture.requestFile;
    const responseFile = fixture.responseFile;
    if (requestFile === undefined || responseFile === undefined) continue;

    it(`serves ${fixture.id}`, () => {
      const request = readFixture(requestFile);
      const expected = readFixture(responseFile);
      const peer = createPagePeer(SERVED[fixture.id], IDENTITY);

      const actual = peer.handle(request);
      expect(actual, 'the peer produced no response').toBeDefined();
      if (actual === undefined) return;

      // §4.1 — the id is echoed verbatim, refusals included.
      expect(actual.id).toBe(request['id']);
      // §4 — `$relay` is the SENDER's own profile id, so it is asserted against
      // this peer's id and not the fixture's. A fixture written at one minor and
      // answered by a peer at another carries two different ids by construction,
      // and both are right; a runner pinning the fixture's value would be
      // testing the fixture author's version rather than this implementation's
      // conformance.
      expect(actual.$relay).toBe(RELAY_PROFILE);
      // §4.2 — `<type>.ok` or `refusal`; there is no third outcome.
      expect(actual.type).toBe(expected['type']);
      if (fixture.kind === 'relay-refusal') {
        expect(actual.type).toBe('refusal');
        expect(actual.payload['class']).toBe(fixture.expectedClass);
      }

      const mismatches = shapeMismatches(expected, actual);
      expect(mismatches, `\n${describeMismatches(mismatches)}\n`).toEqual([]);
    });
  }

  // ── §7.7 rule 3, which no shape comparison can reach ──
  //
  // The `read-node-json-subtree` fixture's own manifest entry says why it needs
  // its own assertion: an ELIDED encoding is well-formed wire JSON for a
  // different node, so a runner checking only well-formedness passes exactly
  // what the rule forbids. The host-agnostic form of the check is the one the
  // manifest names — every child the peer itself reports for this node must
  // appear inside the encoding it returned — because kinds and child sets
  // legitimately differ between hosts while that correspondence does not.
  it('returns the whole subtree, with no child elided (§7.7 rule 3)', () => {
    const peer = createPagePeer(nodeJsonHost, IDENTITY);
    const request = readFixture('read-node-json-subtree.request.json');
    const nodeId = (request['payload'] as Record<string, unknown>)['nodeId'] as string;

    const state = peer.handle({ ...request, id: 'c-state', type: 'read.nodeState' });
    const childIds = (state?.payload['childIds'] ?? []) as readonly string[];
    expect(childIds.length, 'the fixture node must have children to elide').toBeGreaterThan(0);

    const encoded = JSON.stringify(peer.handle(request)?.payload['node']);
    for (const child of childIds)
      expect(encoded, `child '${child}' is missing from the encoding`).toContain(`"${child}"`);
    expect(nodeId).toBe('root');
  });

  // ── §6.3, the rule the profile bump made load-bearing ──
  //
  // Two halves that look like one and are not: what a session is TOLD, and what
  // it is SERVED. A peer could filter its handshake correctly and still answer
  // a request a client made anyway, which is precisely the case §11.3's "a
  // client is not a trusted component" covers.
  it('withholds a later minor’s capability from an earlier session, and serves neither', () => {
    const peer = createPagePeer(nodeJsonHost, IDENTITY);

    const older = peer.handle({
      $relay: 'relay@1.0',
      dir: 'request',
      id: 'c-1',
      type: 'hello',
      payload: { client: 'x', clientVersion: '1', accepts: ['relay@1.0'] },
    });
    expect(older?.payload['profile']).toBe('relay@1.0');
    expect(older?.payload['capabilities']).not.toContain('read.nodeJson');
    // The 1.0 set is untouched: a per-minor filter that also dropped what was
    // always there would be a backward-compatibility break wearing the costume
    // of one.
    expect(older?.payload['capabilities']).toContain('read.tree');

    const refused = peer.handle({
      $relay: 'relay@1.0',
      dir: 'request',
      id: 'c-2',
      type: 'read.nodeJson',
      payload: { nodeId: 'grid-1' },
    });
    // CAPABILITY_ABSENT, not UNKNOWN_MESSAGE: the entry point exists, and this
    // session does not have it (§10.1).
    expect(refused?.type).toBe('refusal');
    expect(refused?.payload['class']).toBe('CAPABILITY_ABSENT');

    const current = peer.handle({
      $relay: RELAY_PROFILE,
      dir: 'request',
      id: 'c-3',
      type: 'hello',
      payload: { client: 'x', clientVersion: '1', accepts: [RELAY_PROFILE, 'relay@1.0'] },
    });
    expect(current?.payload['capabilities']).toContain('read.nodeJson');
  });

  // ── §6.5 — the peer that holds no tree ──
  //
  // The fixtures above assert the SHAPES. These assert the three rules that no
  // shape comparison reaches: what a page-tree peer must NOT emit, that the
  // declaration survives negotiating down, and that the refusal is restricted
  // to the case the peer can actually assert.

  it('emits no `treeSource` at all when the tree IS in the page (§6.5)', () => {
    // Not `"page"` — ABSENT. §6.5 asks a page-tree peer to omit the field so
    // its handshake stays byte-identical to one a pre-1.4 peer would have sent,
    // which is what keeps the corpus's unchanged older handshakes evidence
    // rather than fixtures that merely happen to still pass.
    const peer = createPagePeer(nodeJsonHost, IDENTITY);
    const handshake = peer.handle(readFixture('hello-node-json.request.json'));
    expect(handshake?.payload).not.toHaveProperty('treeSource');
  });

  it('declares `treeSource` into an OLDER session too (§6.5 rule 4)', () => {
    // Unlike a capability (§6.3), the declaration is not withheld at an earlier
    // session profile: the older client drops it by §10.2 at no cost, and
    // withholding it would leave a `relay@1.4` client that negotiated down
    // unable to tell two genuinely different peers apart. The capability set is
    // still filtered per minor, and this asserts both at once.
    const peer = createPagePeer(upstreamHost, IDENTITY);
    const older = peer.handle({
      $relay: 'relay@1.0',
      dir: 'request',
      id: 'c-70',
      type: 'hello',
      payload: { client: 'x', clientVersion: '1', accepts: ['relay@1.0'] },
    });
    expect(older?.payload['profile']).toBe('relay@1.0');
    expect(older?.payload['treeSource']).toBe('upstream');
    expect(older?.payload['capabilities']).toEqual(['read.renderedDom']);
  });

  it('serves the one read that asks the DOM, on a page whose tree is upstream (§7.4)', () => {
    // The reason the tier is not simply blocked: `read.renderedDom` asks the
    // rendered element a geometry question and never asks the tree, so it is
    // servable with no channel to the far side at all.
    const peer = createPagePeer(upstreamHost, IDENTITY);
    const geometry = peer.handle(readFixture('read-rendered-dom.request.json'));
    expect(geometry?.type).toBe('read.renderedDom.ok');
    expect(typeof geometry?.payload['width']).toBe('number');
  });

  it('raises UPSTREAM_UNAVAILABLE only for a read the TREE would answer (§9.3)', () => {
    // The restriction, from the other side: the same unreachable peer answers
    // `read.renderedDom` normally, because that request never needed the far
    // side. A peer that refused it too would be reporting a channel fault as
    // the cause of an outcome the channel has nothing to do with.
    const peer = createPagePeer(unreachableUpstreamHost, IDENTITY);
    const geometry = peer.handle(readFixture('read-rendered-dom.request.json'));
    expect(geometry?.type).toBe('read.renderedDom.ok');

    const refused = peer.handle(readFixture('refusal-upstream-unavailable.request.json'));
    expect(refused?.payload['class']).toBe('UPSTREAM_UNAVAILABLE');
    expect((refused?.payload['detail'] as Record<string, unknown>)['reason']).toBe('no-channel');
  });

  it('never raises UPSTREAM_UNAVAILABLE from a page-tree peer (§9.3)', () => {
    // The class says "this peer declares its tree is upstream and could not
    // dispatch". A peer whose tree is in the page has nothing to dispatch and
    // no far side to be unable to reach, so the class is unreachable for it —
    // asserted rather than assumed, because the guard is one boolean away from
    // firing on every host that ever fails a read.
    const peer = createPagePeer({ ...nodeJsonHost, upstreamReachable: () => false }, IDENTITY);
    const answered = peer.handle(readFixture('read-node-json.request.json'));
    expect(answered?.type).toBe('read.nodeJson.ok');
  });

  it('agrees with the corpus about which fixtures address which peer shape (§12.2)', () => {
    // The SERVED table above is this runner's private knowledge; `peer` is the
    // corpus's declaration. Checking them against each other is what stops the
    // table drifting into a claim the corpus does not make — a fixture retagged
    // upstream would otherwise keep passing here against a page-tree fake.
    const upstreamFixtures = manifest.fixtures
      .filter((fixture) => fixture.peer === 'upstream')
      .map((fixture) => fixture.id);
    expect(upstreamFixtures.length).toBeGreaterThan(0);
    for (const id of upstreamFixtures)
      expect(SERVED[id]?.treeSource, `${id} must be driven against an upstream-tree surface`).toBe(
        'upstream',
      );
    for (const fixture of manifest.fixtures) {
      if (fixture.peer !== undefined && fixture.peer !== 'page' && fixture.peer !== 'upstream')
        throw new Error(`${fixture.id} declares an unrecognised peer shape '${fixture.peer}'`);
      if (fixture.peer === 'upstream') continue;
      expect(SERVED[fixture.id]?.treeSource, `${fixture.id} is a page-tree fixture`).not.toBe(
        'upstream',
      );
    }
  });

  it('advertises nothing about a read the surface does not serve', () => {
    // §6.4: a capability is a fact about the surface in front of the peer. A
    // 1.3 peer over a 1.0-era surface offers the 1.0 set and says so.
    const peer = createPagePeer(applyHost, IDENTITY);
    const handshake = peer.handle(readFixture('hello-node-json.request.json'));
    // `relay@1.3`, and NOT this peer's own id: the fixture's client accepts
    // nothing newer, and §6.3 selects the highest profile BOTH sides can reach.
    // The two coincided while this peer was at 1.3 and stopped coinciding when
    // it advanced — which is the backward-compatibility promise being kept,
    // asserted here rather than assumed.
    expect(handshake?.payload['profile']).toBe('relay@1.3');
    expect(handshake?.payload['capabilities']).not.toContain('read.nodeJson');
  });

  // ── the emitted half (§8.5) ──
  //
  // Events are the one part of the contract a request-driven runner cannot
  // reach: nothing asks for them. So they are driven from the other end — take
  // a subscription, make the host change, and compare what the peer PUT ON THE
  // WIRE against the fixture. Without this the peer could advertise
  // `subscribe`, answer `subscribe.ok`, and emit nothing at all, and every
  // fixture above would still pass.
  for (const fixture of manifest.fixtures.filter((entry) => entry.kind === 'relay-event')) {
    const eventFile = fixture.eventFile;
    if (eventFile === undefined) continue;

    it(`emits ${fixture.id}`, () => {
      const expected = readFixture(eventFile);
      const cause = (expected['payload'] as Record<string, unknown>)['cause'];
      const emitted: RelayEnvelope[] = [];
      const { host, driver } = applyHostWith();
      const peer = createPagePeer(host, IDENTITY, { emit: (event) => emitted.push(event) });

      const request = readFixture('subscribe.request.json');
      const established = peer.handle(request);
      expect(established?.type).toBe('subscribe.ok');

      driver.emit('r-42', String(cause));
      expect(emitted).toHaveLength(1);
      const actual = emitted[0]!;

      // §4.1: the event carries the id of the `subscribe` request that
      // established it, so a client routes it without extra state.
      expect(actual.id).toBe(request['id']);
      const mismatches = shapeMismatches(expected, actual);
      expect(mismatches, `\n${describeMismatches(mismatches)}\n`).toEqual([]);
    });
  }

  it('classifies the event fixtures as unreachable by request, with a reason', () => {
    // The partition's other half: these ids are declared out of the
    // request-driven loop's reach, and the reason is recorded beside them.
    for (const id of Object.keys(NOT_SERVED))
      expect(manifest.fixtures.find((entry) => entry.id === id)?.kind).toBe('relay-event');
  });

  it('stops emitting for a released subscription (§8.5)', () => {
    const emitted: RelayEnvelope[] = [];
    const { host, driver } = applyHostWith();
    const peer = createPagePeer(host, IDENTITY, { emit: (event) => emitted.push(event) });

    peer.handle(readFixture('subscribe.request.json'));
    driver.emit('r-42', 'apply');
    expect(emitted).toHaveLength(1);

    const released = peer.handle(readFixture('unsubscribe.request.json'));
    expect(released?.type).toBe('unsubscribe.ok');
    expect(driver.listenerCount()).toBe(0);

    driver.emit('r-43', 'host');
    // A released subscription emits NOTHING further. A peer that kept pushing
    // would leave a client re-reading a tree it had explicitly stopped watching.
    expect(emitted).toHaveLength(1);
  });

  it('releases every subscription on dispose (§8.5)', () => {
    const { host, driver } = applyHostWith();
    const peer = createPagePeer(host, IDENTITY, { emit: () => undefined });
    peer.handle(readFixture('subscribe.request.json'));
    expect(driver.listenerCount()).toBe(1);
    peer.dispose();
    expect(driver.listenerCount()).toBe(0);
  });

  it('answers `unsubscribe` for an id it never issued (§8.5)', () => {
    const peer = createPagePeer(applyHost, IDENTITY);
    const response = peer.handle({
      $relay: 'relay@1.0',
      dir: 'request',
      id: 'c-99',
      type: 'unsubscribe',
      payload: { subscriptionId: 's-does-not-exist' },
    });
    // The caller's desired end state is reached either way, so this is `ok`.
    expect(response?.type).toBe('unsubscribe.ok');
  });
});
