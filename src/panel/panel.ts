// ============================================================================
//  panel/panel — the DevTools panel UI.
//
//  Plain DOM, no framework: an inspector should not ship a runtime larger than
//  the thing it inspects, and the whole surface is one tree list plus one
//  detail card.
//
//  EVERY string this panel renders comes from the inspected page — node ids,
//  kinds, binding expressions, resolved values, refusal messages. A DevTools
//  panel is a privileged extension context, so injecting page-controlled
//  strings into it is the classic extension escalation path (DEVTOOLS_RELAY
//  §11.5). This file therefore uses `textContent` throughout and never
//  `innerHTML`; the one structural exception is the static empty-state markup
//  built from element constructors, which contains no page data at all.
// ============================================================================

import type {
  BindingValue,
  NodeJsonRead,
  NodeSnapshot,
  RenderedDom,
  TreeSnapshot,
} from '../relay/protocol.js';
import type { ApplyResult, StatusResult } from '../bridge.js';
import type { TreeOpJson } from '../edit/ops.js';
import { PanelConnection } from './connection.js';
import {
  ancestorIds,
  breadcrumb,
  countNodes,
  findNode,
  flattenTree,
  pathTo,
  reresolve,
} from './treeModel.js';
import { definition, el } from './dom.js';
import {
  renderPropertyEditor,
  renderStructural,
  renderStyleEditor,
  type EditContext,
} from './editSurface.js';
import { loadWireSchema, WIRE_SCHEMA_FILE, type DerivedSchema } from './schemaSource.js';
import { downloadDocument, renderHistory } from './history.js';
import { Trail } from '../trail/recorder.js';
import type { WireRead } from '../trail/capture.js';
import { TRAIL_FILENAME } from '../trail/sessionLog.js';
import { Dispatch, DEVTOOLS_ACTOR } from '../dispatch/dispatch.js';
import { DEFAULT_ACTOR_CLASS, type ActorClass } from '../relay/protocol.js';

const connection = new PanelConnection(chrome.devtools.inspectedWindow.tabId);

const byId = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`panel.html is missing #${id}`);
  return node;
};

const statusBar = byId('status');
const treePane = byId('tree');
const crumbBar = byId('breadcrumb');
const cardPane = byId('card');
const historyBar = byId('history');
const refreshButton = byId('refresh') as HTMLButtonElement;
const pickButton = byId('pick') as HTMLButtonElement;

// ─── State ──────────────────────────────────────────────────────────

let tree: TreeSnapshot | undefined;
let selected: string | undefined;
/**
 * The selection as a ROOT→NODE PATH OF IDS, not an index and not a captured
 * node. This is what survives an external mutation: when the tree is re-read,
 * the deepest surviving id on the path is re-selected and its position
 * recomputed. An index would still resolve after a concurrent insert — to the
 * wrong node, silently, and the next edit would land there.
 */
let selectedPath: readonly string[] = [];
let capabilities: readonly string[] = [];
/**
 * Where the connected peer says its tree lives (DEVTOOLS_RELAY §6.5).
 *
 * `'page'` until a handshake says otherwise, which is the wire's own default
 * and what every peer before `relay@1.4` meant. The panel branches on it in
 * exactly one place — `refresh` — because §6.4 is unchanged: `capabilities` is
 * still what decides what may be asked for. What this decides is what the panel
 * SHOWS when the tree reads are absent, which is a presentation question the
 * capability list cannot answer: "not offered" and "not here" look identical
 * through it, and only one of them has a reason worth telling.
 */
let treeSource = 'page';
let picking = false;
/** The node picked up for a move, if any. */
let held: string | undefined;
/** The bundled wire schema, once loaded. `undefined` is a degraded mode. */
let derived: DerivedSchema | undefined;
/** The last revision the page reported, so a `changed` echo is not re-read twice. */
let lastRevision: string | undefined;
/**
 * The focused node's own wire JSON (§7.7), read on focus and held per focus.
 *
 * Cleared on every selection change BEFORE the read is issued, so a slow read
 * can never leave the previous node's values sitting under the new node's
 * fields. The editor treats its absence as the set-only mode, which is exactly
 * the right thing to show for the moment before the read lands as well as for a
 * page that will never serve one.
 */
