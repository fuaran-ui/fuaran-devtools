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
  bridgeChanged,
  bridgeErr,
  bridgeEvent,
  bridgeOk,
  isBridgeRequest,
  type ApplyResult,
  type BridgeEvent,
  type BridgeRequest,
  type BridgeResponse,
  type StatusResult,
} from './bridge.js';
import { hasFuaranMarkup, markedElementCount } from './inspect/detect.js';
import { hideHighlight, showHighlight } from './inspect/overlay.js';
import { startPicking } from './inspect/picker.js';
import { RelayClient, windowTransport, type RelayFailure } from './relay/client.js';
import { EXTENSION_PEER_HOST } from './relay/pagePeer.js';

const CLIENT_NAME = 'fuaran-devtools';
const CLIENT_VERSION = '0.1.0';
const PAGE_RELAY_FILE = 'page-relay.js';

let injected = false;
let client: RelayClient | undefined;
let stopPicking: (() => void) | undefined;
/** The tab's one live subscription id, if `watch` has established one. */
let subscriptionId: string | undefined;
let watching = false;

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
  if (client === undefined) {
    client = new RelayClient(windowTransport(window), {
      client: CLIENT_NAME,
      clientVersion: CLIENT_VERSION,
    });
    // Registered ONCE, with the client, rather than per subscription: a handler
    // added on each `watch` would deliver one event N times after N refreshes,
    // and the panel cannot tell a repeated event from a repeated change.
    client.onChanged((change) => emit(bridgeChanged(change.treeRevision, change.cause)));
  }
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
  let result = await relayClient().hello();

  // A page may carry TWO peers — the host's own, and the one this extension
  // injects — and both answer the same `hello`, of which a client keeps
  // whichever raced in first (§10.4 discards the other). The injected peer
  // stands down for good once it has seen the other's reply, so a handshake
  // answered by OUR peer does not yet prove there is no host peer behind it.
  // Re-probe exactly once in that case: what comes back the second time is
  // either the host's own richer capability set, or our peer again, which
  // settles it. The alternative is a panel that reports a fully apply-capable
  // page as read-only until someone presses Refresh.
  if (result.ok && result.value.host === EXTENSION_PEER_HOST) {
    const second = await relayClient().hello();
    if (second.ok) result = second;
  }

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

const requireObject = (request: BridgeRequest, key: string): Readonly<Record<string, unknown>> => {
  const value = request.args?.[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`'${request.method}' needs an object '${key}'.`);
  return value as Readonly<Record<string, unknown>>;
};

/**
 * Propose one op. The refusal CLASS survives into the result rather than being
 * flattened into a message — see `ApplyResult`. The three failure kinds that
 * are not host refusals (silence, a locally-known absent capability, a
 * malformed response) are given contract class names too, so the panel has one
 * branch rather than two vocabularies.
 */
const applyOp = async (
  op: Readonly<Record<string, unknown>>,
  attribution: { readonly actor: string; readonly reason?: string },
): Promise<ApplyResult> => {
  const result = await relayClient().apply(op, attribution);
  if (result.ok) return { ok: true, treeRevision: result.value.treeRevision };
  const failure = result.failure;
  switch (failure.kind) {
    case 'refusal':
      return {
        ok: false,
        class: failure.refusal.class,
        message: failure.refusal.message,
        ...(failure.refusal.detail === undefined ? {} : { detail: failure.refusal.detail }),
      };
    case 'capabilityAbsent':
      return {
        ok: false,
        class: 'CAPABILITY_ABSENT',
        message: `This page does not offer '${failure.capability}'.`,
      };
    case 'silent':
      // NOT reported as a refusal class: nothing refused it, and the op's fate
      // is genuinely unknown — the panel must say so rather than imply the
      // tree is unchanged, which is the one thing a refusal would promise.
      return { ok: false, class: 'NO_ANSWER', message: 'The page did not answer in time.' };
    case 'malformed':
      return { ok: false, class: 'MALFORMED_RESPONSE', message: failure.message };
  }
};

/**
 * Establish the tab's change subscription, once. Idempotent by design: every
 * panel refresh calls it, a second subscription would double every event, and
 * the panel has no way to tell one stream from two.
 */
const watch = async (): Promise<{ readonly watching: boolean; readonly reason?: string }> => {
  if (watching) return { watching: true };
  const relay = relayClient();
  if (!relay.can('subscribe'))
    return { watching: false, reason: 'This page offers no change subscription.' };

  const result = await relay.subscribe();
  if (!result.ok) return { watching: false, reason: describe(result.failure) };
  subscriptionId = result.value.subscriptionId;
  watching = true;
  return { watching: true };
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
    case 'apply':
      return applyOp(requireObject(request, 'op'), {
        actor: CLIENT_NAME,
        // Advisory only (§8.2). It is provenance for the host's audit trail —
        // it buys this client nothing and must not.
        reason:
          typeof request.args?.['reason'] === 'string'
            ? (request.args['reason'] as string)
            : 'edited from the inspector',
      });
    case 'watch':
      return watch();
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

// The page is going; drop any overlay, stop any pick in progress, and release
// the subscription (§8.5), so the page is left exactly as it was found.
window.addEventListener('pagehide', () => {
  stopPicking?.();
  hideHighlight(document);
  if (subscriptionId !== undefined) {
    void client?.unsubscribe(subscriptionId).catch(() => undefined);
    subscriptionId = undefined;
    watching = false;
  }
});
