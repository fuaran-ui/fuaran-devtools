// The panel-side bridge client against a fake chrome.runtime. What these
// tests pin is the fix for the shipped dead-port failure: MV3 suspends the
// background worker, suspension disconnects the port, and v0.1.1 then threw
// "Attempting to use a disconnected port object" on every later Refresh. The
// client now treats the port as expendable — reconnect on disconnect,
// re-register for event fan-out, and retry a send that throws once on a
// fresh port.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bridgeEvent, bridgeOk, isPanelRegistration, panelRegistration } from '../src/bridge.js';
import { PanelConnection } from '../src/panel/connection.js';

type Listener = (message: unknown) => void;

class FakePort {
  readonly posted: unknown[] = [];
  readonly messageListeners: Listener[] = [];
  readonly disconnectListeners: (() => void)[] = [];
  private dead = false;

  readonly onMessage = { addListener: (fn: Listener) => this.messageListeners.push(fn) };
  readonly onDisconnect = { addListener: (fn: () => void) => this.disconnectListeners.push(fn) };

  postMessage(message: unknown): void {
    if (this.dead) throw new Error('Attempting to use a disconnected port object');
    this.posted.push(message);
  }

  /** The worker answered: deliver a message to the panel side. */
  deliver(message: unknown): void {
    for (const fn of this.messageListeners) fn(message);
  }

  /** The worker was suspended: kill the port and fire onDisconnect. */
  suspend(): void {
    this.dead = true;
    for (const fn of this.disconnectListeners) fn();
  }

  /** Kill the port WITHOUT firing onDisconnect yet — the throw-first case. */
  die(): void {
    this.dead = true;
  }
}

let ports: FakePort[] = [];
let connectFailure: string | undefined;

const lastPort = (): FakePort => {
  const port = ports[ports.length - 1];
  if (port === undefined) throw new Error('no port was opened');
  return port;
};

beforeEach(() => {
  ports = [];
  connectFailure = undefined;
  vi.useFakeTimers();
  vi.stubGlobal('chrome', {
    runtime: {
      connect: () => {
        if (connectFailure !== undefined) throw new Error(connectFailure);
        const port = new FakePort();
        ports.push(port);
        return port;
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('PanelConnection', () => {
  it('registers for event fan-out immediately on connect', () => {
    void new PanelConnection(7);
    expect(ports.length).toBe(1);
    expect(lastPort().posted[0]).toEqual(panelRegistration(7));
    expect(isPanelRegistration(lastPort().posted[0])).toBe(true);
  });

  it('settles a request from the routed response', async () => {
    const connection = new PanelConnection(7);
    const result = connection.request<{ state: string }>('status');
    const routed = lastPort().posted[1] as { tabId: number; request: { id: number } };
    expect(routed.tabId).toBe(7);
    lastPort().deliver(bridgeOk(routed.request.id, { state: 'connected' }));
    expect(await result).toEqual({ state: 'connected' });
  });

  it('fails outstanding requests on disconnect, then reconnects and re-registers', async () => {
    const connection = new PanelConnection(7);
    const inFlight = connection.request('status');
    lastPort().suspend();
    await expect(inFlight).rejects.toThrow(/press Refresh/);
    // The reconnect is scheduled, not immediate — advance past the delay.
    vi.advanceTimersByTime(300);
    expect(ports.length).toBe(2);
    expect(lastPort().posted[0]).toEqual(panelRegistration(7));
  });

  it('retries a send that throws on a just-died port, once, on a fresh port', async () => {
    const connection = new PanelConnection(7);
    // The port is dead but onDisconnect has not fired yet — the first anyone
    // hears of the suspension is postMessage throwing. This is the exact
    // shipped failure: "Attempting to use a disconnected port object".
    lastPort().die();
    const result = connection.request<string>('status');
    expect(ports.length).toBe(2);
    const routed = lastPort().posted[1] as { request: { id: number } };
    lastPort().deliver(bridgeOk(routed.request.id, 'ok'));
    expect(await result).toBe('ok');
  });

  it('reports a connect failure instead of spinning — the extension is gone', async () => {
    const connection = new PanelConnection(7);
    lastPort().die();
    connectFailure = 'Extension context invalidated.';
    await expect(connection.request('status')).rejects.toThrow(/Extension context invalidated/);
    // The scheduled reconnect from any disconnect must not loop against a
    // context that cannot come back.
    vi.advanceTimersByTime(10_000);
    expect(ports.length).toBe(1);
  });

  it('fans bridge events to handlers, including after a reconnect', () => {
    const connection = new PanelConnection(7);
    const seen: string[] = [];
    connection.onEvent((event) => seen.push(event.event));
    lastPort().deliver(bridgeEvent('picked', 'node-1'));
    lastPort().suspend();
    vi.advanceTimersByTime(300);
    lastPort().deliver(bridgeEvent('pickCancelled'));
    expect(seen).toEqual(['picked', 'pickCancelled']);
  });
});
