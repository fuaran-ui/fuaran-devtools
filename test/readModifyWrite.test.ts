// ============================================================================
//  Read-modify-write: what the editor becomes once `read.nodeJson` (§7.7) has
//  arrived, and what it stays when the read has not.
//
//  Every claim here is asserted on the RENDERED DOM or on the op that reached
//  `commit`, because every one of them is a claim about what the user sees and
//  what is sent — not about what a function returns. The degradation claim in
//  particular is only checkable there: "absent, not disabled" is a statement
//  about what is IN the DOM.
//
//  Kept beside `editSurface.test.ts` rather than folded into it, and the
//  division is by SUBJECT rather than by age: that file drives the surface
//  with no read, which is exactly the shape a page that does not serve one
//  gets, so it goes on asserting the degraded behaviour as its default. This
//  file is the enhancement.
// ============================================================================

import { describe, expect, it, vi } from 'vitest';

import type { NodeJsonRead, NodeSnapshot, TreeSnapshot } from '../src/relay/protocol.js';
import {
  renderPropertyEditor,
  renderStyleEditor,
  type EditContext,
} from '../src/panel/editSurface.js';
import { deriveSchema } from '../src/panel/schemaSource.js';
import { guidanceFor } from '../src/panel/refusal.js';
import { readWireSchema } from './support/corpus.js';

const derived = deriveSchema(readWireSchema())!;

const TREE: TreeSnapshot = {
  id: 'root',
  kind: 'Box',
  bindings: [],
  childIds: ['a', 'grid-1'],
  children: [
    { id: 'a', kind: 'Heading', bindings: [], childIds: [], children: [] },
    { id: 'grid-1', kind: 'DataGrid', bindings: [], childIds: [], children: [] },
  ],
};

const heading: NodeSnapshot = { id: 'a', kind: 'Heading', bindings: [], childIds: [] };
const grid: NodeSnapshot = { id: 'grid-1', kind: 'DataGrid', bindings: [], childIds: [] };

const context = (overrides: Partial<EditContext> = {}): EditContext => ({
  capabilities: ['read.tree', 'apply', 'read.nodeJson'],
  derived,
  tree: TREE,
  node: heading,
  nodeJson: undefined,
  held: undefined,
  commit: async () => ({ ok: true, treeRevision: 'r-2' }),
  revision: () => 'r-1',
  reread: async () => undefined,
  reload: () => undefined,
  setHeld: () => undefined,
  ...overrides,
});

const read = (node: Record<string, unknown>, treeRevision = 'r-1'): NodeJsonRead => ({
  node,
  treeRevision,
});

/** The focused Heading, as a host's canonical encoder would render it. */
const headingJson = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'a',
  kind: { $type: 'Heading', level: 2, text: 'Revenue', variant: 'Standard' },
  ...overrides,
});

const headingAt = (level: number, text: string): Record<string, unknown> => ({
  id: 'a',
  kind: { $type: 'Heading', level, text, variant: 'Standard' },
});

const gridJson = (columns: unknown[]): Record<string, unknown> => ({
  id: 'grid-1',
  kind: { $type: 'DataGrid', columns, source: { $type: 'Query', name: 'channels' } },
});

const column = (label: string): Record<string, unknown> => ({
  kind: { $type: 'Text' },
  label,
  value: '<closure>',
});

const rowFor = (section: HTMLElement, name: string): HTMLElement =>
  [...section.querySelectorAll('.field')].find(
    (el) => el.querySelector('.field-name')?.textContent === name,
  ) as HTMLElement;

const controlIn = (row: HTMLElement): HTMLInputElement | HTMLSelectElement =>
  row.querySelector('input, select') as HTMLInputElement | HTMLSelectElement;

const markIn = (row: HTMLElement): HTMLElement => row.querySelector('.field-dirty') as HTMLElement;

/** Set a control's value the way a user does — the events the panel listens on. */
const type = (input: HTMLInputElement | HTMLSelectElement, value: string): void => {
  input.value = value;
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new Event('change'));
};

