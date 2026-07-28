// ============================================================================
//  content — the isolated-world half: detection, injection, relay client,
//  overlay, and picker.
//
//  Four jobs, in order:
//
//   1. DETECT. Look for `data-fuaran-node-id` in the document. Nothing else
//      happens on a page that has none — no injection, no probe, no listener.
//   2. INJECT. Add the page peer (`page-relay.js`) to the page's own JS world
//      as a `<script src=…>` from the extension's web-accessible resources.
//      This route needs no `scripting` permission and no host permission,
//      which is why it is preferred over `chrome.scripting.executeScript`:
//      the extension asks for strictly less than the alternative.
//   3. SPEAK THE RELAY. This script is the `relay@1.0` CLIENT peer. Relay
//      traffic never leaves the tab (DEVTOOLS_RELAY §1.2); what crosses to the
//      panel is already-shaped result data on the extension-private bridge.
//   4. OVERLAY + PICK. Both are pure DOM work, so they live here rather than
//      in the page world — the injected script keeps the narrowest possible
//      job, which is the only one that genuinely needs page-context access.
// ============================================================================

import {
  bridgeErr,
  bridgeEvent,
  bridgeOk,
  isBridgeRequest,
  type BridgeEvent,
  type BridgeRequest,
  type BridgeResponse,
  type StatusResult,
} from './bridge.js';
import { hasFuaranMarkup, markedElementCount } from './inspect/detect.js';
import { hideHighlight, showHighlight } from './inspect/overlay.js';
import { startPicking } from './inspect/picker.js';
import { RelayClient, windowTransport, type RelayFailure } from './relay/client.js';

const CLIENT_NAME = 'fuaran-devtools';
const CLIENT_VERSION = '0.1.0';
const PAGE_RELAY_FILE = 'page-relay.js';

let injected = false;
let client: RelayClient | undefined;
let stopPicking: (() => void) | undefined;

/** Add the page peer to the page's own JS world, once. */
const injectPageRelay = (): void => {
  if (injected) return;
  injected = true;
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL(PAGE_RELAY_FILE);
  script.async = false;
  // Remove the tag once it has run: the peer's listener is installed by then,
  // and leaving an extension URL in the app's DOM would be a visible artefact
  // of an inspector that is supposed to observe without altering.
  script.addEventListener('load', () => script.remove());
  (document.head ?? document.documentElement).appendChild(script);
};

const relayClient = (): RelayClient => {
  client ??= new RelayClient(windowTransport(window), {
    client: CLIENT_NAME,
    clientVersion: CLIENT_VERSION,
  });
  return client;
};

const describe = (failure: RelayFailure): string => {
  switch (failure.kind) {
    case 'refusal':
      return `${failure.refusal.class}: ${failure.refusal.message}`;
    case 'silent':
      return 'The page did not answer within the timeout.';
    case 'capabilityAbsent':
      return `This page does not offer '${failure.capability}'.`;
    case 'malformed':
      return failure.message;
  }
};

/**
 * Detection + handshake. Deliberately re-probes on every call rather than
 * caching: a single-page app can mount its Fuaran tree long after the content
 * script ran, so a cached "no Fuaran here" would be wrong for the rest of the
 * tab's life. The panel's refresh button is what re-runs this.
 */
const status = async (): Promise<StatusResult> => {
  const markedElements = markedElementCount(document);
  if (!hasFuaranMarkup(document)) return { state: 'no-fuaran', markedElements: 0 };

  injectPageRelay();
  const result = await relayClient().hello();

  if (result.ok) {
    const info = result.value;
    return {
      state: 'connected',
      markedElements,
      host: info.host,
      hostVersion: info.hostVersion,
      surfaceVersion: info.surfaceVersion,
      profile: info.profile,
      capabilities: info.capabilities,
      treeRevision: info.treeRevision,
    };
  }

  // §6.1's detection table, rendered as the panel's two distinct empty states.
  const notOptedIn =
    result.failure.kind === 'refusal' && result.failure.refusal.class === 'NOT_OPTED_IN';
  return {
    state: notOptedIn ? 'no-surface' : 'no-peer',
    markedElements,
    message: describe(result.failure),
  };
};

const unwrap = async <T>(
  work: Promise<{ ok: true; value: T } | { ok: false; failure: RelayFailure }>,
) => {
  const result = await work;
  if (result.ok) return result.value;
  throw new Error(describe(result.failure));
};

const requireString = (request: BridgeRequest, key: string): string => {
  const value = request.args?.[key];
  if (typeof value !== 'string') throw new Error(`'${request.method}' needs a string '${key}'.`);
  return value;
};

const emit = (event: BridgeEvent): void => {
  // The panel may have closed; a dropped event is not an error worth surfacing.
  void chrome.runtime.sendMessage(event).catch(() => undefined);
};

const handle = async (request: BridgeRequest): Promise<unknown> => {
  switch (request.method) {
    case 'status':
      return status();
    case 'readTree':
      return unwrap(relayClient().readTree());
    case 'readNodeState':
      return unwrap(relayClient().readNodeState(requireString(request, 'nodeId')));
    case 'readBindingValue':
      return unwrap(
        relayClient().readBindingValue(
          requireString(request, 'nodeId'),
          requireString(request, 'slot'),
        ),
      );
    case 'readRenderedDom':
      return unwrap(relayClient().readRenderedDom(requireString(request, 'nodeId')));
    case 'highlight': {
      const nodeId = requireString(request, 'nodeId');
      const label = typeof request.args?.['kind'] === 'string' ? request.args['kind'] : undefined;
      return { shown: showHighlight(document, nodeId, label) };
    }
    case 'unhighlight':
      hideHighlight(document);
      return { shown: false };
    case 'startPick': {
      stopPicking?.();
      stopPicking = startPicking(document, {
        onHover: (nodeId) => {
          if (nodeId === undefined) hideHighlight(document);
          else showHighlight(document, nodeId);
          emit(bridgeEvent('pickHover', nodeId));
        },
        onPick: (nodeId) => {
          stopPicking = undefined;
          showHighlight(document, nodeId);
          emit(bridgeEvent('picked', nodeId));
        },
        onCancel: () => {
          stopPicking = undefined;
          hideHighlight(document);
          emit(bridgeEvent('pickCancelled'));
        },
      });
      return { picking: true };
    }
    case 'cancelPick':
      stopPicking?.();
      stopPicking = undefined;
      hideHighlight(document);
      return { picking: false };
  }
};

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (response: BridgeResponse) => void) => {
    if (!isBridgeRequest(message)) return false;
    handle(message)
      .then((result) => sendResponse(bridgeOk(message.id, result)))
      .catch((error: unknown) =>
        sendResponse(bridgeErr(message.id, error instanceof Error ? error.message : String(error))),
      );
    return true; // keep the async sendResponse channel open
  },
);

// The panel is gone; drop any overlay and stop any pick in progress, so the
// page is left exactly as it was found.
window.addEventListener('pagehide', () => {
  stopPicking?.();
  hideHighlight(document);
});
