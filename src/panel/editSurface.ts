// ============================================================================
//  panel/editSurface — the write half of the panel: properties and structure.
//
//  Two surfaces, one discipline. Both derive what they offer from the wire
//  schema rather than from a table of kinds written here; both propose ops
//  through the page's own gated apply path; both render a refusal exactly where
//  the action was, by class, and change nothing on refusal.
//
//  ── What the panel can and cannot know ─────────────────────────────────────
//
//  `relay@1.0` has no read that returns a node's property VALUES. Its reads
//  answer what is in the tree structurally — kind, bound slots, child ids,
//  geometry — and one slot's resolved value at a time. So the property editor
//  is a SET surface, not a read-modify-write one: each field commits the value
//  typed into it, and no field claims to show what is there now.
//
//  That is stated in the UI rather than papered over. A blank box implying
//  "currently empty" would be a lie about a field that may well hold something,
//  and the difference matters the moment someone clears a field they could not
//  see. (The honest fix is a host-side read of the node's own wire JSON, which
//  is a relay profile change and not this panel's to make unilaterally.)
//
//  ── Why there is no style editor here ──────────────────────────────────────
//
//  The style op replaces a node's WHOLE style block; there is no per-token
//  path. With no read of the current block, committing one token would silently
//  discard every other token the node carries. An edit that destroys what it
//  cannot see is not an edit worth offering, so the surface is absent and says
//  why, rather than present and dangerous.
// ============================================================================

import type { NodeSnapshot, TreeSnapshot } from '../relay/protocol.js';
import type { ApplyResult } from '../bridge.js';
import {
  insertOp,
  moveOp,
  nudgeOp,
  removeNode,
  updateProp,
  type Placement,
  type TreeOpJson,
} from '../edit/ops.js';
import { acceptsChildren, fieldsFor, type Control, type Field } from '../schema/wireSchema.js';
import { synthesiseNode } from '../schema/synthesise.js';
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
  /** The node currently picked up for a move, if any. */
  readonly held: string | undefined;
  /** Propose one op. Resolves with the outcome; never throws for a refusal. */
  commit(op: TreeOpJson, reason: string): Promise<ApplyResult>;
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

const controlFor = (
  field: Field,
  control: Exclude<Control, { kind: 'readonly' }>,
): HTMLInputElement | HTMLSelectElement => {
  if (control.kind === 'choice') {
    const select = el('select', 'field-input');
    // A deliberately empty first option: with no read of the current value,
    // preselecting the schema's first case would make every choice field look
    // as though the node already held it.
    select.appendChild(el('option', undefined, '—'));
    for (const option of control.options) {
      const item = el('option', undefined, option);
      item.value = option;
      select.appendChild(item);
    }
    select.setAttribute('aria-label', field.path);
    return select;
  }
  const input = el('input', 'field-input');
  input.type = control.kind === 'toggle' ? 'checkbox' : 'text';
  if (control.kind === 'integer' || control.kind === 'number') input.inputMode = 'decimal';
  input.setAttribute('aria-label', field.path);
  return input;
};

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

  section.appendChild(
    note('Values are not readable over this relay profile; a field commits what you type.'),
  );

  for (const field of fields) {
    const row = el('div', 'field');
    row.appendChild(el('span', 'field-name', field.path));

    if (field.control.kind === 'readonly') {
      row.appendChild(el('span', 'field-why', field.control.reason));
      section.appendChild(row);
      continue;
    }

    const control = field.control;
    const input = controlFor(field, control);
    row.appendChild(input);

    const commit = el('button', 'field-commit', 'Set');
    commit.type = 'button';
    const outcome = el('div', 'field-outcome');

    commit.addEventListener('click', () => {
      const raw = input instanceof HTMLInputElement ? input.value : input.value;
      const checked = input instanceof HTMLInputElement ? input.checked : false;
      const value = valueOf(control, raw, checked);
      outcome.replaceChildren();
      if (!value.ok) {
        outcome.appendChild(refusalLine('VALIDATOR_REJECT', value.error));
        return;
      }
      void propose(
        context,
        outcome,
        updateProp(context.node.id, field.path, value.value),
        `set ${field.path}`,
      );
    });

    row.appendChild(commit);
    section.appendChild(row);
    section.appendChild(outcome);
  }

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
 * `relay@1.0` has NO dry-run: `apply` applies. So a candidate cannot be tried
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