let nodeJson: NodeJsonRead | undefined;
const collapsed = new Set<string>();
/**
 * Read one node's canonical wire JSON FOR THE RECORDING.
 *
 * Distinct from the editor's `readNodeJson` below, which collapses every
 * failure into `undefined` because the editor's answer to all of them is the
 * same degraded mode. The recording needs the distinction: "this page serves no
 * `read.nodeJson`" and "the page refused" are different things to tell someone
 * whose undo will not run, and one of them names a fix.
 */
const readForTrail = async (nodeId: string): Promise<WireRead> => {
  if (!capabilities.includes('read.nodeJson')) return { ok: false, why: 'not-offered' };
  try {
    const read = await connection.request<NodeJsonRead>('readNodeJson', { nodeId });
    return { ok: true, node: read.node };
  } catch {
    return { ok: false, why: 'refused' };
  }
};

/**
 * The attributed record of what this session has applied to this page.
 *
 * One per panel, reset on navigation: a trail carried across a navigation would
 * address node ids belonging to a different tree.
 */
const trail = new Trail(undefined, readForTrail);

// ─── Status ─────────────────────────────────────────────────────────

const STATE_TEXT: Record<StatusResult['state'], string> = {
  'no-fuaran': 'No Fuaran markup on this page.',
  // The distinction §6.1 draws, and the reason it is worth drawing: this one
  // is fixable by the developer in seconds, and reporting it as "nothing here"
  // would send them looking for a problem that is not there.
  'no-surface': 'Fuaran page — no debug surface exposed.',
  'no-peer': 'Fuaran page — the in-page relay did not answer.',
  'relay-blocked': 'Fuaran page — the page blocks the inspector relay.',
  connected: 'Connected.',
};

const renderStatus = (status: StatusResult): void => {
  statusBar.replaceChildren();
  statusBar.dataset['state'] = status.state;

  statusBar.appendChild(el('span', 'dot'));
  statusBar.appendChild(el('span', 'state', STATE_TEXT[status.state]));

  if (status.state === 'connected') {
    const detail = [
      status.host,
      status.hostVersion === undefined ? undefined : `v${status.hostVersion}`,
      status.profile,
      // §6.5: shown only when the peer declared something other than the
      // default, so a page-tree peer's status line is unchanged — the same
      // reasoning that keeps the field off its handshake.
      status.treeSource === undefined || status.treeSource === 'page'
        ? undefined
        : `tree ${status.treeSource}`,
      `surface ${status.surfaceVersion ?? 'unknown'}`,
      `rev ${status.treeRevision ?? '—'}`,
    ]
      .filter((part): part is string => part !== undefined)
      .join(' · ');
    statusBar.appendChild(el('span', 'detail', detail));
  } else if (status.message !== undefined) {
    statusBar.appendChild(el('span', 'detail', status.message));
  }

  if (status.state !== 'no-fuaran' && status.markedElements > 0)
    statusBar.appendChild(
      el('span', 'detail', `${status.markedElements} rendered element(s) marked`),
    );
};

const emptyState = (title: string, ...lines: string[]): HTMLElement => {
  const box = el('div', 'empty');
  box.appendChild(el('p', 'empty-title', title));
  for (const line of lines) box.appendChild(el('p', 'empty-line', line));
  return box;
};

// ─── Tree view ──────────────────────────────────────────────────────

const renderTree = (): void => {
  treePane.replaceChildren();
  if (tree === undefined) {
    treePane.appendChild(
      emptyState(
        'No tree loaded',
        'Open a page rendered by a Fuaran host running in debug mode, then press Refresh.',
      ),
    );
    return;
  }

  const list = el('div', 'rows');
  for (const row of flattenTree(tree, collapsed)) {
    const item = el('div', 'row');
    item.dataset['nodeId'] = row.id;
    if (row.id === selected) item.classList.add('selected');
    item.style.paddingLeft = `${8 + row.depth * 14}px`;

    const twisty = el('span', 'twisty', row.hasChildren ? (row.collapsed ? '▸' : '▾') : '');
    if (row.hasChildren)
      twisty.addEventListener('click', (event) => {
        event.stopPropagation();
        if (collapsed.has(row.id)) collapsed.delete(row.id);
        else collapsed.add(row.id);
        renderTree();
      });
    item.appendChild(twisty);

    item.appendChild(el('span', 'kind', row.kind));
    item.appendChild(el('span', 'id', row.id));
    if (row.bindingCount > 0) item.appendChild(el('span', 'badge', String(row.bindingCount)));

    item.addEventListener('click', () => void select(row.id));
    // Hovering a row highlights it in the page — the other half of the
    // bidirectional link the picker provides from the page side.
    item.addEventListener('mouseenter', () => {
      void connection
        .request('highlight', { nodeId: row.id, kind: row.kind })
        .catch(() => undefined);
    });
    list.appendChild(item);
  }
  treePane.appendChild(list);

  const footer = el('div', 'tree-footer', `${countNodes(tree)} node(s)`);
  treePane.appendChild(footer);
};

