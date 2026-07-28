// ============================================================================
//  relay/client — the `relay@1.0` CLIENT PEER.
//
//  Issues requests and correlates responses. Runs in the extension's content
//  script, which shares the page's `window` for `postMessage` purposes while
//  keeping its own isolated JS world — so it is a same-tab peer exactly as
//  DEVTOOLS_RELAY §1.1 describes, with no privileged access to the page's
//  objects.
//
//  Everything a client MUST do is here rather than in the panel: the §3.2
//  receive checks, §5.2 profile negotiation, the §6.4 capability pre-check,
//  §10.3 tolerance of unrecognised enumerated values, and §10.4's rule that an
//  unsolicited response is ignored rather than applied.
// ============================================================================

import {
  acceptsMessageEvent,
  capabilityFor,
  isRelayEnvelope,
  negotiate,
  RELAY_PROFILE,
  request,
  type Capability,
  type FoundNodes,
  type HelloOkPayload,
  type BindingValue,
  type NodeSnapshot,
  type RefusalPayload,
  type RelayEnvelope,
  type RenderedDom,
  type RequestType,
  type TreeSnapshot,
} from './protocol.js';

/** Why a request did not produce a payload. */
export type RelayFailure =
  | { readonly kind: 'refusal'; readonly refusal: RefusalPayload }
  /** No response inside the client's own timeout — §6.1's "nothing came back". */
  | { readonly kind: 'silent' }
  /** The client declined to issue the request: §6.4 forbids asking for an
   *  un-advertised capability, so this never reaches the page peer at all. */
  | { readonly kind: 'capabilityAbsent'; readonly capability: Capability }
  /** A response arrived but did not carry the shape its type promises. */
  | { readonly kind: 'malformed'; readonly message: string };

export type RelayResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: RelayFailure };

/** How the client reaches its peer. Abstracted so the client is testable
 *  without a DOM, and so the transport's origin discipline is one small,
 *  separately-verifiable surface. */
export interface RelayTransport {
  post(envelope: RelayEnvelope): void;
  /** Register an inbound handler; returns an unsubscribe function. */
  listen(handler: (envelope: RelayEnvelope) => void): () => void;
}

/**
 * A `window.postMessage` transport implementing §3.3 (send) and §3.2 (receive).
 *
 * Both rules are security requirements rather than hygiene (§11.2): a `"*"`
 * target origin is readable by any document holding a reference to this
 * window, and without the `event.source === window` check any same-origin
 * frame — a different document with a different trust story — could drive the
 * relay. There is deliberately no way to relax either from a message.
 */
export const windowTransport = (win: Window): RelayTransport => ({
  post(envelope) {
    win.postMessage(envelope, win.origin);
  },
  listen(handler) {
    const onMessage = (event: MessageEvent): void => {
      if (!acceptsMessageEvent(event, win, win)) return;
      if (!isRelayEnvelope(event.data)) return;
      // §4: a client ignores requests; §5.2 is evaluated on every inbound
      // message, and a foreign profile means process nothing further from it.
      if (event.data.dir === 'request') return;
      if (negotiate(event.data.$relay) === 'Foreign') return;
      handler(event.data);
    };
    win.addEventListener('message', onMessage);
    return () => win.removeEventListener('message', onMessage);
  },
});

/**
 * §6.1: a client SHOULD wait at least 1000 ms before concluding no peer is
 * present, because the page peer may install its listener after the first
 * probe. Detection uses the longer window; established reads use the shorter.
 */
export const HELLO_TIMEOUT_MS = 1_500;
export const REQUEST_TIMEOUT_MS = 5_000;

export interface RelayClientOptions {
  readonly client: string;
  readonly clientVersion: string;
  readonly helloTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  /** Injected for tests; defaults to `setTimeout`/`clearTimeout`. */
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
}

