// ============================================================================
//  inspect/detect — is this a Fuaran-rendered page, and which node is this
//  element?
//
//  A Fuaran renderer stamps every rendered node's element with
//  `data-fuaran-node-id`. That marker is what makes click-to-select possible:
//  it is the only place the DOM projection carries the typed tree's identity.
//
//  It is deliberately NOT used as the relay's detection signal. The relay
//  contract is explicit (DEVTOOLS_RELAY §6.1): a client detects a peer by
//  sending `hello` and seeing what comes back, and a DOM marker "MUST NOT be
//  relied on for detection" — its presence says nothing about whether a debug
//  surface is exposed, which is the only question that matters. The marker is
//  used here as exactly what §6.1 permits it to be: a heuristic hint about
//  where to look, and the trigger for injecting the page peer at all.
// ============================================================================

/** The attribute a Fuaran renderer stamps on every rendered node's element. */
export const NODE_ID_ATTRIBUTE = 'data-fuaran-node-id';

const SELECTOR = `[${NODE_ID_ATTRIBUTE}]`;

/** Does this document carry Fuaran-rendered markup? */
export const hasFuaranMarkup = (doc: Pick<Document, 'querySelector'>): boolean =>
  doc.querySelector(SELECTOR) !== null;

/** How many elements the renderer marked — a cheap signal for the panel. */
export const markedElementCount = (doc: Pick<Document, 'querySelectorAll'>): number =>
  doc.querySelectorAll(SELECTOR).length;

/**
 * The node ids the renderer marked, in document order, each appearing once.
 *
 * `querySelectorAll` is already document-ordered, so the order is the page's
 * own rather than an ordering invented here. Duplicates are collapsed because a
 * node id identifies a node, and a renderer that stamped two elements with one
 * id has produced one node the panel should offer once — an inspector's list is
 * not the place to surface that, and offering the same id twice would make
 * selection ambiguous for no gain.
 *
 * This is the §6.1-permitted use of the marker — a hint about where to look —
 * and it is the only enumeration available on a page whose tree is upstream.
 */
export const markedNodeIds = (doc: Pick<Document, 'querySelectorAll'>): readonly string[] => {
  const seen = new Set<string>();
  for (const element of Array.from(doc.querySelectorAll(SELECTOR))) {
    const id = element.getAttribute(NODE_ID_ATTRIBUTE);
    if (id !== null && id !== '') seen.add(id);
  }
  return [...seen];
};

/**
 * The node id owning `element` — the nearest marked ancestor-or-self. A click
 * usually lands on an inner, unmarked element (a `<span>` inside a marked
 * `<div>`), so the walk up is what makes click-to-select land on a real node
 * rather than on nothing.
 */
export const nodeIdForElement = (element: Element | null): string | undefined => {
  const marked = element?.closest(SELECTOR) ?? null;
  return marked?.getAttribute(NODE_ID_ATTRIBUTE) ?? undefined;
};

/** The rendered element for a node id, if it is currently mounted. */
export const elementForNodeId = (
  doc: Pick<Document, 'querySelector'>,
  nodeId: string,
): Element | null => doc.querySelector(`[${NODE_ID_ATTRIBUTE}="${escapeAttributeValue(nodeId)}"]`);

/**
 * Escape a node id for use inside an attribute selector. `CSS.escape` is the
 * correct tool and is present in every browser this extension targets; the
 * fallback exists so the function stays usable under a bare test DOM.
 */
export const escapeAttributeValue = (value: string): string =>
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
