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
//  READ-ONLY BY CONSTRUCTION. No `apply` and no `subscribe` capability is
//  advertised and neither is served. §6.4: "a read-only host is fully
//  conformant" — a page peer offering only the five reads implements this
//  specification completely. Nothing here can mutate the inspected page.
// ============================================================================

import {
  capabilityFor,
  isRelayEnvelope,
  isRequestType,
  negotiate,
  ok,
  refusal,
  RELAY_PROFILE,
  type BindingInfo,
  type Capability,
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
}

/** Identification this peer reports in `hello.ok` (§6.3) — display only. */
export interface PeerIdentity {
  readonly host: string;
  readonly hostVersion: string;
}

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
    const tree = surface.inspectTree?.();
    return tree === undefined ? 'r-none' : digest(JSON.stringify(tree) ?? '');
  } catch {
    return 'r-unknown';
  }
};

// ─── Capability advertisement (§6.3, §6.4) ──────────────────────────

/**
 * The capabilities this peer will serve, derived from what the surface
 * actually offers. `apply` and `subscribe` are NEVER advertised: this peer is
 * read-only by construction, which §6.4 declares fully conformant.
 */
export const capabilitiesOf = (surface: HostSurface): Capability[] => {
  const advertised: Capability[] = [];
  if (typeof surface.getNodeState === 'function') advertised.push('read.nodeState');
  if (typeof surface.getBindingValue === 'function') advertised.push('read.bindingValue');
  if (typeof surface.getRenderedDom === 'function') advertised.push('read.renderedDom');
  if (typeof surface.inspectTree === 'function') advertised.push('read.tree');
  if (typeof surface.findNodes === 'function') advertised.push('read.findNodes');
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
}

const str = (payload: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
};

/**
 * Build a page peer over a host surface. `surface` is `undefined` when the
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
  surface: HostSurface | undefined,
  identity: PeerIdentity,
): PagePeer => {
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

      // Read-only peer: the mutation and subscription entry points exist in the
      // contract but are not advertised here, so they never reach this switch —
      // the capability gate below refuses them with CAPABILITY_ABSENT first.
      case 'apply':
      case 'subscribe':
      case 'unsubscribe':
        return deny('CAPABILITY_ABSENT', 'This peer is read-only.', {
          capability: capabilityFor(type) ?? type,
        });
    }
  };

  return {
    handle(message: unknown): RelayEnvelope | undefined {
      if (!isRelayEnvelope(message)) return undefined;
      // §4: a page peer ignores anything that is not a request (§10.4 for
      // responses); §3.2's silence rule applies — no reply of any kind.
      if (message.dir !== 'request') return undefined;

      const id = message.id;

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