treePane.addEventListener('mouseleave', () => {
  if (picking) return;
  void connection.request('unhighlight').catch(() => undefined);
});

// ─── Breadcrumb ─────────────────────────────────────────────────────

const renderBreadcrumb = (): void => {
  crumbBar.replaceChildren();
  if (tree === undefined || selected === undefined) return;
  const path = breadcrumb(tree, selected);
  path.forEach((node, index) => {
    if (index > 0) crumbBar.appendChild(el('span', 'crumb-sep', '›'));
    const crumb = el('button', 'crumb', `${node.kind}#${node.id}`);
    crumb.addEventListener('click', () => void select(node.id));
    crumbBar.appendChild(crumb);
  });
};

// ─── Node card ──────────────────────────────────────────────────────

/** Render one binding's resolution, keeping the five §7.3 statuses distinct. */
const bindingValueText = (value: BindingValue): string => {
  switch (value.status) {
    case 'resolved':
      return typeof value.value === 'string'
        ? value.value
        : (JSON.stringify(value.value) ?? 'null');
    case 'notResolved':
      return '(not resolved yet)';
    case 'errored':
      return `error: ${value.message ?? 'resolution failed'}`;
    case 'i18nUnresolved':
      return `(no translation for '${value.key ?? ''}')`;
    case 'noOverride':
      return '(no value set)';
    default:
      // §10.3: an unrecognised status is the generic case, never a crash.
      return `(${value.status})`;
  }
};

const renderCard = (node: NodeSnapshot): void => {
  cardPane.replaceChildren();

  const head = el('div', 'card-head');
  head.appendChild(el('span', 'card-kind', node.kind));
  head.appendChild(el('span', 'card-id', node.id));
  cardPane.appendChild(head);

  cardPane.appendChild(definition('children', String(node.childIds.length)));

  const bindings = el('section', 'section');
  bindings.appendChild(el('h2', 'section-title', `bindings (${node.bindings.length})`));
  if (node.bindings.length === 0) {
    bindings.appendChild(el('p', 'muted', 'This node binds no slots.'));
  } else {
    for (const binding of node.bindings) {
      const row = el('div', 'binding');
      row.appendChild(el('span', 'slot', binding.slot));
      row.appendChild(el('span', 'source', binding.source));
      row.appendChild(el('code', 'expression', binding.expression));
      const value = el('span', 'value muted', '…');
      value.dataset['slot'] = binding.slot;
      row.appendChild(value);
      bindings.appendChild(row);
    }
  }
  cardPane.appendChild(bindings);

  const geometry = el('section', 'section');
  geometry.id = 'geometry';
  geometry.appendChild(el('h2', 'section-title', 'rendered'));
  geometry.appendChild(el('p', 'muted', '…'));
  cardPane.appendChild(geometry);

  const context = editContext(node);
  cardPane.appendChild(renderPropertyEditor(context));
  cardPane.appendChild(renderStyleEditor(context));
  cardPane.appendChild(renderStructural(context));
};

/**
 * Read the focused node's wire JSON, or `undefined` when this page does not
 * serve it.
 *
 * A refused or timed-out read is `undefined` too, and deliberately not
 * distinguished here: both mean the editor has no anchor, and the editor's
 * degraded mode is the honest answer to either. What must not happen is a
 * FAILED read leaving a previous node's payload in place — which is why the
 * caller clears before it asks, not after it answers.
 */