/** Type into a row's control and press its own Set button. */
const setField = (section: HTMLElement, name: string, value: string): void => {
  const row = rowFor(section, name);
  controlIn(row).value = value;
  (row.querySelector('button') as HTMLButtonElement).click();
};

const okCommit = () =>
  vi.fn<EditContext['commit']>(async () => ({ ok: true, treeRevision: 'r-2' }));

describe('the property editor shows what is there before changing it', () => {
  it('seeds every control from the read rather than from blank', () => {
    const section = renderPropertyEditor(context({ nodeJson: read(headingJson()) }));
    expect((controlIn(rowFor(section, 'Level')) as HTMLInputElement).value).toBe('2');
    expect((controlIn(rowFor(section, 'Text')) as HTMLInputElement).value).toBe('Revenue');
    expect((controlIn(rowFor(section, 'Variant')) as HTMLSelectElement).value).toBe('Standard');
    // And the standing apology for not knowing is gone, because it is no longer
    // true. Leaving it would be its own kind of lie.
    expect(section.textContent).not.toContain('not readable');
  });

  it('emits nothing for a field the user did not change', async () => {
    const commit = okCommit();
    const section = renderPropertyEditor(context({ commit, nodeJson: read(headingJson()) }));

    (rowFor(section, 'Level').querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(section.textContent).toContain('Unchanged'));
    // The diff is against the READ, so pressing Set on an untouched field is
    // not an edit. An op here would be a line in the host's audit trail saying
    // someone changed something, about a change that did not happen.
    expect(commit).not.toHaveBeenCalled();
  });

  it('emits an UpdateProp for exactly the field that changed', async () => {
    const commit = okCommit();
    const reload = vi.fn();
    const section = renderPropertyEditor(
      context({ commit, reload, nodeJson: read(headingJson()) }),
    );

    setField(section, 'Text', 'Channels');
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]?.[0]).toEqual({
      $type: 'UpdateProp',
      path: 'Text',
      target: 'a',
      value: 'Channels',
    });
  });

  it('keeps a bound slot read-only even now that its value can be seen', () => {
    // The 737 guard is unchanged by the read: committing a literal into a slot
    // holding a binding would discard the binding, and being able to see what
    // the binding resolves to does not make that less true.
    const section = renderPropertyEditor(
      context({
        node: { ...heading, bindings: [{ slot: 'Text', expression: '$state.t', source: 'State' }] },
        nodeJson: read(headingJson()),
      }),
    );
    const row = rowFor(section, 'Text');
    expect(row.querySelector('input')).toBeNull();
    expect(row.querySelector('.field-why')?.textContent).toContain('discard the binding');
  });
});

