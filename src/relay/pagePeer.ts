// ============================================================================
//  relay/pagePeer — the `relay@1.0` PAGE PEER, over a host's in-page surface.
//
//  This is the half of the relay that runs in the inspected page's own JS
//  world (`src/page-relay.ts` installs it). It answers relay requests by
//  calling the host's already-registered in-page introspection surface —
//  `window.__fuaran`, which a Fuaran host registers only in a debug build.
//
//  It is a RELAY, not a second introspection protocol (DEVTOOLS_RELAY §1.2):
//  every read below returns the payload the host's own surface already
//  computes. Where the surface's local shape differs from the canonical relay
//  form, this module performs the §1.4 adaptation at the boundary — that
//  adaptation is the page peer's responsibility and is invisible to a client.
//
//  NO SIDE DOOR (§11.3). The peer adds no entry point the page did not already
//  have. That was easy to see while it served only reads; it is the load-
//  bearing claim now that it also serves `apply` and `subscribe`, so state it
//  precisely: `__fuaran.apply` is the host's OWN policy-gated mutation path —
//  gate, then decode, then apply, then candidate-validate, then fold — already
//  registered by the host and already callable by any script on the page,
//  including the browser console it was built for. This module contributes no
//  apply engine, no validator, and no policy of its own; it maps the host's
//  outcomes onto §8.3's refusal classes and nothing more.
//
//  CAPABILITY IS DERIVED, NEVER ASSUMED (§6.4). Every capability advertised
//  here is a fact about the surface in front of the peer: `apply` only when the
//  host says `canApply`, `subscribe` only when the surface exposes one. A host
//  that wires neither gets a read-only peer, which §6.4 declares fully
//  conformant — that is a shape, not a gap.
// ============================================================================

import {
  capabilityFor,
  event as relayEvent,
  isRelayEnvelope,
  isRequestType,
  KNOWN_EVENTS,
  negotiate,
  ok,
  refusal,
  RELAY_PROFILE,
  type BindingInfo,
  type Capability,
  type RefusalClass,
  type RelayEnvelope,
  type RequestType,
} from './protocol.js';

// ─── The host surface, typed STRUCTURALLY ───────────────────────────
//
// The in-page surface's shape is explicitly debug-only and excluded from the
// host's semver, so it is described here structurally rather than imported.
// The peer must keep working — returning honest refusals — against a page
// running an older or newer surface than the one it was built against.

export interface HostSurface {
  readonly version?: string;
  getNodeState?(nodeId: string): unknown;
  getBindingValue?(nodeId: string, slot: string): unknown;
  getRenderedDom?(nodeId: string): unknown;
  inspectTree?(): unknown;
  findNodes?(kind: string): unknown;
  /**
   * The host's own claim that it wired a real apply path. Read as a claim, not
   * as a hint: a surface exposing `apply` WITHOUT this flag is an older shape
   * whose `apply` may be inert, and advertising a capability on a guess is the
   * one thing §6.4 asks a peer not to do.
   */
  readonly canApply?: boolean;
  apply?(op: unknown): unknown;
  /** Committed-tree-change signal; returns a release handle. */
  subscribe?(listener: (change: unknown) => void): unknown;
  /** The host's own revision token, preferred over a digest when present. */
  treeRevision?(): unknown;
}

/** How this peer emits unsolicited `changed` events (§8.5). */
export interface PagePeerOptions {
  readonly emit?: (event: RelayEnvelope) => void;
}

/** Identification this peer reports in `hello.ok` (§6.3) — display only. */
export interface PeerIdentity {
  readonly host: string;
  readonly hostVersion: string;
}

/**
 * The `host` token the extension's own injected peer reports.
 *
 * Lives here, with no side effect attached, because THREE contexts need to
 * recognise it and only one of them may run the injection: the injected peer
 * declares it, the client re-probes when it sees it (a handshake answered by
 * our own peer does not yet prove no host peer exists), and the panel labels
 * it. Importing the injection module to get the string would install a page
 * peer in the isolated world.
 */
export const EXTENSION_PEER_HOST = 'fuaran-devtools-page-relay';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The host surface's `{ error }` envelope — a lookup miss, not an exception. */
const surfaceError = (value: unknown): string | undefined =>
  isPlainObject(value) && typeof value['error'] === 'string' ? value['error'] : undefined;

