// ============================================================================
//  panel/editSurface — the write half of the panel: properties, style, and
//  structure.
//
//  Three surfaces, one discipline. Each derives what it offers from the wire
//  schema rather than from a table of kinds written here; each proposes ops
//  through the page's own gated apply path; each renders a refusal exactly
//  where the action was, by class, and changes nothing on refusal.
//
//  ── What the panel can now know, and what follows from it ──────────────────
//
//  `read.nodeJson` (§7.7) returns the focused node's own canonical wire JSON,
//  so the property editor is READ-MODIFY-WRITE: a field shows what is there
//  before it is changed, and a commit emits an op only for what the user
//  actually changed — diffed against the read, never against blank. Three
//  things follow, and each was withheld before this read existed rather than
//  approximated:
//
//   * STYLE EDITING EXISTS. `UpdateStyle` replaces a node's whole block and has
//     no per-token path, so one token could only be committed by discarding
//     every other. With the block in hand the commit merges over what was read,
//     which preserves the rest BY CONSTRUCTION — including tokens this build's
//     schema has never heard of.
//   * INDEXED PATHS ARE DERIVABLE. `Columns[0].Label` needs the collection's
//     current length, and nothing else in the contract reports it. Rows are
//     derived from the read's length, and the length is taken again from a
//     fresh read before a commit, so an out-of-range index is never emitted.
//   * SENTINELS ARE READ-ONLY. A value the wire format cannot carry arrives as
//     `"<closure>"` / `"<opaque>"` (§7.7 rule 2). Those rows show the sentinel
//     with the honest reason and offer no control: writing one back would
//     replace a live affordance with text that renders and does nothing.
//
//  ── Against a peer that does not serve it ──────────────────────────────────
//
//  The read is a capability, so a page that does not advertise it gets exactly
//  the surface this panel shipped before: a set-only property editor that says
//  values are not readable, no style section, no indexed rows. ABSENT, not
//  disabled — the same rule the apply-less degradation follows, for the same
//  reason. Every enhancement here is gated on the READ having arrived, not on
//  the capability having been advertised, so a read that was refused or timed
//  out degrades identically rather than half-rendering.
// ============================================================================

import {
  isSentinel,
  type NodeJsonRead,
  type NodeSnapshot,
  type TreeSnapshot,
} from '../relay/protocol.js';
import type { ApplyResult } from '../bridge.js';
import {
  insertOp,
  moveOp,
  nudgeOp,
  removeNode,
  updateProp,
  updateStyle,
  type Placement,
  type TreeOpJson,
} from '../edit/ops.js';
import {
  acceptsChildren,
  collectionsFor,
  fieldsFor,
  styleTokens,
  type Control,
  type Field,
} from '../schema/wireSchema.js';
import { synthesiseNode } from '../schema/synthesise.js';
import {
  carriesSentinel,
  collectionLength,
  displayValue,
  mergeStyle,
  styleBlock,
  valueAtPath,
} from './nodeJson.js';
import { allNodeIds, parentOf, siblingIds } from './treeModel.js';
import { guidanceFor } from './refusal.js';
import { el, note } from './dom.js';
import type { DerivedSchema } from './schemaSource.js';

export interface EditContext {
  /** The capabilities the handshake advertised (§6.3). */
  readonly capabilities: readonly string[];
  /** The derived wire schema, or `undefined` when none was bundled/loaded. */
  readonly derived: DerivedSchema | undefined;
  readonly tree: TreeSnapshot | undefined;
  readonly node: NodeSnapshot;
  /**
   * The focused node's wire JSON as it was read on focus, or `undefined` when
   * the page serves no `read.nodeJson` — or served one that did not arrive.
   *
   * Its `treeRevision` is the revision the derivation is anchored to. Held per
   * focus rather than globally: it describes THIS node at THAT moment, and a
   * read of another node says nothing about this one.
   */
  readonly nodeJson: NodeJsonRead | undefined;
  /** The node currently picked up for a move, if any. */
  readonly held: string | undefined;
  /** Propose one op. Resolves with the outcome; never throws for a refusal. */
  commit(op: TreeOpJson, reason: string): Promise<ApplyResult>;
  /**
   * The revision the panel last saw from the page — a `changed` event, an
   * applied op, or the handshake. Compared against the read's own revision to
   * decide whether an edit is being derived from a tree the user is still
   * looking at. Opaque: compared, never parsed (§5.4).
   */
  revision(): string | undefined;
  /**
   * Read the focused node's wire JSON again, now. `undefined` when the page
   * cannot serve it or the read failed — a caller that gets `undefined` must
   * not fall back to the stale read, because the whole point of asking was that
   * the stale one may be wrong.
   */
  reread(): Promise<NodeJsonRead | undefined>;
  /** Re-read the tree and re-render — called after an applied op. */
  reload(): void;
  /** Pick up / put down a node for a move. */
  setHeld(nodeId: string | undefined): void;
}

