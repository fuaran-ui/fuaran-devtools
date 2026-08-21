import { describe, expect, it } from 'vitest';

import {
  ACTOR_CLASSES,
  acceptsMessageEvent,
  capabilityFor,
  isActorClass,
  isRelayEnvelope,
  isRequestType,
  looksLikeRelayMessage,
  negotiate,
  ok,
  parseProfile,
  refusal,
  RELAY_PROFILE,
  request,
  selectSessionProfile,
} from '../src/relay/protocol.js';

describe('profile grammar and negotiation (§5)', () => {
  it('parses the <name>@<major>.<minor> grammar', () => {
    expect(parseProfile('relay@1.0')).toEqual({ name: 'relay', major: 1, minor: 0 });
    expect(parseProfile('relay@1')).toBeUndefined();
    expect(parseProfile('relay')).toBeUndefined();
    expect(parseProfile('')).toBeUndefined();
  });

  it.each([
    ['relay@1.0', 'Current'],
    ['relay@1.4', 'Behind'],
    // A different MAJOR is Foreign in both directions — a lower one is not
    // "older and therefore safe", it may lack a shape this peer relies on.
    ['relay@0.9', 'Foreign'],
    ['relay@2.0', 'Foreign'],
    ['core@1.0', 'Foreign'],
    ['nonsense', 'Foreign'],
  ])('%s negotiates as %s', (received, outcome) => {
    expect(negotiate(received)).toBe(outcome);
  });

  it('proceeds on Behind, because within a major everything added is ignorable', () => {
    // §5.3 is what makes this safe: additive change is a minor bump, so a
    // newer peer's extra types and fields are all things an older peer skips.
    expect(negotiate('relay@1.9', 'relay@1.2')).toBe('Behind');
    expect(negotiate('relay@1.1', 'relay@1.7')).toBe('Current');
  });

  it('treats the relay and wire profile namespaces as distinct', () => {
    // §1.3: the two profile names are distinct namespaces, so a peer that
    // confuses them negotiates Foreign and refuses — the correct outcome.
    expect(negotiate('core@1.0')).toBe('Foreign');
  });
});

describe('session-profile selection (§6.3)', () => {
  it('answers with the highest profile the client accepts and this peer serves', () => {
    expect(selectSessionProfile(['relay@1.2', 'relay@1.1', 'relay@1.0'])).toBe('relay@1.2');
    // Order in `accepts` is the client's PREFERENCE, not the decision: §6.3
    // says highest, so a list in any order gives the same answer.
    expect(selectSessionProfile(['relay@1.0', 'relay@1.2', 'relay@1.1'])).toBe('relay@1.2');
  });

  it('keeps serving a client that predates this peer — the regression', () => {
    // The whole reason this is a selection and not `accepts.includes(own)`.
    // Under the inclusion test a `relay@1.0` client got `FOREIGN_PROFILE` from
    // any peer that had advanced, which is the entire population a backward-
    // compatible minor bump exists to keep serving (§5.3). The two forms agreed
    // while this peer was itself at 1.0 and stopped agreeing the moment it was
    // not — so the bump is exactly what makes this test meaningful.
    expect(selectSessionProfile(['relay@1.0'])).toBe('relay@1.0');
    expect(selectSessionProfile(['relay@1.1', 'relay@1.0'])).toBe('relay@1.1');
  });

  it('will not answer above its own minor', () => {
    // §5.1's superset rule runs one way only: a peer serves any minor at or
    // below its own, and claiming one above would promise entry points it does
    // not have.
    expect(selectSessionProfile(['relay@1.9'], 'relay@1.2')).toBeUndefined();
    expect(selectSessionProfile(['relay@1.9', 'relay@1.1'], 'relay@1.2')).toBe('relay@1.1');
  });

  it('has no answer for a foreign namespace, major, or malformed id', () => {
    // Each of these is the `FOREIGN_PROFILE` case, and `undefined` is how the
    // peer is told to raise it (§9.3).
    expect(selectSessionProfile(['relay@2.0'])).toBeUndefined();
    expect(selectSessionProfile(['relay@0.9'])).toBeUndefined();
    expect(selectSessionProfile(['core@1.0'])).toBeUndefined();
    expect(selectSessionProfile(['nonsense', 7, null])).toBeUndefined();
    expect(selectSessionProfile([])).toBeUndefined();
  });
});