// ─── §1.4 adaptation — canonical relay shapes from local surface shapes ──

const normaliseBindings = (value: unknown): BindingInfo[] => {
  if (!Array.isArray(value)) return [];
  const out: BindingInfo[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const slot = entry['slot'];
    const expression = entry['expression'];
    const source = entry['source'];
    if (typeof slot !== 'string' || typeof expression !== 'string' || typeof source !== 'string')
      continue;
    out.push({ slot, expression, source });
  }
  return out;
};

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** §7.1 — the node's typed snapshot, from the surface's node introspection. */
export const adaptNodeSnapshot = (value: unknown): Record<string, unknown> | undefined => {
  if (!isPlainObject(value)) return undefined;
  const id = value['id'];
  const kind = value['kind'];
  if (typeof id !== 'string' || typeof kind !== 'string') return undefined;
  return {
    id,
    kind,
    bindings: normaliseBindings(value['bindings']),
    childIds: stringArray(value['childIds']),
  };
};

/** §7.2 — §7.1's shape made recursive by one added `children` field. */
export const adaptTreeSnapshot = (value: unknown): Record<string, unknown> | undefined => {
  const base = adaptNodeSnapshot(value);
  if (base === undefined || !isPlainObject(value)) return undefined;
  const rawChildren = value['children'];
  const children: Record<string, unknown>[] = [];
  if (Array.isArray(rawChildren))
    for (const child of rawChildren) {
      const adapted = adaptTreeSnapshot(child);
      if (adapted !== undefined) children.push(adapted);
    }
  return { ...base, children };
};

/** §7.4 — live geometry. */
export const adaptRenderedDom = (value: unknown): Record<string, unknown> | undefined => {
  if (!isPlainObject(value)) return undefined;
  const nums = ['x', 'y', 'width', 'height'] as const;
  for (const key of nums) if (typeof value[key] !== 'number') return undefined;
  return {
    x: value['x'],
    y: value['y'],
    width: value['width'],
    height: value['height'],
    overflowing: value['overflowing'] === true,
    hidden: value['hidden'] === true,
  };
};

/**
 * §7.5 / §1.4 — hosts return a BARE ARRAY of ids; the canonical relay form is
 * an object, so a future additive field (a `truncated` flag) is not blocked by
 * one payload slot being a naked array.
 */
export const adaptFoundNodes = (value: unknown): Record<string, unknown> => {
  if (Array.isArray(value)) return { nodeIds: stringArray(value) };
  if (isPlainObject(value) && Array.isArray(value['nodeIds']))
    return { nodeIds: stringArray(value['nodeIds']) };
  return { nodeIds: [] };
};

/**
 * §7.3 / §1.4 — the tagged resolution envelope.
 *
 * Two host shapes are accepted, because the hosts genuinely differ (§1.4):
 *
 *   - the TAGGED envelope (`{ status, expression, source, … }`) — already the
 *     canonical form; normalised and passed through, so a host that gained a
 *     relay-shaped surface needs no adaptation here at all; and
 *   - the BARE resolution (`{ kind: 'Resolved' | … }`) — the richer identity
 *     (`expression` + `source`) is recovered from the node's own snapshot,
 *     which is precisely why the tagged form is the canonical one: the bare
 *     form cannot be recovered into it without a second lookup.
 *
 * `noOverride` is only ever produced by a host emitting the tagged form. A
 * bare-resolution surface reports a slot it holds no binding for through its
 * `{ error }` envelope, which is indistinguishable from "not a binding slot on
 * this kind" — so that case maps to the `SLOT_NOT_DECLARED` REFUSAL rather
 * than being guessed at as the `noOverride` STATUS. §7.3 marks the two as a
 * deliberate distinction; inventing one from evidence that cannot tell them
 * apart would report a state the host never claimed.
 */
