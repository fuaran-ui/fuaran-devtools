// ============================================================================
//  background — the MV3 service-worker router.
//
//  A DevTools panel page cannot message a tab's content scripts directly, so
//  each panel opens a long-lived port here carrying the id of the tab it
//  inspects; every bridge request is forwarded to that tab and the response is
//  posted back on the port. Content-script events travel the other way.
//
//  Stateless beyond a port's lifetime: nothing is cached, nothing is inspected
//  beyond the envelope guard, and no page data is retained here.
// ============================================================================

import { bridgeErr, isBridgeEvent, isBridgeRequest, PANEL_PORT } from './bridge.js';

/** The panel → background message: a bridge request plus the tab it is for. */
interface RoutedRequest {
  readonly tabId: number;
  readonly request: unknown;
}

const isRouted = (value: unknown): value is RoutedRequest =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as RoutedRequest).tabId === 'number' &&
  isBridgeRequest((value as RoutedRequest).request);

/** Open panel ports, keyed by inspected tab, so events can be fanned to them. */
const ports = new Map<number, Set<chrome.runtime.Port>>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT) return;
  let ownTabId: number | undefined;

  port.onMessage.addListener((message: unknown) => {
    if (!isRouted(message)) return;
    const { tabId, request } = message;

    if (ownTabId === undefined) {
      ownTabId = tabId;
      const set = ports.get(tabId) ?? new Set();
      set.add(port);
      ports.set(tabId, set);
    }

    chrome.tabs
      .sendMessage(tabId, request)
      .then((response) => port.postMessage(response))
      .catch((error: unknown) =>
        port.postMessage(
          bridgeErr(
            (request as { id: number }).id,
            error instanceof Error
              ? error.message
              : 'Could not reach the inspected tab — reload the page after installing the extension.',
          ),
        ),
      );
  });

  port.onDisconnect.addListener(() => {
    if (ownTabId === undefined) return;
    const set = ports.get(ownTabId);
    set?.delete(port);
    if (set !== undefined && set.size === 0) ports.delete(ownTabId);
  });
});

// Content-script events (a completed pick) fan out to that tab's panels only.
chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!isBridgeEvent(message)) return;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  for (const port of ports.get(tabId) ?? []) port.postMessage(message);
});
