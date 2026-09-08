// ============================================================================
//  test/support/shape — the corpus comparison rule.
//
//  DEVTOOLS_RELAY §12.3 is explicit about how a runner reads these fixtures:
//
//    "Runners MUST compare SHAPES and ENUMERATED VALUES, not bytes:
//     treeRevision values, geometry numbers, resolved binding values and
//     message strings are environment-specific and will legitimately differ.
//     Fixture payloads use representative values for these; a runner asserting
//     byte-equality on them is testing the fixture author's choices, not the
//     implementation."
//
//  So this module walks the fixture payload and asserts, for every field the
//  fixture declares, that the actual value is present with the same JSON type —
//  plus strict equality on the fields that carry a CLOSED SET or an echoed
//  identifier, which is where the real protocol content lives.
// ============================================================================

/**
 * Leaf keys whose value is a closed-set token, an echoed request field, or an
 * identifier the implementation does not get to choose. Everything else is
 * compared by JSON type only.
 *
 * Two fields that LOOK like they belong here and do not, because both are the
 * responding peer's own identity rather than protocol content the fixture gets
 * to pin. Both were in this set, and both would fail every peer that ever
 * advances a minor — which is the exact opposite of what a backward-
 * compatibility corpus is for:
 *
 *  * `$relay` is "the SENDER's relay profile id" (§4). A fixture written at
 *    `relay@1.0` and answered by a `relay@1.2` peer carries two different ids
 *    by construction, and both are right. It is checked in the runner against
 *    the PEER's own id instead — a stricter assertion, not a weaker one, since
 *    "matches the fixture" would pass a peer that echoed the request's id back
 *    while "matches my own" catches it.
 *  * `detail.supported` on a `FOREIGN_PROFILE` refusal is likewise this peer's
 *    own list. Its TYPE is contractual; its contents are the implementation.
 *
 * `profile` stays, and the distinction is the point: §6.3 makes it a function
 * of the fixture's own `accepts`, so a peer at any minor owes the same answer.
 */
const ENUMERATED_KEYS = new Set([
  'dir',
  'type',
  'id',
  'class',
  'requestType',
  'profile',
  'status',
  'source',
  'reason',
  'capability',
  'path',
  'received',
  'cause',
  'event',
  'capabilities',
  // §6.5's closed two-value set, since `relay@1.4`. It belongs here for the
  // same reason `capabilities` does: it is protocol content the fixture gets to
  // pin, not the responding peer's own identity.
  'treeSource',
  'slot',
  'kind',
  'nodeId',
  'expression',
  'subscriptionId',
  'applied',
]);

const jsonType = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface ShapeMismatch {
  readonly path: string;
  readonly reason: string;
}

/**
 * Compare `actual` against the fixture's `expected`. Returns every mismatch
 * rather than the first, so a failing fixture reports the whole story.
 */
export const shapeMismatches = (
  expected: unknown,
  actual: unknown,
  path = '$',
  key = '',
): ShapeMismatch[] => {
  const expectedType = jsonType(expected);
  const actualType = jsonType(actual);

  if (expectedType !== actualType)
    return [{ path, reason: `expected JSON type '${expectedType}', got '${actualType}'` }];

  if (expectedType === 'array') {
    const expectedArray = expected as unknown[];
    const actualArray = actual as unknown[];
    // POSITIONAL, for the declared length only. Comparing every actual element
    // against the fixture's first would be wrong on a heterogeneous array — a
    // `read.tree` `children` list holds a Metric beside a DataGrid, and a
    // template rule would reject the fixture's own second element. Elements
    // beyond what the fixture declares are unconstrained: the fixture states
    // what MUST be there, not what may not.
    if (actualArray.length < expectedArray.length)
      return [
        {
          path,
          reason: `expected at least ${expectedArray.length} element(s), got ${actualArray.length}`,
        },
      ];
    return expectedArray.flatMap((entry, index) =>
      shapeMismatches(entry, actualArray[index], `${path}[${index}]`, key),
    );
  }

  if (expectedType === 'object') {
    const expectedObject = expected as Record<string, unknown>;
    if (!isObject(actual)) return [{ path, reason: 'expected an object' }];
    const out: ShapeMismatch[] = [];
    for (const [childKey, childExpected] of Object.entries(expectedObject)) {
      if (!(childKey in actual)) {
        out.push({
          path: `${path}.${childKey}`,
          reason: 'field declared by the fixture is absent',
        });
        continue;
      }
      out.push(
        ...shapeMismatches(childExpected, actual[childKey], `${path}.${childKey}`, childKey),
      );
    }
    return out;
  }

  if (ENUMERATED_KEYS.has(key) && expected !== actual)
    return [{ path, reason: `expected '${String(expected)}', got '${String(actual)}'` }];

  return [];
};

export const describeMismatches = (mismatches: readonly ShapeMismatch[]): string =>
  mismatches.map((mismatch) => `  ${mismatch.path}: ${mismatch.reason}`).join('\n');
