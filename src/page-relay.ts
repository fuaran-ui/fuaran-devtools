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
//  already have, and it serves no mutation at all (the page peer built here
//  is read-only by construction — see `relay/pagePeer`).
// ============================================================================

import { acceptsMessageEvent, type RelayEnvelope } from './relay/protocol.js';
import { createPagePeer, type HostSurface } from './relay/pagePeer.js';

const SURFACE_KEY = '__fuaran';

/** Read the host's in-page surface, if the host registered one. */
const readSurface = (win: Window): HostSurface | undefined => {
  const candidate = (win as unknown as Record<string, unknown>)[SURFACE_KEY];
  return typeof candidate === 'object' && candidate !== null
    ? (candidate as HostSurface)
    : undefined;
};

/**
 * Install the peer's listener. The surface is read PER MESSAGE, not captured
 * at install time: a host registers its debug global from a React effect, so a
 * peer that snapshotted `window.__fuaran` at document_idle would report
 * "no debug surface" forever on an app that mounted a millisecond later.
 */
export const installPagePeer = (win: Window): (() => void) => {
  const onMessage = (event: MessageEvent): void => {
    // §3.2: all four checks, in order, and a failure means SILENCE — not even
    // a refusal, since a refusal to an unverified peer is itself a disclosure
    // that a Fuaran host is present (§11.4).
    if (!acceptsMessageEvent(event, win, win)) return;

    const peer = createPagePeer(readSurface(win), {
      host: 'fuaran-devtools-page-relay',
      hostVersion: '0.1.0',
    });
    const response: RelayEnvelope | undefined = peer.handle(event.data);
    if (response === undefined) return;

    // §3.3: `window.origin`, never `"*"`.
    win.postMessage(response, win.origin);
  };

  win.addEventListener('message', onMessage);
  return () => win.removeEventListener('message', onMessage);
};

installPagePeer(window);