describe('the actor class (§8.2.1)', () => {
  it('is a closed two-value set matching the op-stream actor discriminator', () => {
    expect([...ACTOR_CLASSES]).toEqual(['human', 'agent']);
    expect(isActorClass('human')).toBe(true);
    expect(isActorClass('agent')).toBe(true);
    expect(isActorClass('assistant')).toBe(false);
    expect(isActorClass(7)).toBe(false);
  });

  it('recognises read.affordances as a TYPE even though this peer serves none', () => {
    // §10.1: an unrecognised type is `UNKNOWN_MESSAGE` ("no such entry point"),
    // a recognised one whose capability was not advertised is
    // `CAPABILITY_ABSENT` ("it exists, this peer does not offer it"). A peer
    // declaring 1.2 owes the second answer, and it can only give it if the
    // token is in the set.
    expect(isRequestType('read.affordances')).toBe(true);
    expect(capabilityFor('read.affordances')).toBe('read.affordances');
  });
});

describe('capability gating (§4.2)', () => {
  it('names every request type after its own capability, except two', () => {
    expect(capabilityFor('hello')).toBeUndefined();
    expect(capabilityFor('read.tree')).toBe('read.tree');
    expect(capabilityFor('apply')).toBe('apply');
    // The one type whose gate is not its own name.
    expect(capabilityFor('unsubscribe')).toBe('subscribe');
  });

  it('recognises exactly the closed request-type set', () => {
    expect(isRequestType('read.nodeState')).toBe(true);
    expect(isRequestType('read.runtimeErrors')).toBe(false);
  });
});

describe('envelope guards (§3.2, §4)', () => {
  it('detects relay traffic by the $relay field alone', () => {
    expect(looksLikeRelayMessage({ $relay: 'relay@1.0' })).toBe(true);
    expect(looksLikeRelayMessage({ relay: 'relay@1.0' })).toBe(false);
    expect(looksLikeRelayMessage('relay@1.0')).toBe(false);
    expect(looksLikeRelayMessage(['relay@1.0'])).toBe(false);
    expect(looksLikeRelayMessage(null)).toBe(false);
  });

  it('requires a fully-shaped envelope, payload object included', () => {
    const base = request('c-1', 'read.tree', {});
    expect(isRelayEnvelope(base)).toBe(true);
    expect(isRelayEnvelope({ ...base, payload: [] })).toBe(false);
    expect(isRelayEnvelope({ ...base, payload: undefined })).toBe(false);
    expect(isRelayEnvelope({ ...base, dir: 'sideways' })).toBe(false);
    expect(isRelayEnvelope({ ...base, id: 7 })).toBe(false);
  });

  it('applies all four receive-side checks, in order', () => {
    const win = { origin: 'https://app.example' };
    const data = { $relay: RELAY_PROFILE };
    const pass = { source: win, origin: 'https://app.example', data };

    expect(acceptsMessageEvent(pass as never, win, win)).toBe(true);
    // A same-origin FRAME is still a different document with a different trust
    // story, so the origin check alone does not cover it (§11.2).
    expect(acceptsMessageEvent({ ...pass, source: {} } as never, win, win)).toBe(false);
    expect(
      acceptsMessageEvent({ ...pass, origin: 'https://evil.example' } as never, win, win),
    ).toBe(false);
    expect(acceptsMessageEvent({ ...pass, data: { hello: true } } as never, win, win)).toBe(false);
  });
});

describe('response constructors (§4.2, §9.1)', () => {
  it('derives the success type from the request type', () => {
    expect(ok('c-2', 'read.nodeState', {}).type).toBe('read.nodeState.ok');
  });

  it('always names the refused request type and omits an absent detail', () => {
    const denied = refusal('c-7', 'apply', 'POLICY_DENIED', 'no.');
    expect(denied.type).toBe('refusal');
    expect(denied.payload['requestType']).toBe('apply');
    // §9.3 / §11.5: POLICY_DENIED carries no detail by design — explaining why
    // policy refused hands out a map of the policy.
    expect('detail' in denied.payload).toBe(false);
  });
});
