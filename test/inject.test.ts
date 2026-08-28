// The injection gate: the fix for the shipped first-hello race. What these
// tests pin is the CONTRACT the content script's status() now leans on — the
// injector settles only when the script tag has loaded or failed, injects
// exactly once, and reports a CSP-blocked load as its own outcome.
import { describe, expect, it } from 'vitest';

import { createRelayInjector } from '../src/inspect/inject.js';

const SRC = 'chrome-extension://test-extension-id/page-relay.js';

const injectedTag = (): HTMLScriptElement | null =>
  document.querySelector<HTMLScriptElement>(`script[src="${SRC}"]`);

describe('createRelayInjector', () => {
  it('resolves ready on load, and removes the tag', async () => {
    const inject = createRelayInjector(document, SRC);
    const outcome = inject();
    const tag = injectedTag();
    expect(tag).not.toBeNull();
    tag?.dispatchEvent(new Event('load'));
    expect(await outcome).toBe('ready');
    expect(injectedTag()).toBeNull();
  });

  it('resolves blocked on error — the CSP-refused load — and removes the tag', async () => {
    const inject = createRelayInjector(document, SRC);
    const outcome = inject();
    injectedTag()?.dispatchEvent(new Event('error'));
    expect(await outcome).toBe('blocked');
    expect(injectedTag()).toBeNull();
  });

  it('injects once: every later call returns the same settled outcome', async () => {
    const inject = createRelayInjector(document, SRC);
    const first = inject();
    expect(document.querySelectorAll(`script[src="${SRC}"]`).length).toBe(1);
    const second = inject();
    expect(second).toBe(first);
    injectedTag()?.dispatchEvent(new Event('load'));
    expect(await second).toBe('ready');
    // A call AFTER settlement neither re-injects nor changes the answer.
    expect(await inject()).toBe('ready');
    expect(injectedTag()).toBeNull();
  });

  it('does not settle before the script has loaded — the race the fix exists for', async () => {
    const inject = createRelayInjector(document, SRC);
    let settled = false;
    const outcome = inject().then((value) => {
      settled = true;
      return value;
    });
    // Drain the microtask queue without firing the load event: the promise
    // must still be pending, because a hello sent now would be lost.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    injectedTag()?.dispatchEvent(new Event('load'));
    expect(await outcome).toBe('ready');
  });
});
