// ============================================================================
//  relay/protocol — the `relay@1.4` envelope, its closed sets, and its guards.
//
//  This module is a direct, dependency-free transcription of the normative
//  DevTools relay contract (`DEVTOOLS_RELAY.md`, profile `relay@1.4`). It is
//  deliberately written FROM THE SPEC and imports nothing from any host — the
//  contract's own §1.2 posture is that "a relay implementation is written from
//  this document; it does not need to read any host's source".
//
//  Both peers this extension ships share it: the page peer (`relay/pagePeer`,
//  injected into the page's own JS world) and the client peer (`relay/client`,
//  running in the content script).
// ============================================================================

/**
 * The relay profile this implementation speaks (DEVTOOLS_RELAY §5.1) — "the
 * HIGHEST profile it can serve", not the only one.
 *
 * This is `relay@1.4` because this build declares `treeSource` (§6.5) and can
 * raise `UPSTREAM_UNAVAILABLE` (§9.3), and a peer that uses a minor's
 * vocabulary while declaring an earlier minor is misdescribing itself. §5.1's
 * superset rule is what makes the claim honest in the other direction: a 1.4
 * peer serves any minor at or below its own, which `selectSessionProfile` below
 * turns into a per-session decision.
 */
export const RELAY_PROFILE = 'relay@1.4';

/**
 * The profiles this build speaks, most-preferred first — the `accepts` array of
 * a `hello` request (§6.2), and the set `selectSessionProfile` chooses from.
 *
 * Listing the earlier minors is not politeness. A client that sent only its own
 * newest id would be refused by every peer that has not yet advanced, which is
 * exactly the population §5.3's backward-compatible minor bump exists to keep
 * serving.
 */
export const ACCEPTED_PROFILES = [
  'relay@1.4',
  'relay@1.3',
  'relay@1.2',
  'relay@1.1',
  'relay@1.0',
] as const;

/** The envelope field whose presence marks a message as relay traffic (§3.2, §4). */
export const RELAY_FIELD = '$relay';

/** Envelope direction (§4). */
export type RelayDirection = 'request' | 'response' | 'event';

/**
 * The closed set of request types (§4.2), at THIS peer's profile.
 *
 * `read.affordances` is here because §4.2 puts it in the `relay@1.1` set and
 * this peer declares 1.2 — recognising it is not the same as serving it. §10.1
 * is explicit that the two refusals say different things: an unrecognised type
 * is `UNKNOWN_MESSAGE` ("no such entry point"), a recognised one whose
 * capability was not advertised is `CAPABILITY_ABSENT` ("it exists, this peer
 * does not offer it"). Omitting the token here would make a 1.2 peer tell a
 * client the first when the truth is the second.
 */
