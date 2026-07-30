// The harness's window.__fuaran — the same shape as the extension's own
// end-to-end test host (test/support/liveHost.ts), ported to plain JS, plus
// two things the screenshot wants that the test host stubs: real bindings on
// some nodes, and geometry read from the actual rendered elements.
(() => {
  const node = (id, type, props = {}, children = []) => ({
    id,
    kind: { $type: type, ...props },
    children,
  });

  let tree = node('app', 'Box', {}, [
    node('title', 'Heading', { level: 1, text: 'Quarterly review' }),
    node('subtitle', 'Text', { text: 'Q2 2026 · refreshed a moment ago' }),
    node('metrics', 'Box', {}, [
      node('metric-revenue', 'Metric', { label: 'Revenue' }),
      node('metric-users', 'Metric', { label: 'Active users' }),
      node('metric-latency', 'Metric', { label: 'P95 latency' }),
    ]),
    node('detail', 'Box', {}, [
      node('detail-title', 'Heading', { level: 2, text: 'Where the quarter moved' }),
      node('detail-copy', 'Text', {}),
      node('detail-actions', 'Box', {}, [
        node('refresh-btn', 'Button', { label: 'Refresh figures' }),
        node('export-btn', 'Button', { label: 'Export' }),
      ]),
    ]),
  ]);

  const BINDINGS = {
    'metric-revenue': [{ slot: 'Value', expression: '$metrics.revenue.total', source: 'State' }],
    'metric-users': [{ slot: 'Value', expression: '$metrics.users.active', source: 'State' }],
    'metric-latency': [{ slot: 'Value', expression: '$metrics.latency.p95', source: 'State' }],
    'detail-copy': [{ slot: 'Text', expression: '$narrative.quarterSummary', source: 'State' }],
  };
  const RESOLVED = {
    'metric-revenue': '£48,200',
    'metric-users': 1904,
    'metric-latency': '212 ms',
    'detail-copy': 'Revenue growth held through the pricing change, and the latency work landed…',
  };

  const clone = (t) => JSON.parse(JSON.stringify(t));
  const find = (t, id) => {
    if (t.id === id) return t;
    for (const c of t.children) {
      const f = find(c, id);
      if (f !== undefined) return f;
    }
    return undefined;
  };
  const parentOf = (t, id) => {
    for (const c of t.children) {
      if (c.id === id) return t;
      const f = parentOf(c, id);
      if (f !== undefined) return f;
    }
    return undefined;
  };
  const ids = (t) => [t.id, ...t.children.flatMap(ids)];
  const wireName = (p) => (p.length === 0 ? p : p[0].toLowerCase() + p.slice(1));

  const applyTo = (t, op) => {
    switch (op.$type) {
      case 'Batch': {
        if (!Array.isArray(op.ops))
          return { code: 'BATCH-SHAPE', message: 'Batch needs an ops array.' };
        for (const inner of op.ops) {
          const failure = applyTo(t, inner);
          if (failure !== undefined) return failure;
        }
        return undefined;
      }
      case 'UpdateProp': {
        const target = find(t, String(op.target));
        if (target === undefined)
          return { code: 'NODE-MISSING', message: `No node '${op.target}'.` };
        const key = wireName(String(op.path));
        if (!(key in target.kind))
          return {
            code: 'FUARAN-APPLY-UNKNOWN-PATH',
            message: `'${op.path}' is not a field of ${target.kind.$type}.`,
          };
        target.kind[key] = op.value;
        return undefined;
      }
      case 'InsertChild': {
        const parent = find(t, String(op.parentId));
        if (parent === undefined)
          return { code: 'NODE-MISSING', message: `No node '${op.parentId}'.` };
        const child = op.child;
        if (child === undefined || typeof child.id !== 'string')
          return { code: 'CHILD-SHAPE', message: 'InsertChild needs a child node.' };
        if (ids(t).includes(child.id))
          return { code: 'FUARAN-APPLY-DUPLICATE-ID', message: `Duplicate node id '${child.id}'.` };
        parent.children.push({ id: child.id, kind: child.kind, children: child.children ?? [] });
        return undefined;
      }
      case 'RemoveNode': {
        const target = String(op.target);
        if (target === t.id)
          return { code: 'FUARAN-APPLY-ROOT-REMOVAL', message: 'The root cannot be removed.' };
        const parent = parentOf(t, target);
        if (parent === undefined) return { code: 'NODE-MISSING', message: `No node '${target}'.` };
        parent.children = parent.children.filter((c) => c.id !== target);
        return undefined;
      }
      case 'MoveNode': {
        const target = String(op.target);
        const moved = find(t, target);
        const parent = parentOf(t, target);
        const destination = find(t, String(op.newParentId));
        if (moved === undefined || parent === undefined || destination === undefined)
          return { code: 'NODE-MISSING', message: 'Move endpoints must both exist.' };
        if (find(moved, destination.id) !== undefined)
          return { code: 'FUARAN-APPLY-CYCLE', message: 'A node cannot move inside itself.' };
        parent.children = parent.children.filter((c) => c.id !== target);
        destination.children.push(moved);
        return undefined;
      }
      case 'ReorderChildren': {
        const parent = find(t, String(op.parentId));
        if (parent === undefined)
          return { code: 'NODE-MISSING', message: `No node '${op.parentId}'.` };
        const wanted = op.newOrder ?? [];
        const present = parent.children.map((c) => c.id);
        if (wanted.length !== present.length || !wanted.every((id) => present.includes(id)))
          return {
            code: 'FUARAN-APPLY-PARTIAL-ORDER',
            message: 'A reorder must name every sibling exactly once.',
          };
        parent.children = wanted.map((id) => parent.children.find((c) => c.id === id));
        return undefined;
      }
      default:
        return { code: 'UNKNOWN_DU_CASE', message: `Unknown TreeOp case '${op.$type}'.` };
    }
  };

  const KNOWN = new Set([
    'Batch',
    'UpdateProp',
    'InsertChild',
    'RemoveNode',
    'MoveNode',
    'ReorderChildren',
  ]);

  let revision = 3;
  const listeners = new Set();

  // A real host re-renders on apply; this harness's render projection is the
  // static markup, so text-bearing prop updates are mirrored into it.
  const renderTextProps = (op) => {
    if (op.$type === 'Batch') {
      (op.ops ?? []).forEach(renderTextProps);
      return;
    }
    if (op.$type !== 'UpdateProp') return;
    const key = wireName(String(op.path));
    if (key !== 'text' && key !== 'label') return;
    const el = document.querySelector(`[data-fuaran-node-id="${CSS.escape(String(op.target))}"]`);
    if (el !== null) el.textContent = String(op.value);
  };

  const commit = (next, cause, op) => {
    tree = next;
    revision += 1;
    if (op !== undefined) renderTextProps(op);
    const change = { treeRevision: `r-${revision}`, cause };
    for (const listener of listeners) listener(change);
  };

  const project = (live) => ({
    id: live.id,
    kind: String(live.kind.$type),
    bindings: BINDINGS[live.id] ?? [],
    childIds: live.children.map((c) => c.id),
    children: live.children.map(project),
  });

  window.__fuaran = {
    version: '0.6.0',
    canApply: true,
    treeRevision: () => `r-${revision}`,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    inspectTree: () => project(tree),
    getNodeState: (id) => {
      const found = find(tree, id);
      return found === undefined
        ? { error: `Node '${id}' not found in tree.` }
        : {
            id: found.id,
            kind: String(found.kind.$type),
            bindings: BINDINGS[found.id] ?? [],
            childIds: found.children.map((c) => c.id),
          };
    },
    getBindingValue: (nodeId, slot) => {
      const declared = (BINDINGS[nodeId] ?? []).find((b) => b.slot === slot);
      if (declared === undefined) return { error: `No binding '${slot}' on node '${nodeId}'.` };
      return {
        status: 'resolved',
        value: RESOLVED[nodeId],
        expression: declared.expression,
        source: declared.source,
      };
    },
    getRenderedDom: (id) => {
      const el = document.querySelector(`[data-fuaran-node-id="${CSS.escape(id)}"]`);
      if (el === null) return { error: `No rendered element for node '${id}'.` };
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
        overflowing: false,
        hidden: r.width === 0 && r.height === 0,
      };
    },
    findNodes: (kind) => ids(tree).filter((id) => find(tree, id)?.kind.$type === kind),
    apply: (op) => {
      if (!KNOWN.has(String(op?.$type)))
        return {
          ok: false,
          status: 'decodeFailed',
          error: `Unknown TreeOp case '${String(op?.$type)}'.`,
          decodeError: { Code: 'UNKNOWN_DU_CASE', Path: '$.$type', Message: 'Unknown case.' },
        };
      const candidate = clone(tree);
      const failure = applyTo(candidate, op);
      if (failure !== undefined)
        return { ok: false, status: 'rejected', error: failure.message, code: failure.code };
      commit(candidate, 'apply', op);
      return { ok: true, status: 'applied', treeRevision: `r-${revision}` };
    },
  };
})();