export const adaptBindingValue = (
  value: unknown,
  identity: { readonly expression: string; readonly source: string },
): Record<string, unknown> | undefined => {
  if (!isPlainObject(value)) return undefined;

  const status = value['status'];
  if (typeof status === 'string') {
    const expression =
      typeof value['expression'] === 'string' ? value['expression'] : identity.expression;
    const source = typeof value['source'] === 'string' ? value['source'] : identity.source;
    const out: Record<string, unknown> = { status, expression, source };
    if ('value' in value) out['value'] = value['value'];
    if (typeof value['message'] === 'string') out['message'] = value['message'];
    if (typeof value['key'] === 'string') out['key'] = value['key'];
    return out;
  }

  const kind = value['kind'];
  const base = { expression: identity.expression, source: identity.source };
  switch (kind) {
    case 'Resolved':
      return { status: 'resolved', value: value['value'], ...base };
    case 'NotResolved':
      return { status: 'notResolved', ...base };
    case 'Errored':
      return {
        status: 'errored',
        message: typeof value['message'] === 'string' ? value['message'] : 'Resolution failed.',
        ...base,
      };
    case 'I18nUnresolved':
      return {
        status: 'i18nUnresolved',
        key: typeof value['key'] === 'string' ? value['key'] : '',
        ...base,
      };
    default:
      return undefined;
  }
};

// ─── §8.3 adaptation — the host's apply envelope onto refusal classes ───

/**
 * What the host's `apply` said, in the contract's vocabulary.
 *
 * The mapping is one-to-one and deliberately NOT collapsible (§8.4): each of
 * `VALIDATOR_REJECT` / `POLICY_DENIED` / `CAPABILITY_ABSENT` implies a
 * different next action from the user — change the edit, accept that the
 * policy is the gate, or turn the capability on — so reporting one as another
 * sends them to fix something that was never the problem.
 *
 * `unwired` maps to `CAPABILITY_ABSENT` rather than to a rejection: an inert
 * apply path means the entry point is not there, and calling that a validator
 * rejection would tell the user their perfectly legal op was illegal.
 */
export type ApplyOutcome =
  | { readonly kind: 'applied'; readonly treeRevision?: string }
  | {
      readonly kind: 'refused';
      readonly refusal: RefusalClass;
      readonly message: string;
      readonly detail?: Readonly<Record<string, unknown>>;
    };

/** The wire form of the codec's decode error, carried verbatim in `detail` (§9.3). */
const decodeDetail = (value: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (!isPlainObject(value)) return undefined;
  const error = value['decodeError'];
  if (!isPlainObject(error)) return undefined;
  const out: Record<string, unknown> = {};
  // Both host tiers emit the codec's own field names; carried through as found
  // rather than renamed, since §9.3 says the DecodeError travels verbatim.
  for (const key of ['Code', 'Path', 'Message', 'ExpectedShape', 'code', 'path', 'message'])
    if (key in error) out[key] = error[key];
  return Object.keys(out).length === 0 ? undefined : out;
};

export const adaptApplyEnvelope = (value: unknown): ApplyOutcome => {
  if (!isPlainObject(value))
    return {
      kind: 'refused',
      refusal: 'VALIDATOR_REJECT',
      message: 'The host surface returned no apply envelope.',
    };

  const message = typeof value['error'] === 'string' ? value['error'] : 'The host refused the op.';
  switch (value['status']) {
    case 'applied':
      return {
        kind: 'applied',
        ...(typeof value['treeRevision'] === 'string'
          ? { treeRevision: value['treeRevision'] }
          : {}),
      };
    case 'denied':
      // `detail` is deliberately empty: explaining WHY policy refused hands out
      // a map of the policy (§11.5).
      return {
        kind: 'refused',
        refusal: 'POLICY_DENIED',
        message: "The host's policy layer refused this mutation.",
      };
    case 'decodeFailed': {
      const detail = decodeDetail(value);
      return {
        kind: 'refused',
        refusal: 'DECODE_FAILED',
        message: 'The op is not a recognised TreeOp.',
        ...(detail === undefined ? {} : { detail }),
      };
    }
    case 'rejected':
      return {
        kind: 'refused',
        refusal: 'VALIDATOR_REJECT',
        message,
        ...(typeof value['code'] === 'string' ? { detail: { code: value['code'] } } : {}),
      };
    case 'unwired':
      return {
        kind: 'refused',
        refusal: 'CAPABILITY_ABSENT',
        message,
        detail: { capability: 'apply' },
      };
    default:
      // An envelope shape this peer does not know. Reporting it as a validator
      // rejection is honest — the op did not apply and the host said so —
      // whereas inventing `applied` would claim a mutation that never happened.
      return { kind: 'refused', refusal: 'VALIDATOR_REJECT', message };
  }
};

