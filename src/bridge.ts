// ============================================================================
//  bridge — the extension-private panel ↔ content-script protocol.
//
//  DELIBERATELY NOT THE RELAY. The relay contract (`relay@1.4`) governs the
//  page ↔ extension boundary and has a closed message set; carrying the
//  panel's own concerns — highlight, pick, detection status — over it would
//  make every one of them an `UNKNOWN_MESSAGE`, and would quietly turn a
//  specified protocol into an unspecified one. §1.2 says as much: carrying
//  relay traffic beyond the tab "is that implementation's own concern, outside
//  this contract". This is that concern, and it has its own envelope.
//
//  The hop chain is panel → background service worker → content script. The
//  content script is the relay CLIENT peer, so relay traffic never leaves the
//  tab: what crosses these hops is already-shaped, JSON-safe result data.
// ============================================================================

/** Marks bridge traffic — distinct from the relay's `$relay` marker. */
export const BRIDGE_FIELD = '$fuaranDevtools';
export const BRIDGE_VERSION = 1;
export const PANEL_PORT = 'fuaran-devtools-panel';

/** What the content script serves. */
export type BridgeMethod =
  /** Detection + handshake state for the inspected page. */
  | 'status'
  | 'readTree'
  | 'readNodeState'
  | 'readBindingValue'
  | 'readRenderedDom'
  /** The focused node's own canonical wire JSON (§7.7) — the read the property
   *  editor derives its current values and its indexed paths from. */
  | 'readNodeJson'
  /**
   * The node ids the RENDERER MARKED in the DOM, in document order.
   *
   * Not a relay read and deliberately not one: it asks the document, not the
   * tree, so it is the one enumeration available on a page whose tree lives
   * upstream (DEVTOOLS_RELAY §6.5) and whose `read.tree` is therefore absent.
   * §6.1 permits exactly this use of the marker — "a heuristic hint about where
   * to look" — and forbids the other one, relying on it for DETECTION, which
   * nothing here does.
   *
   * It is NOT a substitute for `read.tree` and must never be presented as one:
   * it carries no kinds, no bindings and no structure, only which elements the
   * renderer stamped. That is enough to select one and ask `read.renderedDom`
   * about it, and it is nothing else.
   */
  | 'listRendered'
  /** Propose one tree-op through the page's own gated apply path. */
  | 'apply'
  /** Establish (idempotently) the tab's change subscription. */
  | 'watch'
  | 'highlight'
  | 'unhighlight'
  | 'startPick'
  | 'cancelPick';

export interface BridgeRequest {
  readonly [BRIDGE_FIELD]: typeof BRIDGE_VERSION;
  readonly dir: 'request';
  readonly id: number;
  readonly method: BridgeMethod;
  readonly args?: Readonly<Record<string, unknown>>;
}

export type BridgeResponse =
  | {
      readonly [BRIDGE_FIELD]: typeof BRIDGE_VERSION;
      readonly dir: 'response';
      readonly id: number;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly [BRIDGE_FIELD]: typeof BRIDGE_VERSION;
      readonly dir: 'response';
      readonly id: number;
      readonly ok: false;
      readonly error: string;
    };

/** Unsolicited content → panel notifications (a completed pick, a tree change). */
export interface BridgeEvent {
  readonly [BRIDGE_FIELD]: typeof BRIDGE_VERSION;
  readonly dir: 'event';
  readonly event: 'picked' | 'pickHover' | 'pickCancelled' | 'changed';
  readonly nodeId?: string;
  /** `changed` only — the revision AFTER the change (opaque; compare, never parse). */
  readonly treeRevision?: string;
  /** `changed` only — `"apply"` or `"host"`; anything else is carried through. */
  readonly cause?: string;
}

/**
 * The panel → background registration: keys the panel's port to its inspected
 * tab so content-script events fan out to it. Sent immediately on connect —
 * including every REconnect after a service-worker suspension — so event flow
 * never waits for the next request to re-key the port.
 */
export interface PanelRegistration {
  readonly tabId: number;
  readonly register: true;
}

export const panelRegistration = (tabId: number): PanelRegistration => ({ tabId, register: true });

export const isPanelRegistration = (value: unknown): value is PanelRegistration =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as PanelRegistration).tabId === 'number' &&
  (value as PanelRegistration).register === true;

const isEnvelope = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<string, unknown>)[BRIDGE_FIELD] === BRIDGE_VERSION;

export const isBridgeRequest = (value: unknown): value is BridgeRequest =>
  isEnvelope(value) &&
  value['dir'] === 'request' &&
  typeof value['id'] === 'number' &&
  typeof value['method'] === 'string';