const readNodeJson = async (nodeId: string): Promise<NodeJsonRead | undefined> => {
  if (!capabilities.includes('read.nodeJson')) return undefined;
  try {
    return await connection.request<NodeJsonRead>('readNodeJson', { nodeId });
  } catch {
    return undefined;
  }
};

/**
 * The write surfaces' view of the panel. Assembled per render so the surfaces
 * hold no state of their own: everything they act on — tree, capabilities,
 * held node — is read from here at the moment they are built, which is what
 * keeps them consistent with a tree that may have just been re-read.
 */
/**
 * Propose one op to the page. The single route to the relay's apply, so the
 * revision bookkeeping — and therefore the "was that change ours?" test the
 * trail's external-change posture rests on — has exactly one home.
 */
const applyThroughRelay = async (
  op: TreeOpJson,
  reason: string,
  actorClass: ActorClass = DEFAULT_ACTOR_CLASS,
): Promise<ApplyResult> => {
  const result = await connection.request<ApplyResult>('apply', { op, reason, actorClass });
  // The post-op revision is recorded here so the `changed` event this very
  // edit causes is recognised as its own echo. Otherwise every edit re-reads
  // the tree twice: once because the panel knows it changed it, and again
  // when the page says so.
  if (result.ok) lastRevision = result.treeRevision;
  return result;
};

/**
 * The panel's write route, and the ONLY one.
 *
 * `Dispatch` owns the propose-then-record-on-confirmation rule, so the panel's
 * own edits and a program's dispatches are the same call with a different
 * actor — which is what makes "an agent's op goes through the identical path"
 * a structural fact rather than a claim two code paths currently honour.
 */
const dispatch = new Dispatch(
  { apply: (op, reason, actorClass) => applyThroughRelay(op, reason, actorClass) },
  trail,
);

const editContext = (node: NodeSnapshot): EditContext => ({
  capabilities,
  derived,
  tree,
  node,
  nodeJson,
  held,
  // The panel's own view of where the page is, which is the OTHER half of the
  // staleness comparison: the read carries the revision it was taken at, and
  // this is the newest revision anything has reported since. `lastRevision` is
  // updated by an applied op and by every `changed` event, so the two differ
  // exactly when the tree moved after the read.
  revision: () => lastRevision,
  reread: async () => {
    const fresh = await readNodeJson(node.id);
    // Adopted as the held read on success only. A failed re-read must leave the
    // stale one in place rather than clearing it: the editor's rows are already
    // rendered from it, and blanking them would present "we do not know" as
    // "the field is empty" — the exact confusion this read exists to end.
    if (fresh !== undefined) nodeJson = fresh;
    return fresh;
  },
  // A person at this panel's keyboard. Recorded only on a CONFIRMED apply — a
  // refused op left the tree unchanged (§8.3), so putting it in the trail would
  // state that it did something — and that rule now lives in `Dispatch`.
  commit: (op: TreeOpJson, reason: string) => dispatch.submit(DEVTOOLS_ACTOR, op, reason),
  reload: () => void refresh(),
  setHeld: (nodeId) => {
    held = nodeId;
    if (selected !== undefined) void select(selected);
  },
});

// ─── Recording ──────────────────────────────────────────────────────

/**
 * Write the document out.
 *
 * Asynchronous because the final tree is read AT EXPORT — one read, at the one
 * moment the document is assembled, rather than after each confirmed op where a
 * missed call site would emit a final tree the recorded ops do not build.
 */
const exportTrail = async (): Promise<void> => {
  downloadDocument(TRAIL_FILENAME, await trail.exportDocument());
};

const renderHistoryBar = (): void => {
  historyBar.replaceChildren(
    renderHistory({
      view: trail.view(),
      canApply: capabilities.includes('apply'),
      undo: () => void undoLast(),
      redo: () => void redoNext(),
      exportTrail: () => void exportTrail(),
      reset: () => {
        trail.reset();
        if (tree !== undefined) trail.observeTree(tree, lastRevision);
        renderHistoryBar();
      },
    }),
  );
};

/**
 * Undo by COMPENSATING OP through the page's own apply path.
 *
 * The cursor moves only after the host confirms it. A refusal leaves the record
 * exactly as it was and reports where the action was, because an undo the page
 * declined is not an undo.
 */