describe('the dirty indicator: what you see against what the page holds', () => {
  it('shows no mark on a control still holding the read value', () => {
    const section = renderPropertyEditor(context({ nodeJson: read(headingJson()) }));
    expect(markIn(rowFor(section, 'Text')).hidden).toBe(true);
  });

  it('marks the row once the control differs from the read', () => {
    const section = renderPropertyEditor(context({ nodeJson: read(headingJson()) }));
    const row = rowFor(section, 'Text');
    type(controlIn(row), 'Channels');
    expect(markIn(row).hidden).toBe(false);
  });

  it('clears the mark when the control is typed back to what was read', () => {
    // Against the READ, never against the last thing committed. A mark that
    // reset on commit would read clean at exactly the moment a refusal left the
    // control and the page genuinely disagreeing.
    const section = renderPropertyEditor(context({ nodeJson: read(headingJson()) }));
    const row = rowFor(section, 'Text');
    type(controlIn(row), 'Channels');
    type(controlIn(row), 'Revenue');
    expect(markIn(row).hidden).toBe(true);
  });

  it('agrees with the commit path — a marked row is one that sends an op', async () => {
    // The mark and the behaviour are the same comparison, so this is the
    // assertion that keeps them from drifting apart: a marked row emits, and an
    // unmarked one answers "unchanged" and sends nothing.
    const commit = okCommit();
    const section = renderPropertyEditor(context({ commit, nodeJson: read(headingJson()) }));
    const row = rowFor(section, 'Text');

    expect(markIn(row).hidden).toBe(true);
    (row.querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(section.textContent).toContain('Unchanged'));
    expect(commit).not.toHaveBeenCalled();

    type(controlIn(row), 'Channels');
    expect(markIn(row).hidden).toBe(false);
    (row.querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(commit).toHaveBeenCalled());
  });

  it('marks a toggle from its checked state, not from its text', () => {
    // A checkbox's `value` never moves, so a mark comparing that would never
    // fire. It compares what `displayOf` compares, which is the checked state.
    const section = renderPropertyEditor(
      context({
        node: { id: 'list-1', kind: 'List', bindings: [], childIds: [] },
        nodeJson: read({ id: 'list-1', kind: { $type: 'List', ordered: false, items: [] } }),
      }),
    );
    const row = rowFor(section, 'Ordered');
    const input = controlIn(row) as HTMLInputElement;
    expect(input.type).toBe('checkbox');
    expect(markIn(row).hidden).toBe(true);
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    expect(markIn(row).hidden).toBe(false);
  });

  it('offers no mark at all in set-only mode', () => {
    // There is no page value to be dirty against, so a mark comparing a typed
    // value to a blank control would claim a comparison nothing performed.
    const section = renderPropertyEditor(context({ nodeJson: undefined }));
    const row = rowFor(section, 'Text');
    type(controlIn(row), 'Channels');
    expect(row.querySelector('.field-dirty')).toBeNull();
  });

  it('marks each style token separately, because the commit is one button', () => {
    const section = renderStyleEditor(
      context({ nodeJson: read(headingJson({ style: { emphasis: 'Loud', tone: 'Success' } })) }),
    );
    const tone = rowFor(section, 'tone');
    type(controlIn(tone), 'Critical');
    expect(markIn(tone).hidden).toBe(false);
    // The untouched token is what a one-token edit preserves, and the absence
    // of a mark beside it is how the user can see that before pressing Set.
    expect(markIn(rowFor(section, 'emphasis')).hidden).toBe(true);
  });
});

describe('sentinel-valued fields are read-only, and never round-trip (§7.7 rule 2)', () => {
  it('renders a sentinel as a read-only row naming what it stands for', () => {
    const section = renderPropertyEditor(
      context({ node: grid, nodeJson: read(gridJson([column('Channel')])) }),
    );
    const row = rowFor(section, 'Columns[0].Value');
    expect(row).toBeDefined();
    expect(row.querySelector('input, select')).toBeNull();
    expect(row.querySelector('.field-why')?.textContent).toContain('host closure');
    expect(row.querySelector('.field-value')?.textContent).toBe('<closure>');
  });

  it('emits no op carrying a sentinel, from any surface', async () => {
    const commit = okCommit();
    const json = read({
      id: 'a',
      kind: { $type: 'Heading', level: 2, text: '<closure>', variant: 'Standard' },
      style: { tone: '<opaque>' },
    });
    const ctx = context({ commit, nodeJson: json });

    // Every control the panel offers, pressed. Nothing that reaches `commit`
    // may carry a sentinel — a stronger claim than "the sentinel rows are
    // read-only", because it also covers a style block MERGED from a read that
    // holds one.
    const property = renderPropertyEditor(ctx);
    setField(property, 'Level', '3');
    const style = renderStyleEditor(ctx);
    (controlIn(rowFor(style, 'emphasis')) as HTMLSelectElement).value = 'Loud';
    (style.querySelector('button') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(commit).toHaveBeenCalled());
    for (const [op] of commit.mock.calls)
      expect(JSON.stringify(op)).not.toMatch(/<closure>|<opaque>/);
  });
});