const canApply = (context: EditContext): boolean => context.capabilities.includes('apply');

/** The inline refusal line: the host's class and message, plus what to do. */
const refusalLine = (refusalClass: string, message: string): HTMLElement => {
  const box = el('div', 'refusal');
  box.setAttribute('role', 'alert');
  box.appendChild(el('span', 'refusal-class', refusalClass));
  box.appendChild(el('span', 'refusal-message', message));
  box.appendChild(el('span', 'refusal-guidance', guidanceFor(refusalClass)));
  return box;
};

/**
 * Run one proposed op and report the outcome where the action was.
 *
 * `slot` is emptied first so a second attempt never shows the previous
 * refusal beside a new result — a stale refusal reads as a fresh one.
 */
const propose = async (
  context: EditContext,
  slot: HTMLElement,
  op: TreeOpJson,
  reason: string,
): Promise<void> => {
  slot.replaceChildren();
  const result = await context.commit(op, reason);
  if (result.ok) {
    // Nothing is patched into a local copy of the tree: the host applied it,
    // the host is the arbiter, and re-reading is how the panel finds out what
    // the tree actually became — including anything another writer did in the
    // same window.
    context.reload();
    return;
  }
  slot.appendChild(refusalLine(result.class, result.message));
};

// ─── Property editor ────────────────────────────────────────────────

/**
 * The control for one editable field, SEEDED from the read where there is one.
 *
 * The empty first option on a choice stays, and its reason changes: it was
 * "nothing may be preselected, because nothing is known", and it is now "this
 * field may genuinely be absent, and absent is not the schema's first case".
 */
const controlFor = (
  label: string,
  control: Exclude<Control, { kind: 'readonly' }>,
  read: unknown,
): HTMLInputElement | HTMLSelectElement => {
  if (control.kind === 'choice') {
    const select = el('select', 'field-input');
    const empty = el('option', undefined, '—');
    empty.value = '';
    select.appendChild(empty);
    for (const option of control.options) {
      const item = el('option', undefined, option);
      item.value = option;
      select.appendChild(item);
    }
    select.value = typeof read === 'string' && control.options.includes(read) ? read : '';
    select.setAttribute('aria-label', label);
    return select;
  }
  const input = el('input', 'field-input');
  input.type = control.kind === 'toggle' ? 'checkbox' : 'text';
  if (control.kind === 'toggle') input.checked = read === true;
  else input.value = displayValue(read);
  if (control.kind === 'integer' || control.kind === 'number') input.inputMode = 'decimal';
  input.setAttribute('aria-label', label);
  return input;
};

/** What a control currently shows, as one comparable string. */
const displayOf = (input: HTMLInputElement | HTMLSelectElement): string =>
  input instanceof HTMLInputElement && input.type === 'checkbox'
    ? String(input.checked)
    : input.value;

/**
 * The read to derive an edit from, taken again when the tree has moved.
 *
 * `read at revision r, commit intended-at-r`: the panel holds the revision the
 * read was taken at, and the page reports the revision it is at now. When they
 * differ the derivation is re-anchored BEFORE the op is composed — values
 * re-diffed, collection lengths re-derived — rather than committing against a
 * tree the user was never looking at.
 *
 * `stale: true` with `read: undefined` is the case that must not be collapsed
 * into "no read": the panel KNOWS its derivation is out of date and could not
 * replace it, so falling back to the held read would commit exactly the edit
 * this path exists to prevent.
 */
