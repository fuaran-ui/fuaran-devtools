// ============================================================================
//  The panel's write surfaces: what is offered, what is not, and what a refusal
//  looks like where the user is standing.
//
//  Two claims are load-bearing enough to test on the rendered DOM rather than
//  on the functions behind it:
//
//   * against a host with no apply capability the affordances are ABSENT, not
//     disabled — a greyed-out editor invites a developer to go looking for what
//     is wrong with their page, and one honest line tells them; and
//   * a refusal renders where the action was, carrying the host's CLASS and the
//     guidance for that class, because §8.4's three classes each imply a
//     different next action and a single red line would collapse them.
// ============================================================================

import { describe, expect, it, vi } from 'vitest';

import type { NodeSnapshot, TreeSnapshot } from '../src/relay/protocol.js';
import type { ApplyResult } from '../src/bridge.js';
import {
  descendsFrom,
  offerableKinds,
  renderPropertyEditor,
  renderStructural,
  valueOf,
  type EditContext,
} from '../src/panel/editSurface.js';
import { deriveSchema } from '../src/panel/schemaSource.js';
import { guidanceFor } from '../src/panel/refusal.js';
import { readWireSchema } from './support/corpus.js';

const derived = deriveSchema(readWireSchema())!;

const leaf = (id: string, kind: string): TreeSnapshot => ({
  id,
  kind,
  bindings: [],
  childIds: [],
  children: [],
});

const TREE: TreeSnapshot = {
  id: 'root',
  kind: 'Box',
  bindings: [],
  childIds: ['a', 'card'],
  children: [
    leaf('a', 'Heading'),
    { ...leaf('card', 'Box'), childIds: ['x'], children: [leaf('x', 'Heading')] },
  ],
};

const heading: NodeSnapshot = { id: 'a', kind: 'Heading', bindings: [], childIds: [] };

const context = (overrides: Partial<EditContext> = {}): EditContext => ({
  capabilities: ['read.tree', 'apply'],
  derived,
  tree: TREE,
  node: heading,
  held: undefined,
  commit: async () => ({ ok: true, treeRevision: 'r-2' }),
  reload: () => undefined,
  setHeld: () => undefined,
  ...overrides,
});