describe('indexed paths, derived from the collection’s current length', () => {
  it('expands one row per element, and none past the end', () => {
    const section = renderPropertyEditor(
      context({ node: grid, nodeJson: read(gridJson([column('Channel'), column('Revenue')])) }),
    );
    const names = [...section.querySelectorAll('.field-name')].map((el) => el.textContent);
    expect(names).toContain('Columns[0].Label');
    expect(names).toContain('Columns[1].Label');
    // The length came from the read, so there is no row two — and there could
    // not have been, because nothing in the schema says how many there are.
    expect(names).not.toContain('Columns[2].Label');
  });

  it('offers no indexed rows for a collection the read shows as empty', () => {
    const section = renderPropertyEditor(context({ node: grid, nodeJson: read(gridJson([])) }));
    const names = [...section.querySelectorAll('.field-name')].map((el) => el.textContent);
    // Not even `[0]`. Offering row zero on the strength of the schema alone
    // would address a position nothing put anything in.
    expect(names.filter((name) => name?.startsWith('Columns['))).toEqual([]);
  });

  it('commits a column label through its derived indexed path', async () => {
    const commit = okCommit();
    const reload = vi.fn();
    const section = renderPropertyEditor(
      context({
        node: grid,
        commit,
        reload,
        nodeJson: read(gridJson([column('Channel'), column('Revenue')])),
      }),
    );

    setField(section, 'Columns[1].Label', 'Turnover');
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    expect(commit.mock.calls[0]?.[0]).toEqual({
      $type: 'UpdateProp',
      path: 'Columns[1].Label',
      target: 'grid-1',
      value: 'Turnover',
    });
  });

  it('refuses an index the freshest read no longer authorises', async () => {
    const commit = okCommit();
    // Rendered at two columns; by commit time the page holds one, and the
    // panel knows the revision moved.
    const section = renderPropertyEditor(
      context({
        node: grid,
        commit,
        nodeJson: read(gridJson([column('Channel'), column('Revenue')]), 'r-1'),
        revision: () => 'r-2',
        reread: async () => read(gridJson([column('Channel')]), 'r-2'),
      }),
    );

    setField(section, 'Columns[1].Label', 'Turnover');
    await vi.waitFor(() => expect(section.querySelector('.refusal')).not.toBeNull());
    // The refusal arrives INSTEAD of the edit, not after it: an out-of-range
    // path never reaches the wire.
    expect(commit).not.toHaveBeenCalled();
    expect(section.querySelector('.refusal-message')?.textContent).toContain('1 element(s)');
  });
});