// ─── Tree revision (§5.4) ───────────────────────────────────────────

/**
 * A 32-bit FNV-1a digest, rendered as a short opaque token.
 *
 * §5.4 lets a host with no cheap revision counter emit a fresh random token on
 * every change, since only EQUALITY is specified. A digest of the structural
 * snapshot is strictly better than random: it is stable while the tree is
 * unchanged, so a client's staleness check has no false positives, and it
 * changes whenever anything the client can read from the tree changes. Clients
 * must still treat it as opaque — never parsed, ordered, or attributed meaning.
 */
export const digest = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `r-${hash.toString(16).padStart(8, '0')}`;
};

const treeRevision = (surface: HostSurface): string => {
  try {
    // The host's own token wins when it has one: it is the token the host's
    // `changed` events carry, so a client comparing an event's revision against
    // a `hello.ok` revision is comparing like with like. A digest of the
    // snapshot is the fallback for a surface that publishes none.
    const own = surface.treeRevision?.();
    if (typeof own === 'string' && own !== '') return own;
    const tree = surface.inspectTree?.();
    return tree === undefined ? 'r-none' : digest(JSON.stringify(tree) ?? '');
  } catch {
    return 'r-unknown';
  }
};

// ─── Capability advertisement (§6.3, §6.4) ──────────────────────────

/**
 * The capabilities this peer will serve, derived from what the surface
 * actually offers — never from what this build can code for.
 *
 * `apply` needs BOTH a callable entry point and the host's explicit
 * `canApply === true`. A surface exposing `apply` while wiring no handler
 * answers every op with the inert `unwired` envelope, and advertising that as
 * a capability would make the panel offer edit affordances no page can honour.
 * A host that opts out of either is read-only, which §6.4 declares fully
 * conformant.
 */
export const capabilitiesOf = (surface: HostSurface): Capability[] => {
  const advertised: Capability[] = [];
  if (typeof surface.getNodeState === 'function') advertised.push('read.nodeState');
  if (typeof surface.getBindingValue === 'function') advertised.push('read.bindingValue');
  if (typeof surface.getRenderedDom === 'function') advertised.push('read.renderedDom');
  if (typeof surface.inspectTree === 'function') advertised.push('read.tree');
  if (typeof surface.findNodes === 'function') advertised.push('read.findNodes');
  if (typeof surface.apply === 'function' && surface.canApply === true) advertised.push('apply');
  if (typeof surface.subscribe === 'function') advertised.push('subscribe');
  return advertised;
};

// ─── The peer ───────────────────────────────────────────────────────

export interface PagePeer {
  /**
   * Handle one inbound envelope. Returns the single response to post back, or
   * `undefined` when the message is not this peer's business (a response, an
   * event, or a non-envelope) — §4 and §10.4.
   */
  handle(message: unknown): RelayEnvelope | undefined;
  /** The capabilities this peer currently advertises (§6.3). */
  capabilities(): readonly Capability[];
  /** Release every subscription. §8.5 requires this on page unload. */
  dispose(): void;
}

const str = (payload: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
};

/**
 * Where the peer's surface comes from: a fixed surface, or a lookup evaluated
 * PER REQUEST.
 *
 * The lookup form is the one the extension uses, and it is not a convenience:
 * a host replaces the surface object on every tree change, so a peer that
 * captured one instance would answer every later request from the tree that
 * was live when it was built. Reads would go stale silently; an `apply` would
 * be evaluated against a tree that no longer exists.
 */
export type HostSurfaceSource = HostSurface | undefined | (() => HostSurface | undefined);

/**
 * Build a page peer over a host surface. The surface is `undefined` when the
 * page carries no in-page introspection global; the peer then answers
 * `NOT_OPTED_IN` to every request including `hello` (§9.3, §11.1).
 *
 * §11.1 prefers ABSENCE — no listener at all — for production-like builds, and
 * this extension respects that by injecting the peer only into a page whose
 * markup already carries Fuaran's rendered-node marker. Where it does inject,
 * answering `NOT_OPTED_IN` is the deliberate trade §11.1 permits: it tells an
 * honest client WHY it cannot proceed, which is the difference between the
 * panel reporting "Fuaran page, no debug surface" and reporting nothing.
 */