const undoLast = async (): Promise<void> => {
  const inverse = trail.undoOp();
  if (inverse === undefined || !inverse.ok) {
    renderHistoryBar();
    return;
  }
  const result = await applyThroughRelay(inverse.op, 'undo');
  if (result.ok) {
    trail.confirmUndo(result.treeRevision);
    await refresh();
    return;
  }
  historyBar.appendChild(
    el('span', 'history-why', `Undo refused — ${result.class}: ${result.message}`),
  );
};

const redoNext = async (): Promise<void> => {
  const op = trail.redoOp();
  if (op === undefined) {
    renderHistoryBar();
    return;
  }
  const result = await applyThroughRelay(op, 'redo');
  if (result.ok) {
    trail.confirmRedo(result.treeRevision);
    await refresh();
    return;
  }
  historyBar.appendChild(
    el('span', 'history-why', `Redo refused — ${result.class}: ${result.message}`),
  );
};

const fillBindingValues = async (node: NodeSnapshot): Promise<void> => {
  if (!capabilities.includes('read.bindingValue')) {
    for (const slot of cardPane.querySelectorAll<HTMLElement>('.value'))
      slot.textContent = '(read.bindingValue not offered)';
    return;
  }
  for (const binding of node.bindings) {
    const cell = cardPane.querySelector<HTMLElement>(
      `.value[data-slot="${CSS.escape(binding.slot)}"]`,
    );
    if (cell === null) continue;
    try {
      const value = await connection.request<BindingValue>('readBindingValue', {
        nodeId: node.id,
        slot: binding.slot,
      });
      cell.textContent = bindingValueText(value);
      cell.classList.toggle('muted', value.status !== 'resolved');
    } catch (error) {
      cell.textContent = error instanceof Error ? error.message : String(error);
      cell.classList.add('muted');
    }
  }
};

const fillGeometry = async (nodeId: string): Promise<void> => {
  const section = document.getElementById('geometry');
  if (section === null) return;
  section.replaceChildren(el('h2', 'section-title', 'rendered'));
  if (!capabilities.includes('read.renderedDom')) {
    section.appendChild(el('p', 'muted', 'read.renderedDom not offered by this page.'));
    return;
  }
  try {
    const dom = await connection.request<RenderedDom>('readRenderedDom', { nodeId });
    section.appendChild(
      definition(
        'box',
        `${round(dom.x)}, ${round(dom.y)} · ${round(dom.width)} × ${round(dom.height)}`,
      ),
    );
    section.appendChild(definition('overflowing', String(dom.overflowing)));
    section.appendChild(definition('hidden', String(dom.hidden)));
  } catch (error) {
    section.appendChild(el('p', 'muted', error instanceof Error ? error.message : String(error)));
  }
};

const round = (value: number): string => (Math.round(value * 10) / 10).toString();

// ─── A page whose tree is upstream (§6.5) ───────────────────────────
//
// The panel's ordinary view is built on `read.tree`, and a peer that declares
// `treeSource: "upstream"` does not offer it — not because the host chose to
// withhold it, but because the tree is on the other side of a channel that has
// no way yet to carry a question and match an answer to it.
//
// The wrong thing to show for that is the same "read.tree not offered" empty
// state a narrow page-tree host gets: it is true and it is useless, because it
// names no reason and suggests no end. The right thing is what §6.5 makes
// sayable — this page's tree is elsewhere, here is what CAN be read, and here
// is each thing that cannot with the refusal class you would actually get.

/**
 * The entry points an upstream-tree peer does not offer today, each with the
 * class it answers with (§6.4, §9.3) and why.
 *
 * Named rather than hidden, deliberately. A capability list is a fact about one
 * peer at one moment, and a panel that simply omits what is missing teaches a
 * reader that this contract has no such entry point — which is exactly the
 * confusion §10.1 draws `CAPABILITY_ABSENT` and `UNKNOWN_MESSAGE` apart to
 * prevent. The type exists; this peer does not offer it yet.
 */