describe('the style editor commits the whole merged block', () => {
  const styled = (): NodeJsonRead =>
    read(headingJson({ style: { emphasis: 'Loud', tone: 'Success' } }));

  it('seeds each token from the block the node carries', () => {
    const section = renderStyleEditor(context({ nodeJson: styled() }));
    expect((controlIn(rowFor(section, 'tone')) as HTMLSelectElement).value).toBe('Success');
    expect((controlIn(rowFor(section, 'emphasis')) as HTMLSelectElement).value).toBe('Loud');
  });

  it('preserves every other token when one is changed — the falsifier', async () => {
    const commit = okCommit();
    const reload = vi.fn();
    const section = renderStyleEditor(context({ commit, reload, nodeJson: styled() }));

    (controlIn(rowFor(section, 'tone')) as HTMLSelectElement).value = 'Critical';
    (section.querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());

    // ONE op, carrying the WHOLE block. `UpdateStyle` replaces the block, so an
    // op naming only `tone` would have deleted `emphasis` — which is exactly
    // why this surface did not exist before the block could be read.
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]?.[0]).toEqual({
      $type: 'UpdateStyle',
      style: { emphasis: 'Loud', tone: 'Critical' },
      target: 'a',
    });
  });

  it('carries forward a token this build does not know', async () => {
    const commit = okCommit();
    const section = renderStyleEditor(
      context({
        commit,
        nodeJson: read(headingJson({ style: { tone: 'Success', somethingNewer: 'Whatever' } })),
      }),
    );
    // It is SHOWN, read-only, so what the commit will carry forward is visible
    // rather than merely promised.
    expect(rowFor(section, 'somethingNewer').textContent).toContain('preserved unchanged');

    (controlIn(rowFor(section, 'tone')) as HTMLSelectElement).value = 'Critical';
    (section.querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(commit).toHaveBeenCalled());
    expect((commit.mock.calls[0]?.[0] as Record<string, unknown>)['style']).toEqual({
      tone: 'Critical',
      somethingNewer: 'Whatever',
    });
  });

  it('clears a token by removing it from the block', async () => {
    const commit = okCommit();
    const section = renderStyleEditor(context({ commit, nodeJson: styled() }));
    (controlIn(rowFor(section, 'tone')) as HTMLSelectElement).value = '';
    (section.querySelector('button') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(commit).toHaveBeenCalled());
    expect((commit.mock.calls[0]?.[0] as Record<string, unknown>)['style']).toEqual({
      emphasis: 'Loud',
    });
  });

  it('edits from empty when the node carries no block at all', async () => {
    const commit = okCommit();
    const section = renderStyleEditor(context({ commit, nodeJson: read(headingJson()) }));
    (controlIn(rowFor(section, 'tone')) as HTMLSelectElement).value = 'Critical';
    (section.querySelector('button') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(commit).toHaveBeenCalled());
    expect((commit.mock.calls[0]?.[0] as Record<string, unknown>)['style']).toEqual({
      tone: 'Critical',
    });
  });

  it('emits nothing when no token was touched', async () => {
    const commit = okCommit();
    const section = renderStyleEditor(context({ commit, nodeJson: styled() }));
    (section.querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(section.textContent).toContain('Unchanged'));
    expect(commit).not.toHaveBeenCalled();
  });

  it('shows a refused style edit where the action was, by class', async () => {
    // The same discipline the property rows follow, asserted on this surface
    // too: the class, the host's own message, and the guidance for that class,
    // rendered beside the button that was pressed. §8.4 separates the classes
    // because each implies a different next action; a toast would collapse them
    // AND move the answer away from the question.
    const section = renderStyleEditor(
      context({
        commit: async () => ({
          ok: false,
          class: 'POLICY_DENIED',
          message: 'The host does not permit styling from the inspector.',
        }),
        nodeJson: styled(),
      }),
    );
    (controlIn(rowFor(section, 'tone')) as HTMLSelectElement).value = 'Critical';
    (section.querySelector('button') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(section.querySelector('.refusal')).not.toBeNull());
    const refusal = section.querySelector('.refusal') as HTMLElement;
    expect(refusal.querySelector('.refusal-class')?.textContent).toBe('POLICY_DENIED');
    expect(refusal.querySelector('.refusal-message')?.textContent).toBe(
      'The host does not permit styling from the inspector.',
    );
    expect(refusal.querySelector('.refusal-guidance')?.textContent).toBe(
      guidanceFor('POLICY_DENIED'),
    );
    // And the controls are untouched: §8.3 says a refused op left the tree
    // unchanged, so the panel must not act as though anything moved.
    expect((controlIn(rowFor(section, 'tone')) as HTMLSelectElement).value).toBe('Critical');
  });

  it('merges over the FRESH block when the tree moved', async () => {
    const commit = okCommit();
    const section = renderStyleEditor(
      context({
        commit,
        nodeJson: styled(),
        revision: () => 'r-2',
        // Another writer added a token between the read and the commit.
        reread: async () =>
          read(
            headingJson({ style: { emphasis: 'Loud', tone: 'Success', weight: 'Spacious' } }),
            'r-2',
          ),
      }),
    );

    (controlIn(rowFor(section, 'tone')) as HTMLSelectElement).value = 'Critical';
    (section.querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(commit).toHaveBeenCalled());
    // The change is re-applied over what the page holds NOW, so the token added
    // in the window survives an edit to a different one.
    expect((commit.mock.calls[0]?.[0] as Record<string, unknown>)['style']).toEqual({
      emphasis: 'Loud',
      tone: 'Critical',
      weight: 'Spacious',
    });
  });
});

