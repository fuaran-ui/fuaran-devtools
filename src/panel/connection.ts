// ============================================================================
//  panel/connection — the panel-side bridge client.
//
//  A promise per request over the background router's long-lived port, plus a
//  subscription for the unsolicited events the content script pushes (a
//  completed pick). Correlation is by envelope id; a disconnect fails every
//  outstanding request rather than leaving the panel waiting forever on a
//  service worker that has been evicted.
// ============================================================================

import {
  bridgeRequest,
  isBridgeEvent,
  isBridgeResponse,
  PANEL_PORT,
  type BridgeEvent,
  type BridgeMethod,
} from '../bridge.js';

export type EventHandler = (event: BridgeEvent) => void;

export class PanelConnection {
  private readonly port: chrome.runtime.Port;
  private readonly tabId: number;
  private readonly pending = new Map<number, (error?: string, result?: unknown) => void>();
  private readonly handlers = new Set<EventHandler>();
  private nextId = 1;

  constructor(tabId: number) {
    this.tabId = tabId;
    this.port = chrome.runtime.connect({ name: PANEL_PORT });
    this.port.onMessage.addListener((message: unknown) => {
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
    this.port.onDisconnect.addListener(() => {
      for (const [id, settle] of this.pending) {
        this.pending.delete(id);
        settle('The extension bridge disconnected — reopen DevTools.');
      }
    });
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
      this.port.postMessage({ tabId: this.tabId, request: bridgeRequest(id, method, args) });
    });
  }
}
