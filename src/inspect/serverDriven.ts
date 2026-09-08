// ============================================================================
//  inspect/serverDriven — the surface for a page whose tree is not in it.
//
//  A server-driven page (the tier where the session tree lives on the server
//  and the browser half is a patch applier) registers no `window.__fuaran`.
//  There is nothing for the page peer to wrap, and until `relay@1.4` there was
//  nothing honest for it to SAY either: the contract described only peers whose
//  tree is in the page, so such a page had to advertise tree reads it could not
//  serve or advertise nothing and be invisible.
//
//  DEVTOOLS_RELAY §6.5 answers that. The peer declares `treeSource: "upstream"`
//  and advertises what it can genuinely serve — which today is `read.renderedDom`
//  (§7.4) and nothing else, because that is the one read that asks the DOM a
//  geometry question rather than asking the tree. This module builds exactly
//  that surface.
//
//  TWO THINGS IT DELIBERATELY DOES NOT DO.
//
//   1. It does not reconstruct a tree. §6.5 rule 2 forbids answering a tree
//      read by encoding a tree derived from the patches the page has applied —
//      that is §7.7 rule 1's "second projection", and a client has no way to
//      detect that it received one. So there is no `inspectTree`, no
//      `getNodeState`, no `getNodeJson` here, and their absence is what makes
//      the peer refuse them `CAPABILITY_ABSENT` rather than answer them wrongly.
//   2. It does not claim `apply`. Reaching the tree needs a correlated response
//      on the channel, and this tier's channel is push-frames outbound and
//      fire-and-forget inbound. A capability set that grows when that lands is
//      exactly the growth §5.3 and §6.3 are built to absorb.
// ============================================================================

import type { HostSurface } from '../relay/pagePeer.js';
import { elementForNodeId } from './detect.js';

/** The global the server-driven browser shim registers. */
const SHIM_KEY = 'FuaranLive';

/**
 * The attribute the shim stamps on `<html>` while its stream is down.
 *
 * This is the whole reason an upstream-tree peer can raise
 * `UPSTREAM_UNAVAILABLE` at all without a response leg (§9.3): "no channel is
 * established" is a fact held LOCALLY, needing no answer from anywhere. The
 * shim already publishes it, to style a reconnecting banner; reading it is not
 * a second protocol, it is the same page-local fact.
 */
export const DISCONNECTED_ATTRIBUTE = 'data-fuaran-disconnected';

/**
 * Is this page driven from the server — a shim present, and no in-page
 * introspection surface?
 *
 * The order of the two tests is the point. A page carrying BOTH is a host that
 * drives from the server AND exposes its tree in the page; its `__fuaran` is a
 * real tree surface and the ordinary page-tree peer is the right answer for it,
 * so this returns `false` and nothing here applies. Only the absence of
 * `__fuaran` makes the treeless shape the honest one.
 */
export const isServerDrivenPage = (win: unknown, surfaceKey: string): boolean => {
  const globals = win as Record<string, unknown> | null;
  if (globals === null || typeof globals !== 'object') return false;
  const shim = globals[SHIM_KEY];
  if (typeof shim !== 'object' || shim === null) return false;
  const surface = globals[surfaceKey];
  return typeof surface !== 'object' || surface === null;
};

/** §7.4's payload, read straight off the rendered element. */
const geometryOf = (doc: Document, nodeId: string): unknown => {
  const element = elementForNodeId(doc, nodeId);
  if (element === null) return { error: `No rendered element for node '${nodeId}'.` };
  const box = element.getBoundingClientRect();
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    // Both are properties of the ELEMENT, not of the tree — which is why this
    // read survives the tree living somewhere else.
    overflowing: element.scrollWidth > element.clientWidth + 1,
    hidden: box.width === 0 && box.height === 0,
  };
};

/**
 * The surface a server-driven page presents to the relay page peer.
 *
 * `version` is the shim's own, when it publishes one. `treeRevision` is
 * deliberately ABSENT rather than synthesised: §5.4's token is the host's, and
 * a token this peer invented would be compared by a client against one the
 * upstream host issued and would never match. The peer's own fallback for a
 * surface that publishes none is what applies, and it says `r-none` — which is
 * the truth here.
 */
export const serverDrivenSurface = (doc: Document, win?: unknown): HostSurface => {
  const shim =
    win !== null && typeof win === 'object'
      ? (win as Record<string, unknown>)[SHIM_KEY]
      : undefined;
  const version =
    typeof shim === 'object' && shim !== null && typeof (shim as Record<string, unknown>)['version'] === 'string'
      ? ((shim as Record<string, unknown>)['version'] as string)
      : undefined;

  return {
    ...(version === undefined ? {} : { version }),
    treeSource: 'upstream',
    getRenderedDom: (nodeId: string) => geometryOf(doc, nodeId),
    upstreamReachable: () => !doc.documentElement.hasAttribute(DISCONNECTED_ATTRIBUTE),
  };
};