const UPSTREAM_PENDING: readonly { readonly capability: string; readonly why: string }[] = [
  { capability: 'read.tree', why: 'the structural snapshot is held by the upstream host' },
  { capability: 'read.nodeState', why: "a node's kind, bindings and children come from the tree" },
  {
    capability: 'read.bindingValue',
    why: 'slot resolution runs where the tree and its sources are',
  },
  { capability: 'read.findNodes', why: 'a kind search is a question about the tree' },
  {
    capability: 'read.nodeJson',
    why: "only the upstream host's own encoder may produce this (§7.7)",
  },
  { capability: 'apply', why: 'the edit is decoded, validated and policy-checked upstream (§8.1)' },
  { capability: 'subscribe', why: 'a change subscription is a subscription to the tree' },
];

/** The one node-level read an upstream-tree peer can genuinely serve (§7.4). */
const upstreamDetail = async (nodeId: string): Promise<void> => {
  cardPane.replaceChildren();

  const head = el('div', 'card-head');
  head.appendChild(el('span', 'card-kind', 'rendered element'));
  head.appendChild(el('span', 'card-id', nodeId));
  cardPane.appendChild(head);

  const geometry = el('section', 'section');
  geometry.id = 'geometry';
  geometry.appendChild(el('h2', 'section-title', 'rendered'));
  geometry.appendChild(el('p', 'muted', '…'));
  cardPane.appendChild(geometry);

  const absent = el('section', 'section');
  absent.appendChild(el('h2', 'section-title', 'not available on this page'));
  for (const entry of UPSTREAM_PENDING) {
    if (capabilities.includes(entry.capability)) continue;
    absent.appendChild(definition(entry.capability, `CAPABILITY_ABSENT — ${entry.why}`));
  }
  absent.appendChild(
    el(
      'p',
      'muted',
      'These are absent because this peer holds no tree, not because the entry points do not ' +
        'exist. It advertises what it can serve, and the set grows when its channel can carry a ' +
        'question and match an answer to it.',
    ),
  );
  cardPane.appendChild(absent);

  await fillGeometry(nodeId);
};

/**
 * The tree pane for an upstream-tree page: the elements the renderer MARKED, in
 * document order, from the DOM rather than from any tree.
 *
 * Presented as what it is and never as a tree — no kinds, no bindings, no
 * nesting, and a footer that says so. §6.1 permits the marker as "a heuristic
 * hint about where to look", which is precisely this use of it, and the honest
 * framing matters more here than anywhere else in the panel: a flat list that
 * LOOKED like a tree view would be a reconstruction the reader could not tell
 * from the real one, which is the same defect §6.5 rule 2 forbids on the wire.
 */
const showUpstreamPage = async (): Promise<void> => {
  treePane.replaceChildren();
  let nodeIds: readonly string[] = [];
  try {
    const listed = await connection.request<{ readonly nodeIds: readonly string[] }>(
      'listRendered',
    );
    nodeIds = listed.nodeIds;
  } catch {
    // The content script is the one thing between the panel and the page here;
    // if it did not answer there is nothing to list and nothing to guess.
    nodeIds = [];
  }

  if (nodeIds.length === 0) {
    treePane.appendChild(
      emptyState(
        'No marked elements',
        'This page declares its tree is upstream, and nothing in its DOM carries a rendered-node marker yet.',
      ),
    );
    cardPane.replaceChildren(
      emptyState(
        'Tree is upstream',
        'The session tree for this page lives on the server; the browser holds a renderer applying pushed patches.',
      ),
    );
    return;
  }

  const list = el('div', 'rows');
  for (const nodeId of nodeIds) {
    const item = el('div', 'row');
    item.dataset['nodeId'] = nodeId;
    item.style.paddingLeft = '8px';
    item.appendChild(el('span', 'twisty', ''));
    item.appendChild(el('span', 'id', nodeId));
    item.addEventListener('click', () => {
      selected = nodeId;
      for (const row of Array.from(list.children)) row.classList.toggle('selected', row === item);
      void upstreamDetail(nodeId);
    });
    item.addEventListener('mouseenter', () => {
      void connection.request('highlight', { nodeId }).catch(() => undefined);
    });
    list.appendChild(item);
  }
  treePane.appendChild(list);
  treePane.appendChild(
    el('div', 'tree-footer', `${nodeIds.length} marked element(s) — DOM order, not a tree`),
  );

  cardPane.replaceChildren(
    emptyState(
      'Tree is upstream',
      'The session tree lives on the server; this page holds a renderer applying pushed patches, so the tree reads are not offered here.',
      'Select a marked element to read its live geometry through read.renderedDom.',
    ),
  );
};