describe('committed values', () => {
  it.each([
    ['integer', '3', 3],
    ['number', '1.5', 1.5],
    ['text', 'Revenue', 'Revenue'],
  ])('parses a %s field', (kind, raw, expected) => {
    const result = valueOf({ kind } as never, raw, false);
    expect(result).toEqual({ ok: true, value: expected });
  });

  it('rejects a non-whole number locally rather than spending a round trip', () => {
    // A host would refuse it as a validator rejection, which is the wrong story
    // for "that is not a whole number".
    const result = valueOf({ kind: 'integer' }, '1.5', false);
    expect(result.ok).toBe(false);
  });

  it('rejects a value outside a choice field, naming the cases', () => {
    const result = valueOf({ kind: 'choice', options: ['Standard', 'Lead'] }, 'Nope', false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Standard, Lead');
  });

  it('reads a toggle from the checkbox, never from its text', () => {
    expect(valueOf({ kind: 'toggle' }, '', true)).toEqual({ ok: true, value: true });
  });

  it('returns a read-only field’s reason instead of a value', () => {
    const result = valueOf({ kind: 'readonly', reason: 'currently bound' }, 'x', false);
    expect(result).toEqual({ ok: false, error: 'currently bound' });
  });
});

describe('what the palette offers', () => {
  it('offers kinds under a parent that holds children', () => {
    expect(offerableKinds(derived, new Set(), 'Box').length).toBeGreaterThan(10);
  });

  it('offers nothing under a parent the schema says holds none', () => {
    // A local gate that REMOVES offers. Without a dry-run in the profile there
    // is no way to try a candidate before showing it, so the only honest
    // gating is what can be decided from what the panel already holds.
    expect(offerableKinds(derived, new Set(), 'Heading')).toEqual([]);
  });

  it('proceeds optimistically under a parent kind it does not recognise', () => {
    // Hiding on ignorance would make an unfamiliar page look uneditable rather
    // than unfamiliar, and the host's gate is there to have the last word.
    expect(offerableKinds(derived, new Set(), 'SomethingFromTheFuture').length).toBeGreaterThan(0);
  });

  it('knows a subtree from an unrelated branch', () => {
    expect(descendsFrom(TREE, 'card', 'x')).toBe(true);
    expect(descendsFrom(TREE, 'a', 'x')).toBe(false);
    expect(descendsFrom(TREE, 'card', 'card')).toBe(false);
  });
});

describe('read-only degradation', () => {
  const withoutApply = { capabilities: ['read.tree'] };

  it('renders no property affordance at all, and says why', () => {
    const section = renderPropertyEditor(context(withoutApply));
    expect(section.querySelectorAll('input, select, button')).toHaveLength(0);
    expect(section.textContent).toContain('no apply capability');
  });

  it('renders no structural affordance at all, and says why', () => {
    const section = renderStructural(context(withoutApply));
    expect(section.querySelectorAll('input, select, button')).toHaveLength(0);
    expect(section.textContent).toContain('no apply capability');
  });

  it('degrades to read-only rows when no schema was bundled', () => {
    const section = renderPropertyEditor(context({ derived: undefined }));
    expect(section.querySelectorAll('input, select')).toHaveLength(0);
    expect(section.textContent).toContain('No wire schema');
  });

  it('says an unknown kind is unknown, rather than showing an empty editor', () => {
    const section = renderPropertyEditor(
      context({ node: { id: 'z', kind: 'SomethingFromTheFuture', bindings: [], childIds: [] } }),
    );
    expect(section.textContent).toContain('SomethingFromTheFuture');
    expect(section.querySelectorAll('input, select')).toHaveLength(0);
  });
});

describe('the derived property editor', () => {
  it('renders one control per editable field of the focused kind', () => {
    const section = renderPropertyEditor(context());
    const names = [...section.querySelectorAll('.field-name')].map((el) => el.textContent);
    expect(names).toEqual(expect.arrayContaining(['Level', 'Text', 'Variant']));
    expect(section.querySelectorAll('select')).toHaveLength(1); // Variant is enumerated
  });

  it('offers no control for a slot the node currently binds', () => {
    const bound = renderPropertyEditor(
      context({
        node: { ...heading, bindings: [{ slot: 'Text', expression: '$state.t', source: 'State' }] },
      }),
    );
    const row = [...bound.querySelectorAll('.field')].find(
      (el) => el.querySelector('.field-name')?.textContent === 'Text',
    );
    expect(row?.querySelector('input')).toBeNull();
    expect(row?.querySelector('.field-why')?.textContent).toContain('discard the binding');
  });

  it('states that values are not readable, rather than implying the fields are empty', () => {
    // A blank box reading as "currently empty" is a lie about a field that may
    // well hold something — and the difference matters the moment someone
    // clears a field they could not see.
    expect(renderPropertyEditor(context()).textContent).toContain('not readable');
  });

  it('commits the typed value as an UpdateProp addressed by id and op path', async () => {
    const commit = vi.fn<EditContext['commit']>(async () => ({ ok: true, treeRevision: 'r-2' }));
    const reload = vi.fn();
    const section = renderPropertyEditor(context({ commit, reload }));

    const row = [...section.querySelectorAll('.field')].find(
      (el) => el.querySelector('.field-name')?.textContent === 'Level',
    )!;
    (row.querySelector('input') as HTMLInputElement).value = '3';
    (row.querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());

    expect(commit.mock.calls[0]?.[0]).toEqual({
      $type: 'UpdateProp',
      path: 'Level',
      target: 'a',
      value: 3,
    });
  });
});

describe('refusals render where the action was', () => {
  it('shows the class, the host’s message, and the guidance for that class', async () => {
    const commit = async (): Promise<ApplyResult> => ({
      ok: false,
      class: 'VALIDATOR_REJECT',
      message: 'The op decoded but the apply engine rejected it.',
    });
    const reload = vi.fn();
    const section = renderPropertyEditor(context({ commit, reload }));

    const row = [...section.querySelectorAll('.field')].find(
      (el) => el.querySelector('.field-name')?.textContent === 'Level',
    )!;
    (row.querySelector('input') as HTMLInputElement).value = '3';
    (row.querySelector('button') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(section.querySelector('.refusal')).not.toBeNull());
    const refusal = section.querySelector('.refusal')!;
    expect(refusal.querySelector('.refusal-class')?.textContent).toBe('VALIDATOR_REJECT');
    expect(refusal.querySelector('.refusal-message')?.textContent).toContain('apply engine');
    expect(refusal.querySelector('.refusal-guidance')?.textContent).toBe(
      guidanceFor('VALIDATOR_REJECT'),
    );
    // Nothing is re-read: the tree is unchanged, so there is nothing to re-read.
    expect(reload).not.toHaveBeenCalled();
    expect(refusal.getAttribute('role')).toBe('alert');
  });

  it('gives each class its own guidance, never one line for all of them', () => {
    const classes = ['VALIDATOR_REJECT', 'POLICY_DENIED', 'NOT_OPTED_IN', 'CAPABILITY_ABSENT'];
    const guidance = classes.map(guidanceFor);
    expect(new Set(guidance).size).toBe(classes.length);
    // The one that is easiest to get wrong: a policy refusal must not suggest
    // changing the edit, because no change to the edit can help.
    expect(guidanceFor('POLICY_DENIED')).toContain('No change to the edit will help');
  });

  it('carries an unknown class through by name (§10.3)', () => {
    expect(guidanceFor('HEAT_DEATH')).toContain('refused');
  });
});
