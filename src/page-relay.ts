// ============================================================================
//  page-relay — the MAIN-world entry point: install the relay page peer.
//
//  This file is injected into the inspected page's own JavaScript world (the
//  content script adds it as a `<script src=…>` from the extension's
//  web-accessible resources). It runs there because that is the only context
//  that can reach `window.__fuaran` — a page global is invisible from a
//  content script's isolated world.
//
//  What it exposes is EXACTLY what the page already exposed. `window.__fuaran`
//  is registered by the host itself, only in a debug build, and is already
//  reachable by any script on the page — including the browser console, which
//  is what it was built for. The peer wraps it in the `relay@1.0` envelope so
//  a structured client can use it; it adds no entry point the page did not
//  already have. That now includes the host's own policy-gated `apply` and its
//  change subscription, which are surface methods like any other (§11.3).
//
//  ── Two peers, one window ──────────────────────────────────────────────────
//
//  A host tier may install its OWN relay peer (the renderer packages ship one).
//  Both peers then listen on the same window and both answer the same request:
//  two `hello.ok`s advertising possibly-different capabilities, of which a
//  client keeps whichever raced in first, and — far worse on the write side —
//  TWO applications of a single `apply`, because each peer independently calls
//  the host's apply path. An `UpdateProp` applied twice is invisible; an
//  `InsertChild` applied twice inserts two subtrees, or is half-refused on the
//  duplicate id.
//
//  So this peer YIELDS. It watches the traffic it is already receiving and
//  stands down permanently the moment it can prove another peer serves this
//  page, by either of two independent tells (see `installPagePeer`). Yielding
//  is the right direction: the host's own peer is closer to the host, ships
//  with it, and is the one the host opted into.
// ============================================================================

import { acceptsMessageEvent, isRelayEnvelope, type RelayEnvelope } from './relay/protocol.js';
import { createPagePeer, EXTENSION_PEER_HOST, type HostSurface } from './relay/pagePeer.js';

const SURFACE_KEY = '__fuaran';

/** Identification this peer reports in `hello.ok` (§6.3) — display only. */
export const PEER_IDENTITY = {
  host: EXTENSION_PEER_HOST,
  hostVersion: '0.1.0',
} as const;

/** Read the host's in-page surface, if the host registered one. */
const readSurface = (win: Window): HostSurface | undefined => {
  const candidate = (win as unknown as Record<string, unknown>)[SURFACE_KEY];
  return typeof candidate === 'object' && candidate !== null
    ? (candidate as HostSurface)
    : undefined;
};

/**
 * Decide, from one inbound RESPONSE envelope, whether another peer is serving
 * this page. Pure, so the rule is testable without a window.
 *
 * Two independent tells, because neither alone covers every host:
 *
 *  1. A `hello.ok` naming a different `host` than this peer reports. Cheap,
 *     and decisive on the first exchange of the session.
 *  2. A SECOND response carrying an id this peer already answered. Both peers
 *     answer the same request with the same correlation id, so counting is the
 *     only way to tell "my reply came back" (postMessage delivers to the
 *     sending window too, so it always does) from "someone else replied as
 *     well". This covers a host peer that never sees a `hello` — one that
 *     joined the page after the handshake, say.
 */
export const foreignPeerTell = (
  envelope: RelayEnvelope,
  answered: ReadonlyMap<string, number>,
  ownHost: string,
): boolean => {
  if (envelope.dir !== 'response') return false;
  if (envelope.type === 'hello.ok') {
    const host = envelope.payload['host'];
    if (typeof host === 'string' && host !== ownHost) return true;
  }
  return (answered.get(envelope.id) ?? 0) >= 1;
};

/**
 * Install the peer's listener. The surface is read PER MESSAGE, not captured
 * at install time: a host registers its debug global from a React effect and
 * REPLACES it on every tree change, so a peer that snapshotted
 * `window.__fuaran` at document_idle would report "no debug surface" forever
 * on an app that mounted a millisecond later — and, once mounted, would answer
 * every later request from the tree that was live when it was built.
 */
export const installPagePeer = (win: Window): (() => void) => {
  const peer = createPagePeer(() => readSurface(win), PEER_IDENTITY, {
    // §3.3: `window.origin`, never `"*"`.
    emit: (event) => win.postMessage(event, win.origin),
  });

  /** Ids this peer has answered, and how many responses have come back for each. */
  const answered = new Map<string, number>();
  let installed = true;

  const uninstall = (): void => {
    if (!installed) return;
    installed = false;
    win.removeEventListener('message', onMessage);
    win.removeEventListener('pagehide', onUnload);
    // §8.5: every subscription is released on teardown, and a released
    // subscription emits nothing further.
    peer.dispose();
  };

  function onUnload(): void {
    uninstall();
  }

  function onMessage(event: MessageEvent): void {
    // §3.2: all four checks, in order, and a failure means SILENCE — not even
    // a refusal, since a refusal to an unverified peer is itself a disclosure
    // that a Fuaran host is present (§11.4).
    if (!acceptsMessageEvent(event, win, win)) return;

    // Responses are not this peer's business to answer (§4), but they are its
    // business to LEARN from — this is where a second peer becomes visible.
    if (isRelayEnvelope(event.data) && event.data.dir !== 'request') {
      if (foreignPeerTell(event.data, answered, PEER_IDENTITY.host)) {
        uninstall();
        return;
      }
      if (answered.has(event.data.id))
        answered.set(event.data.id, (answered.get(event.data.id) ?? 0) + 1);
      return;
    }

    const response: RelayEnvelope | undefined = peer.handle(event.data);
    if (response === undefined) return;

    // An entry is only needed for the length of one exchange, so the map is
    // bounded rather than kept for the tab's lifetime — an inspector must not
    // be the thing that leaks on a long-lived page.
    if (answered.size > 64) {
      const oldest = answered.keys().next();
      if (!oldest.done) answered.delete(oldest.value);
    }
    answered.set(response.id, answered.get(response.id) ?? 0);
    win.postMessage(response, win.origin);
  }

  win.addEventListener('message', onMessage);
  win.addEventListener('pagehide', onUnload);
  return uninstall;
};

installPagePeer(window);