export const createPagePeer = (
  source: HostSurfaceSource,
  identity: PeerIdentity,
  options: PagePeerOptions = {},
): PagePeer => {
  const surfaceNow = (): HostSurface | undefined =>
    typeof source === 'function' ? source() : source;

  interface Subscription {
    readonly release: () => void;
  }
  const subscriptions = new Map<string, Subscription>();
  let subscriptionCounter = 0;

  const serve = (request: RelayEnvelope, type: RequestType, live: HostSurface): RelayEnvelope => {
    const { id, payload } = request;
    const deny = (
      cls: Parameters<typeof refusal>[2],
      message: string,
      detail?: Readonly<Record<string, unknown>>,
    ): RelayEnvelope => refusal(id, type, cls, message, detail);

    switch (type) {
      case 'hello': {
        const accepts = payload['accepts'];
        if (!Array.isArray(accepts) || accepts.length === 0)
          return deny('MALFORMED_MESSAGE', 'hello requires a non-empty `accepts` array.', {
            path: 'payload.accepts',
          });
        if (!accepts.includes(RELAY_PROFILE))
          return deny('FOREIGN_PROFILE', 'This peer speaks no profile the client accepts.', {
            received: accepts.join(', '),
            supported: [RELAY_PROFILE],
          });
        return ok(id, type, {
          host: identity.host,
          hostVersion: identity.hostVersion,
          surfaceVersion: live.version ?? 'unknown',
          profile: RELAY_PROFILE,
          capabilities: capabilitiesOf(live),
          treeRevision: treeRevision(live),
        });
      }

      case 'read.tree': {
        const tree = adaptTreeSnapshot(live.inspectTree?.());
        if (tree === undefined)
          return deny('NODE_NOT_FOUND', 'The host surface returned no tree snapshot.');
        return ok(id, type, tree);
      }

      case 'read.nodeState': {
        const nodeId = str(payload, 'nodeId');
        if (nodeId === undefined)
          return deny('MALFORMED_MESSAGE', 'read.nodeState requires a string `nodeId`.', {
            path: 'payload.nodeId',
          });
        const raw = live.getNodeState?.(nodeId);
        const error = surfaceError(raw);
        if (error !== undefined) return deny('NODE_NOT_FOUND', error, { nodeId });
        const snapshot = adaptNodeSnapshot(raw);
        if (snapshot === undefined)
          return deny('NODE_NOT_FOUND', `No node '${nodeId}' in the tree.`, { nodeId });
        return ok(id, type, snapshot);
      }

      case 'read.renderedDom': {
        const nodeId = str(payload, 'nodeId');
        if (nodeId === undefined)
          return deny('MALFORMED_MESSAGE', 'read.renderedDom requires a string `nodeId`.', {
            path: 'payload.nodeId',
          });
        const raw = live.getRenderedDom?.(nodeId);
        const error = surfaceError(raw);
        // §7.4: a node in the tree with no rendered element is NODE_NOT_FOUND,
        // and `reason` distinguishes "no such node" from "not on screen".
        if (error !== undefined)
          return deny('NODE_NOT_FOUND', error, { nodeId, reason: 'not-rendered' });
        const geometry = adaptRenderedDom(raw);
        if (geometry === undefined)
          return deny('NODE_NOT_FOUND', `No rendered element for node '${nodeId}'.`, {
            nodeId,
            reason: 'not-rendered',
          });
        return ok(id, type, geometry);
      }

      case 'read.findNodes': {
        const kind = str(payload, 'kind');
        if (kind === undefined)
          return deny('MALFORMED_MESSAGE', 'read.findNodes requires a string `kind`.', {
            path: 'payload.kind',
          });
        // §7.5: an unmatched — or entirely unrecognised — kind is `[]`, never a
        // refusal. "Which nodes have this kind" has the honest answer "none".
        return ok(id, type, adaptFoundNodes(live.findNodes?.(kind)));
      }

      case 'read.bindingValue': {
        const nodeId = str(payload, 'nodeId');
        const slot = str(payload, 'slot');
        if (nodeId === undefined || slot === undefined)
          return deny(
            'MALFORMED_MESSAGE',
            'read.bindingValue requires string `nodeId` and `slot`.',
            { path: nodeId === undefined ? 'payload.nodeId' : 'payload.slot' },
          );

        const nodeRaw = live.getNodeState?.(nodeId);
        const nodeError = surfaceError(nodeRaw);
        if (nodeError !== undefined) return deny('NODE_NOT_FOUND', nodeError, { nodeId });
        const snapshot = adaptNodeSnapshot(nodeRaw);
        if (snapshot === undefined)
          return deny('NODE_NOT_FOUND', `No node '${nodeId}' in the tree.`, { nodeId });

        const bindings = snapshot['bindings'] as readonly BindingInfo[];
        const identityFor = bindings.find((binding) => binding.slot === slot);
        const raw = live.getBindingValue?.(nodeId, slot);
        const rawError = surfaceError(raw);
        const kind = String(snapshot['kind']);

        if (rawError !== undefined)
          return deny('SLOT_NOT_DECLARED', rawError, { nodeId, slot, kind });

        if (identityFor === undefined) {
          // The node holds no binding for this slot. A TAGGED surface can still
          // answer — that is exactly the `noOverride` status, and it carries its
          // own `expression`/`source`, so nothing is invented. A bare-resolution
          // surface cannot say whether the slot is declared-and-empty or not a
          // slot at all, so it is SLOT_NOT_DECLARED rather than a guess.
          const tagged = isPlainObject(raw) && typeof raw['status'] === 'string';
          const resolution = tagged
            ? adaptBindingValue(raw, { expression: '$none', source: 'Static' })
            : undefined;
          if (resolution !== undefined) return ok(id, type, resolution);
          return deny(
            'SLOT_NOT_DECLARED',
            `Slot '${slot}' is not a binding slot on kind '${kind}'.`,
            { nodeId, slot, kind },
          );
        }

        const resolution = adaptBindingValue(raw, identityFor);
        if (resolution === undefined)
          return deny('SLOT_NOT_DECLARED', `Slot '${slot}' did not resolve on node '${nodeId}'.`, {
            nodeId,
            slot,
            kind,
          });
        return ok(id, type, resolution);
      }

      case 'apply': {
        const op = payload['op'];
        if (!isPlainObject(op))
          return deny('MALFORMED_MESSAGE', 'apply requires an embedded JSON object `op`.', {
            path: 'payload.op',
          });

        // `attribution` (§8.2) is advisory and UNTRUSTED: it is forwarded to
        // nothing, grants nothing, and is not read here at all. The host's own
        // audit trail is the host's business; a peer that let it influence the
        // decision below would have turned advisory metadata into authority.
        const outcome = adaptApplyEnvelope(live.apply?.(op));
        if (outcome.kind === 'applied')
          return ok(id, type, {
            applied: true,
            // §8.3: the revision AFTER the op. A host that returned none is
            // asked again rather than reported as an empty token.
            treeRevision: outcome.treeRevision ?? treeRevision(live),
          });
        return deny(outcome.refusal, outcome.message, outcome.detail);
      }

      case 'subscribe': {
        const events = payload['events'];
        if (!Array.isArray(events) || events.length === 0)
          return deny('MALFORMED_MESSAGE', 'subscribe requires a non-empty `events` array.', {
            path: 'payload.events',
          });
        // §8.5: unknown event names are IGNORED rather than refused, provided
        // at least one is recognised — that is what makes "additive event names
        // are a minor bump" safe. None recognised is a malformed request.
        const accepted = events.filter(
          (name): name is string =>
            typeof name === 'string' && (KNOWN_EVENTS as readonly string[]).includes(name),
        );
        if (accepted.length === 0)
          return deny('MALFORMED_MESSAGE', 'No recognised event name in `events`.', {
            path: 'payload.events',
          });

        subscriptionCounter += 1;
        const subscriptionId = `s-${subscriptionCounter}`;
        const emit = options.emit;
        const release = live.subscribe?.((change) => {
          if (emit === undefined) return;
          const detail = isPlainObject(change) ? change : {};
          const cause = detail['cause'];
          emit(
            relayEvent(id, 'changed', {
              subscriptionId,
              event: 'tree',
              treeRevision:
                typeof detail['treeRevision'] === 'string'
                  ? detail['treeRevision']
                  : treeRevision(live),
              // §8.5: a peer that cannot distinguish the two MUST say `host`.
              // Guessing `apply` would credit this client with a change some
              // other writer made.
              cause: cause === 'apply' || cause === 'host' ? cause : 'host',
            }),
          );
        });
        subscriptions.set(subscriptionId, {
          release: typeof release === 'function' ? (release as () => void) : () => {},
        });

        return ok(id, type, {
          subscriptionId,
          events: accepted,
          treeRevision: treeRevision(live),
        });
      }

      case 'unsubscribe': {
        const subscriptionId = str(payload, 'subscriptionId');
        if (subscriptionId === undefined)
          return deny('MALFORMED_MESSAGE', 'unsubscribe requires a string `subscriptionId`.', {
            path: 'payload.subscriptionId',
          });
        // §8.5: an unknown or already-released id is `ok`, never a refusal —
        // the caller's desired end state is reached either way.
        subscriptions.get(subscriptionId)?.release();
        subscriptions.delete(subscriptionId);
        return ok(id, type, { subscriptionId });
      }
    }
  };

  return {
    capabilities: () => {
      const live = surfaceNow();
      return live === undefined ? [] : capabilitiesOf(live);
    },
    dispose(): void {
      for (const subscription of subscriptions.values()) subscription.release();
      subscriptions.clear();
    },
    handle(message: unknown): RelayEnvelope | undefined {
      if (!isRelayEnvelope(message)) return undefined;
      // §4: a page peer ignores anything that is not a request (§10.4 for
      // responses); §3.2's silence rule applies — no reply of any kind.
      if (message.dir !== 'request') return undefined;

      const id = message.id;
      // Resolved ONCE per request, not once per use: two lookups inside one
      // exchange could straddle a re-render and answer half the request from
      // one tree and half from the next.
      const surface = surfaceNow();

      // Ordering is deliberate and disclosure-driven. NOT_OPTED_IN is checked
      // FIRST because it is the least disclosing refusal there is (§11.4): it
      // confirms a host without revealing its capabilities, version, or even
      // which profiles this peer speaks — which FOREIGN_PROFILE's `supported`
      // detail would. §11.1 makes it apply to ANY request type, `hello`
      // included, so nothing about the request needs examining to answer it.
      if (surface === undefined)
        return refusal(
          id,
          message.type,
          'NOT_OPTED_IN',
          'This page renders Fuaran markup but exposes no in-page debug surface. ' +
            'Enable the host debug flag and reload.',
        );

      // §5.2: evaluated on EVERY inbound request, not only on `hello`.
      if (negotiate(message.$relay) === 'Foreign')
        return refusal(id, message.type, 'FOREIGN_PROFILE', 'Incompatible relay profile.', {
          received: message.$relay,
          supported: [RELAY_PROFILE],
        });

      // §10.1: an unrecognised type is answered, never dropped silently — and
      // never confused with CAPABILITY_ABSENT, which would falsely tell the
      // client a real entry point does not exist.
      if (!isRequestType(message.type))
        return refusal(id, message.type, 'UNKNOWN_MESSAGE', 'Unrecognised request type.', {
          received: message.type,
        });

      const type: RequestType = message.type;

      // §6.4 + §11.3: re-checked per request rather than trusting a client to
      // ask only for what was advertised. A client is not a trusted component.
      const capability = capabilityFor(type);
      if (capability !== undefined && !capabilitiesOf(surface).includes(capability))
        return refusal(id, type, 'CAPABILITY_ABSENT', `This peer does not offer '${capability}'.`, {
          capability,
        });

      try {
        return serve(message, type, surface);
      } catch (error) {
        // A surface that throws is a host defect, not a protocol event; the
        // client still gets exactly one response per request (§9.2).
        return refusal(
          id,
          type,
          'NODE_NOT_FOUND',
          error instanceof Error ? error.message : 'The host surface threw.',
        );
      }
    },
  };
};