export const REQUEST_TYPES = [
  'hello',
  'read.nodeState',
  'read.bindingValue',
  'read.renderedDom',
  'read.tree',
  'read.findNodes',
  'read.affordances',
  'read.nodeJson',
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

/**
 * The profile MINOR each request type was introduced at (§4.2's per-minor
 * annotations).
 *
 * This table is what §6.3's second sentence needs to be implementable: "a
 * capability whose request type was introduced after the session profile MUST
 * NOT be advertised". While every type this peer served was a `relay@1.0` one
 * the rule was satisfied by having nothing to filter, so there was no table and
 * no filter — and the moment a peer advertises a later minor's type, its
 * absence stops being harmless and starts being a peer that offers a
 * `relay@1.0` client something that session never had.
 *
 * Keyed by request type rather than by capability because that is what both
 * users need: `hello` filters what it ADVERTISES, and the per-request check
 * asks about the type in front of it. (`unsubscribe` is gated by the
 * `subscribe` capability but arrived in the same minor, so the two readings
 * agree.)
 */
export const REQUEST_MINOR: Readonly<Record<RequestType, number>> = {
  hello: 0,
  'read.nodeState': 0,
  'read.bindingValue': 0,
  'read.renderedDom': 0,
  'read.tree': 0,
  'read.findNodes': 0,
  apply: 0,
  subscribe: 0,
  unsubscribe: 0,
  'read.affordances': 1,
  'read.nodeJson': 3,
};

/** The minor a capability's request type arrived at — see {@link REQUEST_MINOR}. */
export const capabilityMinor = (capability: Capability): number => REQUEST_MINOR[capability];

/**
 * The subset of `capabilities` that a session at `profile` may be told about
 * (§6.3).
 *
 * An unparseable profile keeps only the `relay@1.0` set: the honest floor for a
 * session whose minor cannot be established, and never the whole set — guessing
 * upward is the one direction that can advertise something the client cannot
 * have negotiated.
 */
export const capabilitiesAt = (
  profile: string | undefined,
  capabilities: readonly Capability[],
): Capability[] => {
  const minor = profile === undefined ? 0 : (parseProfile(profile)?.minor ?? 0);
  return capabilities.filter((capability) => capabilityMinor(capability) <= minor);
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
  // §9.3, since `relay@1.3`: the node is there and the host cannot produce its
  // canonical wire encoding. Deliberately NOT folded into NODE_NOT_FOUND, which
  // would be a lie about a node that is plainly present and would send a client
  // to look somewhere else — the one remedy that cannot help.
  'ENCODE_FAILED',
  // §9.3, since `relay@1.4`: this peer declares `treeSource: "upstream"` (§6.5)
  // and COULD NOT DISPATCH the request to the side that holds the tree. The
  // restriction is the class — it is raised only where the peer can assert the
  // request never left, because §8.3's "a refused op MUST leave the tree
  // unchanged" is a promise a peer that dispatched and then heard nothing is
  // not in a position to make. That case gets no response at all and the
  // client's own timeout governs.
  'UPSTREAM_UNAVAILABLE',
  'VALIDATOR_REJECT',
  'POLICY_DENIED',
] as const;

export type RefusalClass = (typeof REFUSAL_CLASSES)[number];

/**
 * The closed `detail.reason` set on an `UPSTREAM_UNAVAILABLE` refusal (§9.3).
 *
 * Both values say the request was never dispatched, which is the whole content
 * of the class: `no-channel` means none was established, `timeout-before-
 * dispatch` that the send itself did not complete. A client renders "reconnect"
 * and "retry" differently, which is why the field exists at all; §10.3 governs
 * a value this build does not know.
 */
export const UPSTREAM_UNAVAILABLE_REASONS = ['no-channel', 'timeout-before-dispatch'] as const;

export type UpstreamUnavailableReason = (typeof UPSTREAM_UNAVAILABLE_REASONS)[number];

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

/**
 * Where the tree a session reads lives (§6.5, since `relay@1.4`).
 *
 * Deliberately `"upstream"` and not `"server"`: the contract does not know what
 * is on the far side of the channel, how far away it is, or what protocol
 * carries the question, and a name that implied otherwise would be a claim this
 * peer cannot make.
 */
export const TREE_SOURCES = ['page', 'upstream'] as const;

export type TreeSource = (typeof TREE_SOURCES)[number];

/**
 * §6.5: absent means `"page"` — what every peer before `relay@1.4` meant.
 *
 * The same default-for-the-existing-population reasoning as §8.2.1's
 * `actorClass`: the default is chosen so that every handshake already on the
 * wire stays correct rather than becoming retroactively unlabelled.
 */
export const DEFAULT_TREE_SOURCE: TreeSource = 'page';

export const isTreeSource = (value: unknown): value is TreeSource =>
  typeof value === 'string' && (TREE_SOURCES as readonly string[]).includes(value);

/**
 * The tree source a handshake states, as a CLIENT must read it (§6.5, §10.3).
 *
 * An absent field is `"page"` by the rule above. An UNRECOGNISED one is carried
 * back verbatim rather than normalised, for the reason §10.3 gives: a value
 * this build does not know is not a licence to guess, and relabelling it
 * `"page"` would assert that the tree is in the page on no evidence at all —
 * the one reading that is actively unsafe, since it is what makes a client
 * treat a proxied read as a local one.
 */
export const treeSourceOf = (payload: { readonly treeSource?: unknown }): TreeSource | string => {
  const declared = payload.treeSource;
  if (declared === undefined || typeof declared !== 'string') return DEFAULT_TREE_SOURCE;
  return declared;
};

/** `hello.ok` response payload (§6.3). */
export interface HelloOkPayload {
  readonly host: string;
  readonly hostVersion: string;
  readonly surfaceVersion: string;
  readonly profile: string;
  readonly capabilities: readonly string[];
  /**
   * §6.5, since `relay@1.4`. Optional on the wire, and a peer whose tree IS in
   * the page SHOULD omit it — so this is `undefined` against every peer that
   * predates 1.4 and against most that do not. Read it through
   * {@link treeSourceOf}, never directly, so the absent case is the documented
   * default rather than each caller's guess.
   */
  readonly treeSource?: string;
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

/**
 * `read.nodeJson.ok` payload (§7.7, since `relay@1.3`) — the node's own
 * canonical wire JSON, embedded as a structured object, plus the revision it
 * was taken at.
 *
 * `node` is typed as an opaque record on purpose. It is the HOST's canonical
 * encoding of whatever vocabulary that page runs, so narrowing it to a shape
 * declared here would make this build's idea of the format the gate on what a
 * newer page may say — the opposite of §10.2. What reads it is
 * `panel/nodeJson`, by path, tolerating anything it does not recognise.
 */
export interface NodeJsonRead {
  readonly node: Readonly<Record<string, unknown>>;
  /**
   * The revision the encoding was taken at (§5.4, §7.7). Opaque: compared,
   * never parsed. This is the token a read-modify-write commit checks against
   * the current revision before it derives an op from a stale read.
   */
  readonly treeRevision: string;
}

/**
 * The strings the canonical encoder puts where the wire format cannot carry the
 * value (`WIRE_FORMAT.md` §2, and §7.7 rule 2 for what a client owes them).
 *
 * They arrive verbatim and MUST NOT be round-tripped: a sentinel decodes as the
 * literal string it looks like, not as the closure it stands for, so an op
 * carrying one back would replace a live affordance with text that renders and
 * does nothing.
 */
export const SENTINELS = ['<closure>', '<opaque>'] as const;

export const isSentinel = (value: unknown): value is (typeof SENTINELS)[number] =>
  typeof value === 'string' && (SENTINELS as readonly string[]).includes(value);

/**
 * `apply.ok` payload (§8.3). `treeRevision` is the revision AFTER the op; a
 * client holding a subscription also receives a `changed` event carrying the
 * same revision, and must tolerate the two arriving in either order.
 */
export interface ApplyOk {
  readonly applied: boolean;
  readonly treeRevision: string;
}

/**
 * Whether a person or a program composed an edit (§8.2.1, since `relay@1.2`).
 *
 * Deliberately two values, matching the discriminator the op-stream's own actor
 * record uses (`{"kind":"human",…}` / `{"kind":"agent",…}`), so a relay-
 * originated op joins a recording with no translation table. WHICH program is a
 * question for `actor`, which is free-form for exactly that reason.
 */
export const ACTOR_CLASSES = ['human', 'agent'] as const;

export type ActorClass = (typeof ACTOR_CLASSES)[number];

/** §8.2.1 rule 1: absent means `human` — what every pre-1.2 client meant. */
export const DEFAULT_ACTOR_CLASS: ActorClass = 'human';

/**
 * Advisory metadata recorded against a mutation (§8.2). It grants nothing: a
 * host MUST NOT let it influence any of the §8.3 decisions, so this is
 * provenance for the host's audit trail and nothing else. `actorClass` is
 * advisory to exactly the same degree (§8.2.1 rule 2) — a self-description, not
 * an authentication of one.
 */
export interface Attribution {
  readonly actor?: string;
  readonly actorClass?: ActorClass | string;
  readonly reason?: string;
}

export const isActorClass = (value: unknown): value is ActorClass =>
  typeof value === 'string' && (ACTOR_CLASSES as readonly string[]).includes(value);

/**
 * The class an attribution states, as a RECEIVING peer must read it (§8.2.1).
 *
 * Two absences that look alike and are not: a MISSING `actorClass` is `human`
 * by rule 1, because that is what the client meant; an UNRECOGNISED one is
 * carried back verbatim by rule 3, because relabelling it `human` would put a
 * claim into a record that nothing on the wire made. A non-string value is
 * ignored rather than refused (§10.2) — advisory metadata must not be able to
 * fail a legal edit.
 */
export const actorClassOf = (attribution: Attribution | undefined): ActorClass | string => {
  const declared = attribution?.actorClass;
  if (declared === undefined || typeof declared !== 'string') return DEFAULT_ACTOR_CLASS;
  return declared;
};

/** `subscribe.ok` payload (§8.5). `events` echoes the subset ESTABLISHED. */
export interface SubscribeOk {
  readonly subscriptionId: string;
  readonly events: readonly string[];
  readonly treeRevision: string;
}

/** The event names `relay@1.0` defines (§8.5); more is a minor bump. */
export const KNOWN_EVENTS = ['tree'] as const;

/** `changed` event payload (§8.5). */
export interface ChangedEvent {
  readonly subscriptionId: string;
  readonly event: string;
  readonly treeRevision: string;
  /** `"apply"` or `"host"`; a peer that cannot distinguish MUST emit `"host"`. */
  readonly cause: string;
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

/**
 * The session profile a page peer answers `hello` with (§6.3): the HIGHEST
 * profile that is both listed in the client's `accepts` and serveable by this
 * peer — same name, same major, minor at or below its own. `undefined` when
 * there is none, which is the one case that refuses with `FOREIGN_PROFILE`.
 *
 * Answering only with the peer's OWN id would be wrong in a way that looks
 * harmless: it refuses every client whose `accepts` predates the peer's newest
 * minor, which is the entire population a backward-compatible bump exists to
 * keep serving. §5.3 says additive change is a minor bump BECAUSE an older peer
 * can ignore what a newer one adds; the same reasoning obliges a newer peer to
 * keep speaking to an older client. That is why this is a selection and not an
 * inclusion test — a shape this peer held until it first advanced past 1.0, at
 * which point the two stop agreeing.
 */
export const selectSessionProfile = (
  accepts: readonly unknown[],
  own: string = RELAY_PROFILE,
): string | undefined => {
  const ours = parseProfile(own);
  if (ours === undefined) return undefined;
  let best: { readonly id: string; readonly minor: number } | undefined;
  for (const candidate of accepts) {
    if (typeof candidate !== 'string') continue;
    const parsed = parseProfile(candidate);
    if (parsed === undefined) continue;
    if (parsed.name !== ours.name || parsed.major !== ours.major) continue;
    if (parsed.minor > ours.minor) continue;
    if (best === undefined || parsed.minor > best.minor)
      best = { id: candidate, minor: parsed.minor };
  }
  return best?.id;
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
