// ============================================================================
//  relay/protocol — the `relay@1.0` envelope, its closed sets, and its guards.
//
//  This module is a direct, dependency-free transcription of the normative
//  DevTools relay contract (`DEVTOOLS_RELAY.md`, profile `relay@1.0`). It is
//  deliberately written FROM THE SPEC and imports nothing from any host — the
//  contract's own §1.2 posture is that "a relay implementation is written from
//  this document; it does not need to read any host's source".
//
//  Both peers this extension ships share it: the page peer (`relay/pagePeer`,
//  injected into the page's own JS world) and the client peer (`relay/client`,
//  running in the content script).
// ============================================================================

/** The relay profile this implementation speaks (DEVTOOLS_RELAY §5.1). */
export const RELAY_PROFILE = 'relay@1.0';

/** The envelope field whose presence marks a message as relay traffic (§3.2, §4). */
export const RELAY_FIELD = '$relay';

/** Envelope direction (§4). */
export type RelayDirection = 'request' | 'response' | 'event';

/** The closed set of request types (§4.2). */
export const REQUEST_TYPES = [
  'hello',
  'read.nodeState',
  'read.bindingValue',
  'read.renderedDom',
  'read.tree',
  'read.findNodes',
  'apply',
  'subscribe',
  'unsubscribe',
] as const;

export type RequestType = (typeof REQUEST_TYPES)[number];

/**
 * The capability names (§6.3). Every request type except `hello` is named
 * identically to the capability that gates it, so a page peer's authorisation
 * check is a set-membership test on `type` rather than a lookup table (§4.2).
 * `unsubscribe` is the one type whose gating capability differs from its name:
 * it is gated by `subscribe`.
 */
export type Capability = Exclude<RequestType, 'hello'>;

/** The capability that gates a request type (§4.2). `hello` is never gated. */
export const capabilityFor = (type: RequestType): Capability | undefined => {
  if (type === 'hello') return undefined;
  if (type === 'unsubscribe') return 'subscribe';
  return type;
};

/** The closed refusal-class set (§9.3). */
export const REFUSAL_CLASSES = [
  'NOT_OPTED_IN',
  'FOREIGN_PROFILE',
  'UNKNOWN_MESSAGE',
  'MALFORMED_MESSAGE',
  'CAPABILITY_ABSENT',
  'NODE_NOT_FOUND',
  'SLOT_NOT_DECLARED',
  'DECODE_FAILED',
  'VALIDATOR_REJECT',
  'POLICY_DENIED',
] as const;

export type RefusalClass = (typeof REFUSAL_CLASSES)[number];

/** The closed `read.bindingValue` status set (§7.3). */
export const BINDING_STATUSES = [
  'resolved',
  'notResolved',
  'errored',
  'i18nUnresolved',
  'noOverride',
] as const;

export type BindingStatus = (typeof BINDING_STATUSES)[number];