const anchoredRead = async (
  context: EditContext,
): Promise<{ readonly read: NodeJsonRead | undefined; readonly stale: boolean }> => {
  const held = context.nodeJson;
  if (held === undefined) return { read: undefined, stale: false };
  if (context.revision() === held.treeRevision) return { read: held, stale: false };
  return { read: await context.reread(), stale: true };
};

const STALE_MESSAGE =
  'The page changed and this node could not be re-read, so the edit was not sent — ' +
  'it would have been derived from a tree that no longer exists. Press Refresh.';

/** §7.7 rule 2, as the last thing checked before an op is composed. */
const SENTINEL_MESSAGE =
  'That value is a sentinel standing for something the wire format cannot carry, ' +
  'so it is never written back.';

/**
 * One editable row of the property editor, top-level or indexed alike.
 *
 * `bounds` is present only on an indexed row, and carries what authorised the
 * index: the collection's op path, and the position. It is re-checked against
 * the FRESH read at commit time, so a collection another writer shortened
 * cannot be addressed out of range — the refusal arrives instead of the edit
 * rather than after it.
 */
interface EditableRow {
  readonly path: string;
  readonly label: string;
  readonly control: Exclude<Control, { kind: 'readonly' }>;
  readonly read: unknown;
  readonly bounds?: { readonly collection: string; readonly index: number };
}

const appendRow = (section: HTMLElement, context: EditContext, row: EditableRow): void => {
  const line = el('div', 'field');
  line.appendChild(el('span', 'field-name', row.label));

  const input = controlFor(row.label, row.control, row.read);
  const seeded = displayOf(input);
  line.appendChild(input);

  const commit = el('button', 'field-commit', 'Set');
  commit.type = 'button';
  const outcome = el('div', 'field-outcome');

  commit.addEventListener('click', () => {
    outcome.replaceChildren();
    const value = valueOf(
      row.control,
      input.value,
      input instanceof HTMLInputElement && input.checked,
    );
    if (!value.ok) {
      outcome.appendChild(refusalLine('VALIDATOR_REJECT', value.error));
      return;
    }

    // Set-only mode: no read arrived, so there is nothing to diff against and
    // nothing to re-anchor. This is 737's behaviour exactly, reached by the one
    // condition that matters — the read is absent — rather than by a second
    // code path that could drift from it.
    if (context.nodeJson === undefined) {
      void propose(
        context,
        outcome,
        updateProp(context.node.id, row.path, value.value),
        `set ${row.path}`,
      );
      return;
    }

    if (displayOf(input) === seeded) {
      outcome.appendChild(note('Unchanged — nothing to commit.'));
      return;
    }

    void (async () => {
      const { read, stale } = await anchoredRead(context);
      if (read === undefined) {
        outcome.appendChild(refusalLine('STALE_READ', STALE_MESSAGE));
        return;
      }

      if (row.bounds !== undefined) {
        const length = collectionLength(read.node, row.bounds.collection) ?? 0;
        if (row.bounds.index >= length) {
          outcome.appendChild(
            refusalLine(
              'STALE_READ',
              `${row.bounds.collection} now holds ${length} element(s), so ` +
                `'${row.path}' addresses nothing. Press Refresh.`,
            ),
          );
          return;
        }
      }

      // Re-diffed against whatever the read is anchored to NOW. A concurrent
      // writer who already set this field to the same value leaves nothing for
      // this op to do, and an op that changes nothing is still a line in the
      // host's audit trail claiming someone changed something.
      if (valueAtPath(read.node, row.path) === value.value) {
        outcome.appendChild(
          note(
            stale
              ? 'The page already holds that value — nothing was sent.'
              : 'Unchanged — nothing to commit.',
          ),
        );
        return;
      }

      if (carriesSentinel(value.value)) {
        outcome.appendChild(refusalLine('VALIDATOR_REJECT', SENTINEL_MESSAGE));
        return;
      }

      await propose(
        context,
        outcome,
        updateProp(context.node.id, row.path, value.value),
        `set ${row.path}`,
      );
    })();
  });

  line.appendChild(commit);
  section.appendChild(line);
  section.appendChild(outcome);
};