// ─── Selection ──────────────────────────────────────────────────────

const select = async (nodeId: string): Promise<void> => {
  selected = nodeId;
  // Cleared BEFORE anything is drawn. A read held from the previous selection
  // describes a different node, and rendering this node's fields from it would
  // show one node's values under another node's names — the single worst thing
  // a read-modify-write editor can do, since the user would then commit them.
  nodeJson = undefined;
  if (tree !== undefined) {
    // Remembered as a path, so a concurrent mutation that removes this node
    // still leaves a trail back to the nearest surviving ancestor.
    selectedPath = pathTo(tree, nodeId) ?? [nodeId];
    for (const id of ancestorIds(tree, nodeId)) collapsed.delete(id);
  }
  renderTree();
  renderBreadcrumb();

  const local = tree === undefined ? undefined : findNode(tree, nodeId);
  if (local !== undefined) renderCard(local);

  void connection.request('highlight', { nodeId, kind: local?.kind }).catch(() => undefined);

  // The card is drawn from the cached tree first so selection feels immediate,
  // then refreshed from a live `read.nodeState` — the tree snapshot can be a
  // few seconds old, and the card is the surface a developer trusts.
  try {
    const fresh = await connection.request<NodeSnapshot>('readNodeState', { nodeId });
    // The wire-JSON read is taken BEFORE the card is rendered, not after, so the
    // editor is read-modify-write from its first paint rather than becoming so a
    // beat later. A selection that changed while it was in flight is discarded:
    // the payload describes a node nobody is looking at any more.
    const json = await readNodeJson(nodeId);
    if (selected === nodeId) nodeJson = json;
    renderCard(fresh);
    await fillBindingValues(fresh);
    await fillGeometry(nodeId);
  } catch (error) {
    if (local === undefined)
      cardPane.replaceChildren(
        emptyState('Node unavailable', error instanceof Error ? error.message : String(error)),
      );
  }
};

// ─── Refresh + pick ─────────────────────────────────────────────────