export const isBridgeResponse = (value: unknown): value is BridgeResponse =>
  isEnvelope(value) &&
  value['dir'] === 'response' &&
  typeof value['id'] === 'number' &&
  typeof value['ok'] === 'boolean';

export const isBridgeEvent = (value: unknown): value is BridgeEvent =>
  isEnvelope(value) && value['dir'] === 'event' && typeof value['event'] === 'string';

export const bridgeRequest = (
  id: number,
  method: BridgeMethod,
  args?: Readonly<Record<string, unknown>>,
): BridgeRequest =>
  args === undefined
    ? { [BRIDGE_FIELD]: BRIDGE_VERSION, dir: 'request', id, method }
    : { [BRIDGE_FIELD]: BRIDGE_VERSION, dir: 'request', id, method, args };

export const bridgeOk = (id: number, result: unknown): BridgeResponse => ({
  [BRIDGE_FIELD]: BRIDGE_VERSION,
  dir: 'response',
  id,
  ok: true,
  result,
});

export const bridgeErr = (id: number, error: string): BridgeResponse => ({
  [BRIDGE_FIELD]: BRIDGE_VERSION,
  dir: 'response',
  id,
  ok: false,
  error,
});

export const bridgeEvent = (event: BridgeEvent['event'], nodeId?: string): BridgeEvent =>
  nodeId === undefined
    ? { [BRIDGE_FIELD]: BRIDGE_VERSION, dir: 'event', event }
    : { [BRIDGE_FIELD]: BRIDGE_VERSION, dir: 'event', event, nodeId };

export const bridgeChanged = (treeRevision: string, cause: string): BridgeEvent => ({
  [BRIDGE_FIELD]: BRIDGE_VERSION,
  dir: 'event',
  event: 'changed',
  treeRevision,
  cause,
});

// ─── `apply` result ─────────────────────────────────────────────────

/**
 * The outcome of a proposed op, as the panel receives it.
 *
 * A refusal travels as a SUCCESSFUL bridge response carrying `ok: false`,
 * never as a bridge error. The distinction matters: the bridge's error channel
 * is a string, and collapsing a refusal into it would destroy the one field
 * the contract insists a client branches on — the machine-readable class
 * (§8.4). "The validator rejected this edit" and "the extension could not
 * reach the tab" are not the same event and must not arrive the same way.
 */
export type ApplyResult =
  | { readonly ok: true; readonly treeRevision: string }
  | {
      readonly ok: false;
      readonly class: string;
      readonly message: string;
      readonly detail?: Readonly<Record<string, unknown>>;
    };

// ─── `status` result ────────────────────────────────────────────────

/**
 * The states the panel renders. They are deliberately distinct: "there is
 * no Fuaran here" and "there is Fuaran here but no debug surface" call for
 * completely different things from the user, and collapsing them into one
 * empty state is the difference between "this extension does not work" and
 * "turn on the host's debug flag". `relay-blocked` earns the same treatment:
 * a page whose CSP refuses the injected relay is not "slow", and telling the
 * user to reload it sends them somewhere no reload can go.
 */
export type PageState =
  /** No `data-fuaran-node-id` in the document. */
  | 'no-fuaran'
  /** Fuaran markup present, but the page peer refused with NOT_OPTED_IN. */
  | 'no-surface'
  /** Fuaran markup present and the peer never answered `hello`. */
  | 'no-peer'
  /**
   * Fuaran markup present, the page's CSP blocked the relay injection, and no
   * host-registered peer answered in its place.
   */
  | 'relay-blocked'
  /** Handshake complete. */
  | 'connected';

export interface StatusResult {
  readonly state: PageState;
  readonly markedElements: number;
  readonly host?: string;
  readonly hostVersion?: string;
  readonly surfaceVersion?: string;
  readonly profile?: string;
  readonly capabilities?: readonly string[];
  /**
   * Where the peer says its tree lives (DEVTOOLS_RELAY §6.5, since
   * `relay@1.4`) — `'page'`, `'upstream'`, or a value this build does not know.
   *
   * Always populated for a connected peer, never left absent: absence on the
   * WIRE means `page`, and the content script resolves that once so the panel
   * has one reading rather than each caller repeating the default. A value
   * outside the closed set is carried verbatim (§10.3).
   */
  readonly treeSource?: string;
  readonly treeRevision?: string;
  /** Human-readable detail for the `no-surface` / `no-peer` states. */
  readonly message?: string;
}