/** A row that cannot be edited, and the honest reason it cannot. */
const appendReadOnlyRow = (
  section: HTMLElement,
  label: string,
  reason: string,
  read: unknown,
): void => {
  const line = el('div', 'field');
  line.appendChild(el('span', 'field-name', label));
  if (read !== undefined) line.appendChild(el('span', 'field-value', displayValue(read)));
  line.appendChild(el('span', 'field-why', reason));
  section.appendChild(line);
};

/**
 * The reason a sentinel-valued field is not editable, named for what it stands
 * for rather than for the string it looks like.
 */
/**
 * The reason a row carries, for a control that may or may not be read-only.
 *
 * A bound slot's control is always `readonly` with the binding reason, because
 * that is what `fieldsFor` puts there. The fallback exists so this function is
 * total rather than because the other branch is reachable — an unreachable
 * `!` here would be a claim about `fieldsFor` enforced nowhere.
 */
const reasonOf = (control: Control): string =>
  control.kind === 'readonly'
    ? control.reason
    : 'currently bound — committing a literal here would discard the binding';

const sentinelReason = (value: unknown): string =>
  value === '<closure>'
    ? 'a host closure — the wire format cannot carry it, so it cannot be edited here'
    : 'an opaque host value — the wire format cannot carry it, so it cannot be edited here';

/**
 * The JSON value a control commits, or a message saying why it cannot.
 *
 * Numbers are checked here rather than left to the host: a rejected op costs a
 * round trip and reports as a validator refusal, which is the wrong story for
 * "that is not a number".
 */
export const valueOf = (
  control: Control,
  raw: string,
  checked: boolean,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string } => {
  switch (control.kind) {
    case 'toggle':
      return { ok: true, value: checked };
    case 'integer': {
      const parsed = Number(raw);
      return Number.isInteger(parsed)
        ? { ok: true, value: parsed }
        : { ok: false, error: `'${raw}' is not a whole number.` };
    }
    case 'number': {
      const parsed = Number(raw);
      return Number.isFinite(parsed)
        ? { ok: true, value: parsed }
        : { ok: false, error: `'${raw}' is not a number.` };
    }
    case 'choice':
      return control.options.includes(raw)
        ? { ok: true, value: raw }
        : { ok: false, error: `'${raw}' is not one of: ${control.options.join(', ')}.` };
    case 'text':
      return { ok: true, value: raw };
    case 'readonly':
      return { ok: false, error: control.reason };
  }
};

export const renderPropertyEditor = (context: EditContext): HTMLElement => {
  const section = el('section', 'section edit');
  section.appendChild(el('h2', 'section-title', 'properties'));

  if (!canApply(context)) {
    // Read-only degradation: the affordances are ABSENT, not disabled-looking.
    // A greyed-out editor invites a user to work out what is wrong with their
    // page; one honest line tells them.
    section.appendChild(note('This page offers no apply capability — inspection only.'));
    return section;
  }

  const derived = context.derived;
  if (derived === undefined) {
    section.appendChild(
      note('No wire schema is bundled with this build — fields cannot be derived.'),
    );
    return section;
  }

  const fields = fieldsFor(
    derived.schema,
    derived.kinds,
    context.node.kind,
    context.node.bindings.map((binding) => binding.slot),
  );
  if (fields.length === 0) {
    section.appendChild(
      note(`The bundled schema declares no kind '${context.node.kind}' — no fields derived.`),
    );
    return section;
  }

  const read = context.nodeJson;
  if (read === undefined)
    section.appendChild(
      note('Values are not readable over this relay profile; a field commits what you type.'),
    );

  for (const field of fields) appendPropertyRow(section, context, field, read);
  if (read !== undefined) appendIndexedRows(section, context, derived, read);

  return section;
};

