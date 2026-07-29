// ============================================================================
//  panel/dom — element construction, and the one rule that matters here.
//
//  EVERY string this panel renders comes from the inspected page: node ids,
//  kinds, binding expressions, resolved values, refusal messages. A DevTools
//  panel is a privileged extension context, so injecting page-controlled
//  strings into it is the classic extension escalation path (§11.5).
//
//  `el` takes text as TEXT and assigns it through `textContent`. There is no
//  markup parameter, and no module in this panel uses `innerHTML` — the
//  absence is the mechanism, so keep it absent.
// ============================================================================

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** A labelled key/value row. */
export const definition = (term: string, value: string): HTMLElement => {
  const row = el('div', 'kv');
  row.appendChild(el('span', 'k', term));
  row.appendChild(el('span', 'v', value));
  return row;
};

/** A one-line note carrying the honest reason something is not on offer. */
export const note = (text: string): HTMLElement => el('p', 'muted', text);