const refresh = async (): Promise<void> => {
  refreshButton.disabled = true;
  try {
    const status = await connection.request<StatusResult>('status');
    renderStatus(status);
    capabilities = status.capabilities ?? [];
    treeSource = status.treeSource ?? 'page';
    pickButton.disabled = status.state !== 'connected';
    trail.noteIdentity({
      host: status.host ?? '',
      hostVersion: status.hostVersion ?? '',
      profile: status.profile ?? '',
    });
    renderHistoryBar();

    if (status.state !== 'connected') {
      tree = undefined;
      selected = undefined;
      crumbBar.replaceChildren();
      renderTree();
      cardPane.replaceChildren(
        status.state === 'no-surface'
          ? emptyState(
              'No debug surface',
              'This page renders Fuaran markup, but the host exposes no in-page debug surface.',
              'Run the app in a debug build (or enable its debug flag) and reload the page.',
            )
          : status.state === 'relay-blocked'
            ? emptyState(
                'Relay blocked by the page',
                "This page's Content-Security-Policy does not allow the extension's injected relay script, and no host-registered relay peer answered.",
                'A host can still make this page inspectable by registering its own relay peer in a debug build.',
              )
            : status.state === 'no-peer'
              ? emptyState(
                  'No answer from the page',
                  'Fuaran markup is present but the in-page relay did not respond.',
                  'Press Refresh to probe again.',
                )
              : emptyState(
                  'Not a Fuaran page',
                  'Nothing on this page carries a Fuaran rendered-node marker.',
                ),
      );
      return;
    }

    if (!capabilities.includes('read.tree')) {
      // §6.5. Two peers reach this line and they need different things said.
      // A page-tree peer that does not offer `read.tree` has chosen not to,
      // and "not offered" is the whole truth. An upstream-tree peer is not
      // withholding anything — its tree is on the far side of a channel — and
      // it has a real, narrower view to show instead.
      tree = undefined;
      selected = undefined;
      crumbBar.replaceChildren();
      if (treeSource === 'upstream') {
        await showUpstreamPage();
        return;
      }
      renderTree();
      cardPane.replaceChildren(
        emptyState('read.tree not offered', 'This page exposes no whole-tree read.'),
      );
      return;
    }

    // Established once per tab, and idempotent: without it the panel would
    // only ever show the tree as it was at the last button press, which is
    // exactly wrong on a page something else is also driving.
    if (capabilities.includes('subscribe'))
      await connection.request('watch').catch(() => undefined);

    tree = await connection.request<TreeSnapshot>('readTree');
    // The FIRST tree observed becomes the recording's base — the session began
    // when the panel could first see the page. Every later one is what the next
    // op will be composed against, and what the export records as the final
    // structure.
    trail.observeTree(tree, status.treeRevision ?? lastRevision);
    renderTree();
    renderHistoryBar();

    if (selected !== undefined && findNode(tree, selected) !== undefined) {
      await select(selected);
    } else if (selectedPath.length > 0) {
      // The selected node is gone — removed by this session or by another
      // writer. Re-resolve to the deepest surviving ancestor rather than
      // dropping the selection: the user's place in the tree is roughly where
      // it was, which is what they need after a removal.
      const resolved = reresolve(tree, selectedPath);
      const landing = resolved[resolved.length - 1];
      if (landing !== undefined) await select(landing);
    } else {
      selected = undefined;
      crumbBar.replaceChildren();
      cardPane.replaceChildren(emptyState('Select a node', 'Pick one in the tree, or use Select.'));
    }
  } catch (error) {
    renderStatus({
      state: 'no-peer',
      markedElements: 0,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    refreshButton.disabled = false;
  }
};

const setPicking = (active: boolean): void => {
  picking = active;
  pickButton.classList.toggle('active', active);
  pickButton.textContent = active ? 'Cancel' : 'Select';
};

pickButton.addEventListener('click', () => {
  if (picking) {
    setPicking(false);
    void connection.request('cancelPick').catch(() => undefined);
    return;
  }
  setPicking(true);
  void connection.request('startPick').catch(() => setPicking(false));
});

refreshButton.addEventListener('click', () => void refresh());

connection.onEvent((event) => {
  if (event.event === 'picked' && event.nodeId !== undefined) {
    setPicking(false);
    void select(event.nodeId);
  } else if (event.event === 'pickCancelled') {
    setPicking(false);
  } else if (event.event === 'changed') {
    // A change event is a STALENESS SIGNAL, not a change log: it says the tree
    // moved, never how. So the panel re-reads rather than trying to patch, and
    // the same handler serves an edit made here and an edit made by something
    // else driving the page — which is the point. The revision is compared,
    // never parsed: an event repeating a revision already seen (both peers on
    // a page emit one) costs nothing rather than a second full re-read.
    if (event.treeRevision !== undefined && event.treeRevision === lastRevision) return;
    // Past the echo test, so this change was NOT caused by this panel. The
    // trail sets its undo barrier here and drops the redo tail: undoing across
    // someone else's edit would revert work this session did not do, and
    // redoing an op composed before it would land it somewhere nobody chose.
    trail.externalChange(event.treeRevision);
    if (event.treeRevision !== undefined) lastRevision = event.treeRevision;
    void refresh();
  }
});

// A navigation replaces the page and its injected relay, so the panel re-probes
// rather than showing a tree that no longer exists. The selection PATH is
// dropped too: ids are per-tree, and re-resolving one against a different app's
// tree could land on an unrelated node that happens to share an id.
// The recording ends with the page. Node ids are per-tree, so a trail carried
// across a navigation would hold ops addressing nodes that no longer mean what
// they meant — and nothing is persisted, so an un-exported recording is gone.
// The panel says so beside the Export button rather than only here.
chrome.devtools.network.onNavigated.addListener(() => {
  tree = undefined;
  selected = undefined;
  selectedPath = [];
  held = undefined;
  lastRevision = undefined;
  nodeJson = undefined;
  trail.reset();
  renderHistoryBar();
  void refresh();
});

// The schema is loaded before the first probe so the editor is derived from the
// first render rather than appearing a beat later. A failure is a degraded
// mode, never a blocked panel — `refresh` runs either way.
void loadWireSchema(chrome.runtime.getURL(WIRE_SCHEMA_FILE))
  .then((loaded) => {
    derived = loaded;
  })
  .finally(() => void refresh());