/** One schema-derived top-level field, with the read's value where there is one. */
const appendPropertyRow = (
  section: HTMLElement,
  context: EditContext,
  field: Field,
  read: NodeJsonRead | undefined,
): void => {
  const value = read === undefined ? undefined : valueAtPath(read.node, field.path);

  // The BOUND guard first, because it is a fact about the SLOT rather than
  // about the value: a bound slot stays read-only whatever the read shows, and
  // the 737 rule that a literal must not silently replace a binding is
  // unchanged by being able to see what the binding resolves to.
  if (context.node.bindings.some((binding) => binding.slot === field.path)) {
    appendReadOnlyRow(section, field.path, reasonOf(field.control), value);
    return;
  }

  // §7.7 rule 2 next, and AHEAD of the schema's own reason on purpose. Both are
  // true of a `{ "const": "<closure>" }` field — it is fixed by the schema, and
  // it holds a closure — but only one of them explains anything: "fixed by the
  // schema" invites the reader to wonder what it is fixed to, and the sentinel
  // is the answer.
  if (isSentinel(value)) {
    appendReadOnlyRow(section, field.path, sentinelReason(value), value);
    return;
  }

  if (field.control.kind === 'readonly') {
    appendReadOnlyRow(section, field.path, field.control.reason, value);
    return;
  }

  appendRow(section, context, {
    path: field.path,
    label: field.path,
    control: field.control,
    read: value,
  });
};

/**
 * The per-element rows of every collection-valued field, at the LENGTH THE READ
 * REPORTS.
 *
 * A collection the read does not carry produces no rows at all — not an empty
 * header, and not a speculative row zero. The schema says the field exists; the
 * read says how many elements are there; an editor that offered `[0]` on the
 * strength of the schema alone would be addressing a position nothing put
 * anything in.
 */
const appendIndexedRows = (
  section: HTMLElement,
  context: EditContext,
  derived: DerivedSchema,
  read: NodeJsonRead,
): void => {
  for (const collection of collectionsFor(derived.schema, derived.kinds, context.node.kind)) {
    const length = collectionLength(read.node, collection.path);
    if (length === undefined || length === 0) continue;

    section.appendChild(el('h3', 'section-subtitle', `${collection.path} (${length})`));
    for (let index = 0; index < length; index += 1)
      for (const member of collection.members) {
        const path = `${collection.path}[${index}].${member.path}`;
        const value = valueAtPath(read.node, path);
        // Sentinel before the schema's own reason — see `appendPropertyRow`.
        if (isSentinel(value)) {
          appendReadOnlyRow(section, path, sentinelReason(value), value);
          continue;
        }
        if (member.control.kind === 'readonly') {
          appendReadOnlyRow(section, path, member.control.reason, value);
          continue;
        }
        appendRow(section, context, {
          path,
          label: path,
          control: member.control,
          read: value,
          bounds: { collection: collection.path, index },
        });
      }
  }
};

// ─── Style editor ───────────────────────────────────────────────────

/**
 * The per-node style block: every token this build knows, seeded from the block
 * the node carries, committed as ONE merged block.
 *
 * The section is present only when a read arrived. Not because the schema needs
 * it — the tokens are schema-derived and would render without one — but because
 * committing without the current block is precisely the silent whole-block
 * discard this surface was withheld to avoid, and a style editor that could
 * destroy four tokens to set a fifth is worse than none.
 */
