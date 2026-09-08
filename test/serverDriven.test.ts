// ============================================================================
//  The treeless surface a server-driven page presents (DEVTOOLS_RELAY §6.5).
//
//  The corpus fixtures assert what a peer over such a surface puts on the wire.
//  This asserts the half that decides whether such a surface is built at all —
//  the detection, what it does and does not offer, and where its
//  `upstreamReachable` answer comes from — because every one of those is a
//  claim about the PAGE that the wire cannot check.
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  DISCONNECTED_ATTRIBUTE,
  isServerDrivenPage,
  serverDrivenSurface,
} from '../src/inspect/serverDriven.js';
import { createPagePeer } from '../src/relay/pagePeer.js';
import { capabilitiesOf } from '../src/relay/pagePeer.js';

const IDENTITY = { host: 'fuaran-devtools-page-relay', hostVersion: '0.1.0' };
const SURFACE_KEY = '__fuaran';

const page = (html: string): Document => {
  document.body.innerHTML = html;
  document.documentElement.removeAttribute(DISCONNECTED_ATTRIBUTE);
  return document;
};

describe('server-driven pages (§6.5)', () => {
  it('is a server-driven page when the shim is present and no debug surface is', () => {
    expect(isServerDrivenPage({ FuaranLive: {} }, SURFACE_KEY)).toBe(true);
  });

  it('is NOT one when the host also exposes its tree in the page', () => {
    // The order between the two shapes is the point: a page carrying both is a
    // host that drives from the server AND publishes its tree locally, and its
    // tree surface is the richer, truer answer. Declaring `upstream` there
    // would be a false statement about where the tree is.
    expect(isServerDrivenPage({ FuaranLive: {}, [SURFACE_KEY]: { inspectTree: () => ({}) } }, SURFACE_KEY)).toBe(
      false,
    );
  });

  it('is not one on a page with neither', () => {
    expect(isServerDrivenPage({}, SURFACE_KEY)).toBe(false);
    expect(isServerDrivenPage(null, SURFACE_KEY)).toBe(false);
  });

  it('offers `read.renderedDom` and nothing else (§6.4, §6.5 rule 2)', () => {
    // Not an abbreviation of a page-tree host's set — the honest one. Every
    // absent read is absent because answering it would mean reconstructing a
    // tree from the patches this page has applied, which §6.5 rule 2 forbids
    // and no client could detect.
    const surface = serverDrivenSurface(page(''), { FuaranLive: {} });
    expect(capabilitiesOf(surface)).toEqual(['read.renderedDom']);
    expect(surface.treeSource).toBe('upstream');
    expect(surface.inspectTree).toBeUndefined();
    expect(surface.getNodeJson).toBeUndefined();
    expect(surface.apply).toBeUndefined();
  });

  it('declares `treeSource: "upstream"` through the peer, and serves geometry', () => {
    const doc = page('<div data-fuaran-node-id="row-1">x</div>');
    const peer = createPagePeer(serverDrivenSurface(doc, { FuaranLive: {} }), IDENTITY);

    const handshake = peer.handle({
      $relay: 'relay@1.4',
      dir: 'request',
      id: 'c-1',
      type: 'hello',
      payload: { client: 'x', clientVersion: '1', accepts: ['relay@1.4'] },
    });
    expect(handshake?.payload['treeSource']).toBe('upstream');
    expect(handshake?.payload['capabilities']).toEqual(['read.renderedDom']);

    const geometry = peer.handle({
      $relay: 'relay@1.4',
      dir: 'request',
      id: 'c-2',
      type: 'read.renderedDom',
      payload: { nodeId: 'row-1' },
    });
    expect(geometry?.type).toBe('read.renderedDom.ok');
    expect(typeof geometry?.payload['hidden']).toBe('boolean');
  });

  it('reads reachability from the shim’s OWN disconnected marker (§9.3)', () => {
    // This is what makes `UPSTREAM_UNAVAILABLE` raisable with no correlated
    // response leg at all: "no channel is established" is a fact held locally.
    // The shim already publishes it on <html> to style a reconnecting banner,
    // so reading it is the same page-local fact rather than a second protocol.
    const doc = page('<div data-fuaran-node-id="row-1">x</div>');
    const surface = serverDrivenSurface(doc, { FuaranLive: {} });
    expect(surface.upstreamReachable?.()).toBe(true);
    doc.documentElement.setAttribute(DISCONNECTED_ATTRIBUTE, '');
    expect(surface.upstreamReachable?.()).toBe(false);
  });

  it('still answers geometry while the stream is down', () => {
    // The refusal covers requests the TREE would answer. Geometry is the page's
    // own, so a disconnected stream is irrelevant to it — and a peer that
    // refused it anyway would be reporting a channel fault as the cause of an
    // outcome the channel had nothing to do with.
    const doc = page('<div data-fuaran-node-id="row-1">x</div>');
    doc.documentElement.setAttribute(DISCONNECTED_ATTRIBUTE, '');
    const peer = createPagePeer(serverDrivenSurface(doc, { FuaranLive: {} }), IDENTITY);
    const geometry = peer.handle({
      $relay: 'relay@1.4',
      dir: 'request',
      id: 'c-3',
      type: 'read.renderedDom',
      payload: { nodeId: 'row-1' },
    });
    expect(geometry?.type).toBe('read.renderedDom.ok');
  });

  it('refuses a tree read CAPABILITY_ABSENT, not UPSTREAM_UNAVAILABLE (§10.1)', () => {
    // Two refusals that could both be argued for, and only one is right. This
    // peer never advertised `read.tree`, so the answer is about the
    // advertisement — an unreachable upstream does not retract one, and
    // reporting a channel fault here would tell a client to retry something
    // this peer will not serve however well the channel is working.
    const doc = page('<div data-fuaran-node-id="row-1">x</div>');
    doc.documentElement.setAttribute(DISCONNECTED_ATTRIBUTE, '');
    const peer = createPagePeer(serverDrivenSurface(doc, { FuaranLive: {} }), IDENTITY);
    const refused = peer.handle({
      $relay: 'relay@1.4',
      dir: 'request',
      id: 'c-4',
      type: 'read.tree',
      payload: {},
    });
    expect(refused?.payload['class']).toBe('CAPABILITY_ABSENT');
  });
});
