// ============================================================================
//  panel/connection — the panel-side bridge client.
//
//  A promise per request over the background router's port, plus a
//  subscription for the unsolicited events the content script pushes (a
//  completed pick, a tree change). Correlation is by envelope id.
//
//  THE PORT IS NOT DURABLE. MV3 suspends the background service worker after
//  ~30 seconds idle, and suspension disconnects every port; a postMessage on
//  the dead port then THROWS ("Attempting to use a disconnected port
//  object"). v0.1.1 held one port for the panel's lifetime, so the panel was
//  dead half a minute after opening. This client treats the port as
//  expendable instead:
//
//   - a disconnect fails the outstanding requests (their responses died with
//     the worker), then reconnects and re-registers for event fan-out —
//     connecting is itself what wakes the worker;
//   - a send that throws on a just-died port retries once on a fresh one — a
//     suspension is asynchronous news, and the first anyone hears of it can
//     be the throw itself;
//   - if connecting itself throws, the extension context is gone (updated,
//     disabled, or uninstalled): requests fail with that, permanently, and no
//     reconnect loop spins against it.
// ============================================================================

import {
  bridgeRequest,
  isBridgeEvent,
  isBridgeResponse,
  PANEL_PORT,
  panelRegistration,
  type BridgeEvent,
  type BridgeMethod,
} from '../bridge.js';

export type EventHandler = (event: BridgeEvent) => void;

/** How long a disconnected port waits before reconnecting for event flow. */
const RECONNECT_DELAY_MS = 250;

export class PanelConnection {
  private readonly tabId: number;
  private port: chrome.runtime.Port | undefined;
  private readonly pending = new Map<number, (error?: string, result?: unknown) => void>();
  private readonly handlers = new Set<EventHandler>();
  private nextId = 1;
  /** Set once connecting itself fails: the extension context is gone. */
  private dead: string | undefined;

  constructor(tabId: number) {
    this.tabId = tabId;
    this.ensurePort();
  }

  onEvent(handler: EventHandler): void {
    this.handlers.add(handler);
  }

  request<T>(method: BridgeMethod, args?: Readonly<Record<string, unknown>>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (error, result) => {
        if (error === undefined) resolve(result as T);
        else reject(new Error(error));
      });
      const envelope = { tabId: this.tabId, request: bridgeRequest(id, method, args) };
      try {
        this.alivePort().postMessage(envelope);
      } catch {
        // The port died between our last look and this send. One fresh port,
        // one retry; a second failure is reported, never swallowed.
        this.port = undefined;
        try {
          this.alivePort().postMessage(envelope);
        } catch (error) {
          this.pending.delete(id);
          reject(new Error(this.dead ?? (error instanceof Error ? error.message : String(error))));
        }
      }
    });
  }

  /** The live port, connecting (and thereby waking the worker) if needed. */
  private alivePort(): chrome.runtime.Port {
    if (this.dead !== undefined) throw new Error(this.dead);
    this.port ??= this.connect();
    return this.port;
  }

  private ensurePort(): void {
    if (this.dead !== undefined || this.port !== undefined) return;
    try {
      this.port = this.connect();
    } catch (error) {
      this.dead = `The extension bridge is gone (${
        error instanceof Error ? error.message : String(error)
      }) — reopen DevTools.`;
    }
  }

  private connect(): chrome.runtime.Port {
    const port = chrome.runtime.connect({ name: PANEL_PORT });
    // Register for event fan-out immediately — events must flow before (and
    // between) requests, and the router keys ports by inspected tab.
    port.postMessage(panelRegistration(this.tabId));
    port.onMessage.addListener((message: unknown) => {
      if (isBridgeEvent(message)) {
        for (const handler of this.handlers) handler(message);
        return;
      }
      if (!isBridgeResponse(message)) return;
      const settle = this.pending.get(message.id);
      if (settle === undefined) return;
      this.pending.delete(message.id);
      if (message.ok) settle(undefined, message.result);
      else settle(message.error);
    });
    port.onDisconnect.addListener(() => {
      if (this.port === port) this.port = undefined;
      for (const [id, settle] of this.pending) {
        this.pending.delete(id);
        settle('The extension bridge reconnected mid-request — press Refresh.');
      }
      // Reconnect so event fan-out resumes without waiting for the next
      // request. The delay keeps a genuinely-gone extension from spinning;
      // ensurePort stops for good the first time connecting throws.
      setTimeout(() => this.ensurePort(), RECONNECT_DELAY_MS);
    });
    return port;
  }
}