describe('the staleness posture: read at r, commit intended-at-r', () => {
  it('re-reads and re-diffs when the tree moved under the edit', async () => {
    const commit = okCommit();
    const reload = vi.fn();
    const reread = vi.fn(async () => read(headingAt(4, 'Moved'), 'r-2'));
    const section = renderPropertyEditor(
      context({
        commit,
        reload,
        reread,
        nodeJson: read(headingJson(), 'r-1'),
        revision: () => 'r-2',
      }),
    );

    setField(section, 'Level', '3');
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    expect(reread).toHaveBeenCalledTimes(1);
    // The op is composed AFTER the re-read, so it is an edit to the tree the
    // page actually holds rather than to the one the panel had drawn.
    expect(commit.mock.calls[0]?.[0]).toEqual({
      $type: 'UpdateProp',
      path: 'Level',
      target: 'a',
      value: 3,
    });
  });

  it('sends nothing when the fresh read already holds the value', async () => {
    const commit = okCommit();
    const section = renderPropertyEditor(
      context({
        commit,
        nodeJson: read(headingJson(), 'r-1'),
        revision: () => 'r-2',
        // Someone else already set it to what this user was about to type.
        reread: async () => read(headingAt(3, 'Revenue'), 'r-2'),
      }),
    );

    setField(section, 'Level', '3');
    await vi.waitFor(() => expect(section.textContent).toContain('already holds'));
    expect(commit).not.toHaveBeenCalled();
  });

  it('refuses rather than committing when the re-read fails', async () => {
    const commit = okCommit();
    const section = renderPropertyEditor(
      context({
        commit,
        nodeJson: read(headingJson(), 'r-1'),
        revision: () => 'r-2',
        reread: async () => undefined,
      }),
    );

    setField(section, 'Level', '3');
    await vi.waitFor(() => expect(section.querySelector('.refusal')).not.toBeNull());
    // Falling back to the stale read would commit exactly the edit this path
    // exists to prevent.
    expect(commit).not.toHaveBeenCalled();
    expect(section.querySelector('.refusal-class')?.textContent).toBe('STALE_READ');
  });

  it('does not re-read when the revision has not moved', async () => {
    const reread = vi.fn(async () => read(headingJson(), 'r-1'));
    const reload = vi.fn();
    const section = renderPropertyEditor(
      context({ reload, reread, nodeJson: read(headingJson(), 'r-1'), revision: () => 'r-1' }),
    );
    setField(section, 'Level', '3');
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    expect(reread).not.toHaveBeenCalled();
  });
});

describe('against a peer that does not serve the read, nothing is offered', () => {
  // Task 5's claim, and it is a claim about what is IN the DOM: the
  // enhancements are ABSENT, not present-and-disabled. A greyed control invites
  // a developer to work out what is wrong with their page; absence plus one
  // honest line tells them.
  const setOnly = (): EditContext =>
    context({ node: grid, nodeJson: undefined, capabilities: ['read.tree', 'apply'] });

  it('keeps the set-only editor and says values are not readable', () => {
    expect(renderPropertyEditor(setOnly()).textContent).toContain('not readable');
  });

  it('offers no indexed rows at all', () => {
    const names = [...renderPropertyEditor(setOnly()).querySelectorAll('.field-name')].map(
      (el) => el.textContent,
    );
    expect(names.filter((name) => name?.includes('['))).toEqual([]);
  });

  it('renders no style control, and says why', () => {
    const section = renderStyleEditor(setOnly());
    expect(section.querySelectorAll('input, select, button')).toHaveLength(0);
    expect(section.textContent).toContain('replaces the whole block');
  });

  it('renders no style control against a page with no apply either', () => {
    const section = renderStyleEditor(context({ capabilities: ['read.tree'] }));
    expect(section.querySelectorAll('input, select, button')).toHaveLength(0);
    expect(section.textContent).toContain('no apply capability');
  });

  it('still commits what is typed, exactly as the set-only editor always did', async () => {
    const commit = okCommit();
    const reload = vi.fn();
    const section = renderPropertyEditor(
      context({ commit, reload, nodeJson: undefined, capabilities: ['read.tree', 'apply'] }),
    );
    setField(section, 'Level', '3');
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    // No diff, no re-anchor, no refusal: with no read there is nothing to diff
    // against, and refusing here would take away the surface this page has.
    expect(commit.mock.calls[0]?.[0]).toEqual({
      $type: 'UpdateProp',
      path: 'Level',
      target: 'a',
      value: 3,
    });
  });
});
