// ============================================================================
//  The "copy repro" action — reading, verifying and copying a board snapshot.
//
//  The record below is the one the reference host's own capture produced for
//  its law board (seven orders, the `region` chip on `emea`), copied byte for
//  byte, with its hash. Re-canonicalising it here and landing on the same hash
//  is what makes this a reader of the same format rather than a plausible one.
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  BOARD_SNAPSHOT_HASH_ATTRIBUTE,
  BOARD_SNAPSHOT_MEDIA_TYPE,
  PUBLISHED_RECORDS_EXPRESSION,
  asPublishedRecords,
  recordProblem,
  reproFrom,
} from '../src/repro/boardSnapshot.js';
import { copyRepro } from '../src/panel/repro.js';
import type { Capture, WireRead } from '../src/trail/capture.js';

const RECORD =
  '{"board":"fuaran-board-snapshot@1","locale":"en-GB","now":"2026-10-28T09:14:00Z","parameters":[{"channel":"filter","form":"scalar","key":"region","value":"emea"}],"sources":[{"channel":"state","form":"wire","head":"af90baaa00d27332fac6dd9dd760518e36d98329a5ae43c00b6fe2bd51fc0e6b","key":"orders","length":7,"stream":"orders"}],"tree":"sha256:6880807c00024dea8f7514f61d0914cb96ce896d2f5d83ef5637a2d42fa56936"}';
const HASH = 'sha256:bc3d269535ef4debb9927be20abe10d8ca798857b6f2981c96ef292902ad2bce';
const TREE_HEX = '6880807c00024dea8f7514f61d0914cb96ce896d2f5d83ef5637a2d42fa56936';

const NO_TREE: Capture = { ok: false, why: 'not-offered', reason: 'no read' };
const treeAt = (hash: string): Capture => ({ ok: true, node: {}, json: '{}', hash });

describe('reproFrom', () => {
  it('reproduces the reference host’s hash over the same record', async () => {
    const repro = await reproFrom([{ attribute: HASH, text: RECORD }], treeAt(TREE_HEX));
    expect(repro).toEqual({ ok: true, text: RECORD, hash: HASH, treeChecked: true });
  });

  it('canonicalises a record published with its members out of order', async () => {
    const shuffled = JSON.stringify(
      Object.fromEntries(Object.entries(JSON.parse(RECORD)).reverse()),
    );
    expect(shuffled).not.toBe(RECORD);
    const repro = await reproFrom([{ attribute: HASH, text: shuffled }], NO_TREE);
    expect(repro).toEqual({ ok: true, text: RECORD, hash: HASH, treeChecked: false });
  });

  it('refuses a record whose hash is not the published one', async () => {
    const edited = RECORD.replace('"emea"', '"amer"');
    const repro = await reproFrom([{ attribute: HASH, text: edited }], NO_TREE);
    expect(repro.ok).toBe(false);
    if (!repro.ok) expect(repro.reason).toContain('edited or half-updated');
  });

  it('refuses a record for a tree the page no longer shows', async () => {
    const repro = await reproFrom([{ attribute: HASH, text: RECORD }], treeAt('0'.repeat(64)));
    expect(repro.ok).toBe(false);
    if (!repro.ok) expect(repro.reason).toContain('stale');
  });

  it('refuses no record, two records and an empty record', async () => {
    for (const published of [
      [],
      [
        { attribute: HASH, text: RECORD },
        { attribute: HASH, text: RECORD },
      ],
      [{ attribute: HASH, text: null }],
      [{ attribute: HASH, text: '{' }],
    ]) {
      const repro = await reproFrom(published, NO_TREE);
      expect(repro.ok).toBe(false);
    }
  });
});

describe('recordProblem', () => {
  const record = (): Record<string, unknown> => JSON.parse(RECORD) as Record<string, unknown>;

  it('accepts the reference record', () => {
    expect(recordProblem(record())).toBeUndefined();
  });

  it('refuses what the reference reader refuses, and an unknown member', () => {
    const cases: [string, (r: Record<string, unknown>) => void][] = [
      ['format', (r) => (r['board'] = 'fuaran-board-snapshot@2')],
      ['missing', (r) => delete r['now']],
      ['unknown', (r) => (r['note'] = 'x')],
      [
        'channel',
        (r) => ((r['parameters'] as Record<string, unknown>[])[0]!['channel'] = 'cookie'),
      ],
      ['form', (r) => ((r['sources'] as Record<string, unknown>[])[0]!['form'] = 'int')],
      ['length', (r) => ((r['sources'] as Record<string, unknown>[])[0]!['length'] = -1)],
    ];
    for (const [name, mutate] of cases) {
      const r = record();
      mutate(r);
      expect(recordProblem(r), name).toBeDefined();
    }
  });
});

describe('the published element', () => {
  it('is found by the page expression and narrowed', () => {
    document.body.innerHTML = `<script type="${BOARD_SNAPSHOT_MEDIA_TYPE}" ${BOARD_SNAPSHOT_HASH_ATTRIBUTE}="${HASH}">${RECORD}</script><script type="text/javascript">1</script>`;
    // eslint-disable-next-line no-eval
    const found = asPublishedRecords((0, eval)(PUBLISHED_RECORDS_EXPRESSION));
    expect(found).toEqual([{ attribute: HASH, text: RECORD }]);
    expect(asPublishedRecords('not an array')).toEqual([]);
  });
});

describe('copyRepro', () => {
  const root: WireRead = { ok: false, why: 'not-offered' };

  it('copies the canonical record and says the tree went unchecked', async () => {
    let copied = '';
    const report = await copyRepro({
      readPublished: async () => [{ attribute: HASH, text: RECORD }],
      readRoot: async () => root,
      copy: async (text) => {
        copied = text;
        return true;
      },
    });
    expect(copied).toBe(RECORD);
    expect(report.copied).toBe(true);
    expect(report.message).toContain(HASH);
    expect(report.message).toContain('unchecked');
  });

  it('copies nothing when the record is refused, and says why', async () => {
    let calls = 0;
    const report = await copyRepro({
      readPublished: async () => [],
      readRoot: async () => root,
      copy: async () => {
        calls += 1;
        return true;
      },
    });
    expect(calls).toBe(0);
    expect(report).toMatchObject({ copied: false });
    expect(report.message).toContain('publishes no board snapshot');
  });

  it('reports a refused clipboard write rather than claiming a copy', async () => {
    const report = await copyRepro({
      readPublished: async () => [{ attribute: HASH, text: RECORD }],
      readRoot: async () => root,
      copy: async () => false,
    });
    expect(report.copied).toBe(false);
  });
});
