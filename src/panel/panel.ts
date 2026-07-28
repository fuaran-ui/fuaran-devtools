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

import type { BindingValue, NodeSnapshot, RenderedDom, TreeSnapshot } from '../relay/protocol.js';
import type { StatusResult } from '../bridge.js';
import { PanelConnection } from './connection.js';
import { ancestorIds, breadcrumb, countNodes, findNode, flattenTree } from './treeModel.js';

const connection = new PanelConnection(chrome.devtools.inspectedWindow.tabId);

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const byId = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`panel.html is missing #${id}`);
  return node;
};

const statusBar = byId('status');
const treePane = byId('tree');
const crumbBar = byId('breadcrumb');
const cardPane = byId('card');
const refreshButton = byId('refresh') as HTMLButtonElement;
const pickButton = byId('pick') as HTMLButtonElement;

// ─── State ──────────────────────────────────────────────────────────

let tree: TreeSnapshot | undefined;
let selected: string | undefined;
let capabilities: readonly string[] = [];
let picking = false;
const collapsed = new Set<string>();

// ─── Status ─────────────────────────────────────────────────────────

const STATE_TEXT: Record<StatusResult['state'], string> = {
  'no-fuaran': 'No Fuaran markup on this page.',
  // The distinction §6.1 draws, and the reason it is worth drawing: this one
  // is fixable by the developer in seconds, and reporting it as "nothing here"
  // would send them looking for a problem that is not there.
  'no-surface': 'Fuaran page — no debug surface exposed.',
  'no-peer': 'Fuaran page — the in-page relay did not answer.',
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

const definition = (term: string, value: string): HTMLElement => {
  const row = el('div', 'kv');
  row.appendChild(el('span', 'k', term));
  row.appendChild(el('span', 'v', value));
  return row;
};

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

// ─── Selection ──────────────────────────────────────────────────────

const select = async (nodeId: string): Promise<void> => {
  selected = nodeId;
  if (tree !== undefined) for (const id of ancestorIds(tree, nodeId)) collapsed.delete(id);
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
    pickButton.disabled = status.state !== 'connected';

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
          : status.state === 'no-peer'
            ? emptyState(
                'No answer from the page',
                'Fuaran markup is present but the in-page relay did not respond.',
                'Reload the page — the extension injects its relay at page load.',
              )
            : emptyState(
                'Not a Fuaran page',
                'Nothing on this page carries a Fuaran rendered-node marker.',
              ),
      );
      return;
    }

    if (!capabilities.includes('read.tree')) {
      cardPane.replaceChildren(
        emptyState('read.tree not offered', 'This page exposes no whole-tree read.'),
      );
      return;
    }

    tree = await connection.request<TreeSnapshot>('readTree');
    renderTree();
    if (selected !== undefined && findNode(tree, selected) !== undefined) await select(selected);
    else {
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
  }
});

// A navigation replaces the page and its injected relay, so the panel re-probes
// rather than showing a tree that no longer exists.
chrome.devtools.network.onNavigated.addListener(() => {
  tree = undefined;
  selected = undefined;
  void refresh();
});

void refresh();