export const renderStyleEditor = (context: EditContext): HTMLElement => {
  const section = el('section', 'section edit');
  section.appendChild(el('h2', 'section-title', 'style'));

  const read = context.nodeJson;
  const derived = context.derived;
  if (!canApply(context)) {
    section.appendChild(note('This page offers no apply capability — inspection only.'));
    return section;
  }
  if (read === undefined) {
    section.appendChild(
      note(
        'This page serves no read of a node’s wire JSON, so the current style block cannot be ' +
          'seen — and a style op replaces the whole block, so editing it blind would discard ' +
          'what is there.',
      ),
    );
    return section;
  }
  if (derived === undefined) {
    section.appendChild(
      note('No wire schema is bundled with this build — no style tokens derived.'),
    );
    return section;
  }

  const tokens = styleTokens(derived.schema);
  if (tokens.length === 0) {
    section.appendChild(note('The bundled schema declares no style block.'));
    return section;
  }

  const block = styleBlock(read.node);
  /**
   * Each token's control, WITH the display it was seeded with.
   *
   * The seed is what makes an untouched control contribute nothing, and that is
   * load-bearing rather than tidy: the merge below runs against the block as it
   * is at COMMIT time, which may hold tokens the seeding read did not. Without
   * the seed, a control that is empty because the stale block had no such token
   * would read as "clear this token" and delete one another writer had just
   * added — a whole-block discard by a narrower route than the one this surface
   * was withheld to avoid, and a harder one to see.
   */
  const controls = new Map<
    string,
    { readonly input: HTMLInputElement | HTMLSelectElement; readonly seeded: string }
  >();
  const outcome = el('div', 'field-outcome');

  for (const token of tokens) {
    const line = el('div', 'field');
    line.appendChild(el('span', 'field-name', token.wireName));
    const held = block[token.wireName];
    if (token.control.kind === 'readonly') {
      line.appendChild(el('span', 'field-value', displayValue(held)));
      line.appendChild(el('span', 'field-why', token.control.reason));
      section.appendChild(line);
      continue;
    }
    const input = controlFor(token.wireName, token.control, held);
    controls.set(token.wireName, { input, seeded: displayOf(input) });
    line.appendChild(input);
    section.appendChild(line);
  }

  // A token this build's schema does not declare still shows, read-only, so the
  // block the commit will carry forward is visible rather than merely promised.
  for (const [name, value] of Object.entries(block))
    if (!tokens.some((token) => token.wireName === name))
      appendReadOnlyRow(section, name, 'not a token this build knows — preserved unchanged', value);

  const commit = el('button', 'field-commit', 'Set style');
  commit.type = 'button';
  commit.addEventListener('click', () => {
    outcome.replaceChildren();
    void (async () => {
      const anchored = await anchoredRead(context);
      if (anchored.read === undefined) {
        outcome.appendChild(refusalLine('STALE_READ', STALE_MESSAGE));
        return;
      }

      // MERGED OVER THE BLOCK AS IT IS NOW, never rebuilt from the controls.
      // That is what makes a one-token edit preserve the rest by construction,
      // and it is also what makes the stale path correct: the changes are
      // re-applied over the FRESH block, so a token another writer just added
      // survives an edit to a different token.
      const current = styleBlock(anchored.read.node);
      const changes: Record<string, unknown> = {};
      for (const [name, { input, seeded }] of controls) {
        // Untouched contributes nothing — see the `controls` note above.
        if (displayOf(input) === seeded) continue;
        const control = tokens.find((token) => token.wireName === name)?.control;
        if (control === undefined || control.kind === 'readonly') continue;
        const raw = input.value;
        // An emptied control CLEARS the token. `valueOf` would reject '' against
        // a choice, which is the wrong reading here: the empty option is how
        // this editor spells "no such token", not an invalid case.
        if (control.kind !== 'toggle' && raw === '') {
          if (name in current) changes[name] = undefined;
          continue;
        }
        const value = valueOf(control, raw, input instanceof HTMLInputElement && input.checked);
        if (!value.ok) {
          outcome.appendChild(refusalLine('VALIDATOR_REJECT', `${name}: ${value.error}`));
          return;
        }
        if (current[name] !== value.value) changes[name] = value.value;
      }

      if (Object.keys(changes).length === 0) {
        outcome.appendChild(note('Unchanged — nothing to commit.'));
        return;
      }

      const merged = mergeStyle(current, changes);
      if (carriesSentinel(merged)) {
        outcome.appendChild(refusalLine('VALIDATOR_REJECT', SENTINEL_MESSAGE));
        return;
      }
      await propose(context, outcome, updateStyle(context.node.id, merged), 'set style');
    })();
  });
  section.appendChild(commit);
  section.appendChild(outcome);

  return section;
};

// ─── Structural edits ───────────────────────────────────────────────

const PLACEMENTS: readonly {
  readonly label: string;
  readonly of: (anchor: string) => Placement;
}[] = [
  { label: 'before this node', of: (anchor) => ({ at: 'before', anchor }) },
  { label: 'after this node', of: (anchor) => ({ at: 'after', anchor }) },
  { label: 'last child of this node', of: () => ({ at: 'last' }) },
];

/**
 * The kinds offerable at a target, and why the gate is where it is.
 *
 * The contract has NO dry-run at any minor: `apply` applies. So a candidate cannot be tried
 * before it is offered, and the palette is OPTIMISTIC by necessity — it offers
 * what it can construct and what the schema does not rule out, and lets the
 * host's own gate have the last word.
 *
 * The two local gates are the ones that can be decided from what the panel
 * already holds, and both remove offers rather than adding them: a kind whose
 * requirements cannot be synthesised is not offerable at all, and a parent the
 * schema says holds no children cannot take one. Neither substitutes for the
 * host's validator — they just stop the palette from offering things that are
 * knowably impossible, which is the part of "offer-gating" that survives the
 * absence of a dry-run.
 */