/** A relay envelope — request, response, and event alike (§4). */
export interface RelayEnvelope {
  readonly $relay: string;
  readonly dir: RelayDirection;
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

// ─── Payload shapes (§6–§8) ─────────────────────────────────────────

/** `hello` request payload (§6.2). */
export interface HelloPayload {
  readonly client: string;
  readonly clientVersion: string;
  readonly accepts: readonly string[];
}

/** `hello.ok` response payload (§6.3). */
export interface HelloOkPayload {
  readonly host: string;
  readonly hostVersion: string;
  readonly surfaceVersion: string;
  readonly profile: string;
  readonly capabilities: readonly string[];
  readonly treeRevision: string;
}

/** One bound binding slot on a node (§7.1). */
export interface BindingInfo {
  readonly slot: string;
  readonly expression: string;
  readonly source: string;
}

/** `read.nodeState.ok` payload — the node's typed snapshot (§7.1). */
export interface NodeSnapshot {
  readonly id: string;
  readonly kind: string;
  readonly bindings: readonly BindingInfo[];
  readonly childIds: readonly string[];
}

/** `read.tree.ok` payload — §7.1's shape made recursive by one field (§7.2). */
export interface TreeSnapshot extends NodeSnapshot {
  readonly children: readonly TreeSnapshot[];
}

/** `read.bindingValue.ok` payload — the tagged resolution envelope (§7.3). */
export interface BindingValue {
  readonly status: BindingStatus | string;
  readonly expression: string;
  readonly source: string;
  readonly value?: unknown;
  readonly message?: string;
  readonly key?: string;
}

/** `read.renderedDom.ok` payload — live geometry (§7.4). */
export interface RenderedDom {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly overflowing: boolean;
  readonly hidden: boolean;
}

/** `read.findNodes.ok` payload (§7.5). */
export interface FoundNodes {
  readonly nodeIds: readonly string[];
}

/** `refusal` payload (§9.1). */
export interface RefusalPayload {
  readonly class: RefusalClass | string;
  readonly requestType: string;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

// ─── Profile-id grammar and negotiation (§5.1, §5.2) ────────────────

export interface ProfileId {
  readonly name: string;
  readonly major: number;
  readonly minor: number;
}

const PROFILE_PATTERN = /^([A-Za-z][A-Za-z0-9-]*)@(\d+)\.(\d+)$/;

/** Parse `<name>@<major>.<minor>`; `undefined` when the token is not a profile id. */
export const parseProfile = (value: string): ProfileId | undefined => {
  const match = PROFILE_PATTERN.exec(value);
  if (match === null) return undefined;
  const [, name, major, minor] = match;
  if (name === undefined || major === undefined || minor === undefined) return undefined;
  return { name, major: Number(major), minor: Number(minor) };
};

export type Negotiation = 'Current' | 'Behind' | 'Foreign';

/**
 * The §5.2 negotiation table, unchanged from `WIRE_FORMAT.md` §15.2. A peer
 * evaluates it on EVERY inbound message, not only on `hello` — a client cannot
 * be assumed to keep its profile constant, and the check is a string compare.
 */
export const negotiate = (received: string, own: string = RELAY_PROFILE): Negotiation => {
  const theirs = parseProfile(received);
  const ours = parseProfile(own);
  if (theirs === undefined || ours === undefined) return 'Foreign';
  if (theirs.name !== ours.name || theirs.major !== ours.major) return 'Foreign';
  return theirs.minor <= ours.minor ? 'Current' : 'Behind';
};

// ─── Guards ─────────────────────────────────────────────────────────

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The §3.2 check-4 test: a non-null object carrying a string `$relay`. This is
 * the ONE field that both detects a relay message and negotiates its version,
 * so a peer applies it before looking at anything else.
 */
export const looksLikeRelayMessage = (value: unknown): boolean =>
  isPlainObject(value) && typeof value[RELAY_FIELD] === 'string';

const isDirection = (value: unknown): value is RelayDirection =>
  value === 'request' || value === 'response' || value === 'event';

/**
 * Narrow arbitrary structured-clone data to a fully-shaped envelope. A message
 * that looks like relay traffic (`looksLikeRelayMessage`) but fails this is
 * malformed, not foreign — the caller decides which of silence (§3.2) or a
 * `MALFORMED_MESSAGE` refusal (§9.3) applies.
 */
export const isRelayEnvelope = (value: unknown): value is RelayEnvelope =>
  isPlainObject(value) &&
  typeof value[RELAY_FIELD] === 'string' &&
  isDirection(value['dir']) &&
  typeof value['id'] === 'string' &&
  typeof value['type'] === 'string' &&
  isPlainObject(value['payload']);

export const isRequestType = (value: string): value is RequestType =>
  (REQUEST_TYPES as readonly string[]).includes(value);

/**
 * The §3.2 receive-side checks, in order, as one predicate. All four are
 * security requirements rather than hygiene (§11.2): a `false` here means the
 * event is ignored SILENTLY — no reply of any kind, not even a refusal, since
 * a refusal to an unverified peer is itself a disclosure (§11.4).
 */
export const acceptsMessageEvent = (
  event: Pick<MessageEvent, 'source' | 'origin' | 'data'>,
  win: Pick<Window, 'origin'> & { readonly self?: unknown },
  expectedSource: unknown,
): boolean =>
  event.source === expectedSource &&
  event.origin === win.origin &&
  looksLikeRelayMessage(event.data);

// ─── Constructors ───────────────────────────────────────────────────

export const request = (
  id: string,
  type: RequestType,
  payload: Readonly<Record<string, unknown>>,
): RelayEnvelope => ({ $relay: RELAY_PROFILE, dir: 'request', id, type, payload });

/**
 * A success response. §4.2: "a successful response's `type` is the request's
 * `type` with `.ok` appended" — derived here rather than passed in, so the two
 * can never drift apart.
 */
export const ok = (
  id: string,
  requestType: string,
  payload: Readonly<Record<string, unknown>>,
): RelayEnvelope => ({
  $relay: RELAY_PROFILE,
  dir: 'response',
  id,
  type: `${requestType}.ok`,
  payload,
});

export const refusal = (
  id: string,
  requestType: string,
  refusalClass: RefusalClass,
  message: string,
  detail?: Readonly<Record<string, unknown>>,
): RelayEnvelope => ({
  $relay: RELAY_PROFILE,
  dir: 'response',
  id,
  type: 'refusal',
  payload:
    detail === undefined
      ? { class: refusalClass, requestType, message }
      : { class: refusalClass, requestType, message, detail },
});

export const event = (
  id: string,
  type: string,
  payload: Readonly<Record<string, unknown>>,
): RelayEnvelope => ({ $relay: RELAY_PROFILE, dir: 'event', id, type, payload });