const asRefusal = (payload: Readonly<Record<string, unknown>>): RefusalPayload => ({
  // §9.1: `class` is the machine-readable field; a client branches on it and
  // never on `message`. §10.3: an unrecognised class is carried through as the
  // generic case rather than crashing the client.
  class: typeof payload['class'] === 'string' ? payload['class'] : 'UNKNOWN',
  requestType: typeof payload['requestType'] === 'string' ? payload['requestType'] : '',
  message: typeof payload['message'] === 'string' ? payload['message'] : 'Refused.',
  ...(typeof payload['detail'] === 'object' && payload['detail'] !== null
    ? { detail: payload['detail'] as Record<string, unknown> }
    : {}),
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class RelayClient {
  private readonly transport: RelayTransport;
  private readonly options: RelayClientOptions;
  private readonly pending = new Map<string, (envelope: RelayEnvelope) => void>();
  private readonly stopListening: () => void;
  private counter = 0;
  private capabilities: readonly string[] | undefined;
  private handshake: HelloOkPayload | undefined;

  constructor(transport: RelayTransport, options: RelayClientOptions) {
    this.transport = transport;
    this.options = options;
    this.stopListening = transport.listen((envelope) => this.onEnvelope(envelope));
  }

  /** The `hello.ok` payload from the last successful handshake, if any. */
  get hostInfo(): HelloOkPayload | undefined {
    return this.handshake;
  }

  dispose(): void {
    this.stopListening();
    this.pending.clear();
  }

  private onEnvelope(envelope: RelayEnvelope): void {
    if (envelope.dir === 'event') return; // No subscription is taken on the read side.
    const resolve = this.pending.get(envelope.id);
    // §10.4: an unsolicited response — one whose id matches no outstanding
    // request — is ignored, and never applied as state.
    if (resolve === undefined) return;
    this.pending.delete(envelope.id);
    resolve(envelope);
  }

  private send(type: RequestType, payload: Readonly<Record<string, unknown>>, timeoutMs: number) {
    this.counter += 1;
    const id = `c-${this.counter}`;
    const schedule = this.options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    const cancel = this.options.cancel ?? ((handle) => clearTimeout(handle as never));

    return new Promise<RelayEnvelope | undefined>((resolve) => {
      const timer = schedule(() => {
        this.pending.delete(id);
        resolve(undefined);
      }, timeoutMs);
      this.pending.set(id, (envelope) => {
        cancel(timer);
        resolve(envelope);
      });
      this.transport.post(request(id, type, payload));
    });
  }

  private async call<T>(
    type: RequestType,
    payload: Readonly<Record<string, unknown>>,
    shape: (payload: Readonly<Record<string, unknown>>) => T | undefined,
    timeoutMs: number,
  ): Promise<RelayResult<T>> {
    const capability = capabilityFor(type);
    // §6.4: "a client MUST check `capabilities` before issuing any request
    // other than `hello`". Refusing locally keeps a known-absent capability off
    // the wire entirely rather than relying on the peer to say no.
    if (capability !== undefined && this.capabilities !== undefined)
      if (!this.capabilities.includes(capability))
        return { ok: false, failure: { kind: 'capabilityAbsent', capability } };

    const envelope = await this.send(type, payload, timeoutMs);
    if (envelope === undefined) return { ok: false, failure: { kind: 'silent' } };
    if (envelope.type === 'refusal')
      return { ok: false, failure: { kind: 'refusal', refusal: asRefusal(envelope.payload) } };
    // §4.2: there is no third outcome — a success response's type is the
    // request's type with `.ok` appended, and anything else is malformed.
    if (envelope.type !== `${type}.ok`)
      return {
        ok: false,
        failure: { kind: 'malformed', message: `Expected '${type}.ok', got '${envelope.type}'.` },
      };
    const value = shape(envelope.payload);
    if (value === undefined)
      return {
        ok: false,
        failure: { kind: 'malformed', message: `Response to '${type}' had the wrong shape.` },
      };
    return { ok: true, value };
  }

  /**
   * §6.1 detection: there is no ambient signal, so a client detects a host by
   * sending `hello` and seeing what comes back — `hello.ok`, a `NOT_OPTED_IN`
   * refusal, or nothing.
   */
  async hello(): Promise<RelayResult<HelloOkPayload>> {
    const result = await this.call<HelloOkPayload>(
      'hello',
      {
        client: this.options.client,
        clientVersion: this.options.clientVersion,
        accepts: [RELAY_PROFILE],
      },
      (payload) => {
        const capabilities = payload['capabilities'];
        if (typeof payload['profile'] !== 'string' || !Array.isArray(capabilities))
          return undefined;
        return {
          host: String(payload['host'] ?? 'unknown'),
          hostVersion: String(payload['hostVersion'] ?? 'unknown'),
          surfaceVersion: String(payload['surfaceVersion'] ?? 'unknown'),
          profile: payload['profile'],
          capabilities: capabilities.filter((c): c is string => typeof c === 'string'),
          treeRevision: String(payload['treeRevision'] ?? ''),
        };
      },
      this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
    );
    if (result.ok) {
      this.handshake = result.value;
      // §10.2: capability names this client does not know are kept, not
      // discarded — a newer peer advertising more is not an error.
      this.capabilities = result.value.capabilities;
    }
    return result;
  }

  /** True once a handshake advertised `capability` (§6.4). */
  can(capability: Capability): boolean {
    return this.capabilities?.includes(capability) ?? false;
  }

  readTree(): Promise<RelayResult<TreeSnapshot>> {
    return this.call<TreeSnapshot>('read.tree', {}, shapeTree, this.timeout());
  }

  readNodeState(nodeId: string): Promise<RelayResult<NodeSnapshot>> {
    return this.call<NodeSnapshot>('read.nodeState', { nodeId }, shapeNode, this.timeout());
  }

  readBindingValue(nodeId: string, slot: string): Promise<RelayResult<BindingValue>> {
    return this.call<BindingValue>(
      'read.bindingValue',
      { nodeId, slot },
      (payload) => {
        if (typeof payload['status'] !== 'string') return undefined;
        return {
          status: payload['status'],
          expression: String(payload['expression'] ?? ''),
          source: String(payload['source'] ?? ''),
          ...('value' in payload ? { value: payload['value'] } : {}),
          ...(typeof payload['message'] === 'string' ? { message: payload['message'] } : {}),
          ...(typeof payload['key'] === 'string' ? { key: payload['key'] } : {}),
        };
      },
      this.timeout(),
    );
  }

  readRenderedDom(nodeId: string): Promise<RelayResult<RenderedDom>> {
    return this.call<RenderedDom>(
      'read.renderedDom',
      { nodeId },
      (payload) => {
        for (const key of ['x', 'y', 'width', 'height'])
          if (typeof payload[key] !== 'number') return undefined;
        return {
          x: payload['x'] as number,
          y: payload['y'] as number,
          width: payload['width'] as number,
          height: payload['height'] as number,
          overflowing: payload['overflowing'] === true,
          hidden: payload['hidden'] === true,
        };
      },
      this.timeout(),
    );
  }

  findNodes(kind: string): Promise<RelayResult<FoundNodes>> {
    return this.call<FoundNodes>(
      'read.findNodes',
      { kind },
      (payload) => {
        const ids = payload['nodeIds'];
        if (!Array.isArray(ids)) return undefined;
        return { nodeIds: ids.filter((id): id is string => typeof id === 'string') };
      },
      this.timeout(),
    );
  }

  private timeout(): number {
    return this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }
}

// ─── Response shaping ───────────────────────────────────────────────

const shapeBindings = (value: unknown): NodeSnapshot['bindings'] => {
  if (!Array.isArray(value)) return [];
  const out: { slot: string; expression: string; source: string }[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    if (typeof entry['slot'] !== 'string') continue;
    out.push({
      slot: entry['slot'],
      expression: String(entry['expression'] ?? ''),
      source: String(entry['source'] ?? ''),
    });
  }
  return out;
};

const shapeIds = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

export const shapeNode = (payload: Readonly<Record<string, unknown>>): NodeSnapshot | undefined => {
  if (typeof payload['id'] !== 'string' || typeof payload['kind'] !== 'string') return undefined;
  return {
    id: payload['id'],
    kind: payload['kind'],
    bindings: shapeBindings(payload['bindings']),
    childIds: shapeIds(payload['childIds']),
  };
};

export const shapeTree = (payload: Readonly<Record<string, unknown>>): TreeSnapshot | undefined => {
  const base = shapeNode(payload);
  if (base === undefined) return undefined;
  const rawChildren = payload['children'];
  const children: TreeSnapshot[] = [];
  if (Array.isArray(rawChildren))
    for (const child of rawChildren) {
      if (!isObject(child)) continue;
      const shaped = shapeTree(child);
      if (shaped !== undefined) children.push(shaped);
    }
  return { ...base, children };
};