export const offerableKinds = (
  derived: DerivedSchema,
  taken: ReadonlySet<string>,
  parentKind: string,
): readonly string[] => {
  const holdsChildren = acceptsChildren(derived.kinds, parentKind);
  // `undefined` — an unfamiliar parent kind — proceeds. Hiding the palette on
  // ignorance would make an unknown page look uneditable rather than unknown.
  if (holdsChildren === false) return [];
  return [...derived.kinds.keys()].filter(
    (discriminator) =>
      synthesiseNode(derived.schema, derived.kinds, taken, discriminator) !== undefined,
  );
};

export const renderStructural = (context: EditContext): HTMLElement => {
  const section = el('section', 'section edit');
  section.appendChild(el('h2', 'section-title', 'structure'));

  const tree = context.tree;
  if (!canApply(context) || tree === undefined) {
    if (canApply(context)) section.appendChild(note('No tree loaded.'));
    else section.appendChild(note('This page offers no apply capability — inspection only.'));
    return section;
  }

  const nodeId = context.node.id;
  const parent = parentOf(tree, nodeId);
  const outcome = el('div', 'field-outcome');

  // ── insert ──
  const derived = context.derived;
  if (derived === undefined) {
    section.appendChild(note('No wire schema is bundled — nothing can be synthesised to insert.'));
  } else {
    const insertRow = el('div', 'field');
    const placement = el('select', 'field-input');
    placement.setAttribute('aria-label', 'Placement');
    PLACEMENTS.forEach((entry, index) => {
      const option = el('option', undefined, entry.label);
      option.value = String(index);
      placement.appendChild(option);
    });

    const kindSelect = el('select', 'field-input');
    kindSelect.setAttribute('aria-label', 'Kind to insert');

    const fillKinds = (): void => {
      kindSelect.replaceChildren();
      const chosen = PLACEMENTS[Number(placement.value)] ?? PLACEMENTS[0]!;
      // `last` inserts INTO this node; before/after insert into its parent, so
      // the parent kind that gates the offer differs by placement.
      const targetKind =
        chosen.of(nodeId).at === 'last' ? context.node.kind : (parent?.kind ?? context.node.kind);
      const kinds = offerableKinds(derived, allNodeIds(tree), targetKind);
      if (kinds.length === 0) {
        const option = el('option', undefined, 'nothing can be inserted here');
        option.value = '';
        kindSelect.appendChild(option);
        return;
      }
      for (const kind of kinds) {
        const option = el('option', undefined, kind);
        option.value = kind;
        kindSelect.appendChild(option);
      }
    };
    fillKinds();
    placement.addEventListener('change', fillKinds);

    const insert = el('button', 'field-commit', 'Insert');
    insert.type = 'button';
    insert.addEventListener('click', () => {
      const chosen = PLACEMENTS[Number(placement.value)] ?? PLACEMENTS[0]!;
      const where = chosen.of(nodeId);
      const discriminator = kindSelect.value;
      outcome.replaceChildren();
      if (discriminator === '') return;

      const parentId = where.at === 'last' ? nodeId : parent?.id;
      if (parentId === undefined) {
        outcome.appendChild(
          refusalLine('VALIDATOR_REJECT', 'The root has no parent to insert beside.'),
        );
        return;
      }
      const child = synthesiseNode(derived.schema, derived.kinds, allNodeIds(tree), discriminator);
      if (child === undefined) {
        outcome.appendChild(
          refusalLine('VALIDATOR_REJECT', `No minimal '${discriminator}' can be synthesised.`),
        );
        return;
      }
      const siblings = where.at === 'last' ? context.node.childIds : siblingIds(tree, nodeId);
      void propose(
        context,
        outcome,
        insertOp(siblings, { parentId, placement: where }, child),
        `insert a ${discriminator}`,
      );
    });

    insertRow.appendChild(placement);
    insertRow.appendChild(kindSelect);
    insertRow.appendChild(insert);
    section.appendChild(insertRow);
  }

  // ── reorder ──
  const order = el('div', 'field');
  order.appendChild(el('span', 'field-name', 'order'));
  for (const [label, delta] of [
    ['Move up', -1],
    ['Move down', 1],
  ] as const) {
    const button = el('button', 'field-commit', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      outcome.replaceChildren();
      const siblings = siblingIds(tree, nodeId);
      const op = parent === undefined ? undefined : nudgeOp(parent.id, siblings, nodeId, delta);
      if (op === undefined) {
        outcome.appendChild(
          refusalLine(
            'VALIDATOR_REJECT',
            parent === undefined
              ? 'The root has no siblings to move among.'
              : `Already the ${delta < 0 ? 'first' : 'last'} of its siblings.`,
          ),
        );
        return;
      }
      void propose(context, outcome, op, `reorder ${nodeId}`);
    });
    order.appendChild(button);
  }
  section.appendChild(order);

  // ── move (pick up here, place there) ──
  const move = el('div', 'field');
  move.appendChild(el('span', 'field-name', 'move'));
  if (context.held === undefined) {
    const hold = el('button', 'field-commit', 'Pick up');
    hold.type = 'button';
    hold.addEventListener('click', () => context.setHeld(nodeId));
    move.appendChild(hold);
  } else if (context.held === nodeId) {
    move.appendChild(el('span', 'field-why', 'held — select where it should go'));
    const drop = el('button', 'field-commit', 'Put down');
    drop.type = 'button';
    drop.addEventListener('click', () => context.setHeld(undefined));
    move.appendChild(drop);
  } else {
    const held = context.held;
    for (const entry of PLACEMENTS) {
      const button = el('button', 'field-commit', `Place ${entry.label}`);
      button.type = 'button';
      button.addEventListener('click', () => {
        outcome.replaceChildren();
        const where = entry.of(nodeId);
        const parentId = where.at === 'last' ? nodeId : parent?.id;
        if (parentId === undefined) {
          outcome.appendChild(refusalLine('VALIDATOR_REJECT', 'The root has no parent.'));
          return;
        }
        // A node cannot move into itself or into its own subtree. Checked here
        // because the answer is knowable from the tree the panel holds, and a
        // round trip to be told so is a round trip wasted.
        if (held === parentId || descendsFrom(tree, held, parentId)) {
          outcome.appendChild(
            refusalLine(
              'VALIDATOR_REJECT',
              'A node cannot move into itself or into something inside it.',
            ),
          );
          return;
        }
        const siblings = where.at === 'last' ? context.node.childIds : siblingIds(tree, nodeId);
        context.setHeld(undefined);
        void propose(
          context,
          outcome,
          moveOp(siblings, { parentId, placement: where }, held),
          `move ${held}`,
        );
      });
      move.appendChild(button);
    }
  }
  section.appendChild(move);

  // ── remove ──
  const remove = el('div', 'field');
  remove.appendChild(el('span', 'field-name', 'remove'));
  const removeButton = el('button', 'field-commit danger', 'Remove');
  removeButton.type = 'button';
  let armed = false;
  removeButton.addEventListener('click', () => {
    outcome.replaceChildren();
    // Two presses, in the panel, rather than a native confirm dialog: a modal
    // steals focus from the page being inspected, and the arming state is
    // visible where the consequence is.
    if (!armed) {
      armed = true;
      removeButton.textContent = 'Remove — press again';
      return;
    }
    armed = false;
    removeButton.textContent = 'Remove';
    void propose(context, outcome, removeNode(nodeId), `remove ${nodeId}`);
  });
  remove.appendChild(removeButton);
  section.appendChild(remove);

  section.appendChild(outcome);
  return section;
};

/** Whether `candidate` is inside `ancestor`'s subtree. */
export const descendsFrom = (tree: TreeSnapshot, ancestor: string, candidate: string): boolean => {
  const find = (node: TreeSnapshot): TreeSnapshot | undefined => {
    if (node.id === ancestor) return node;
    for (const child of node.children) {
      const found = find(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const subtree = find(tree);
  if (subtree === undefined) return false;
  const contains = (node: TreeSnapshot): boolean =>
    node.id === candidate || node.children.some(contains);
  return subtree.children.some(contains);
};
