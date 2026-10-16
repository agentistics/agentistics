import { expect, test } from 'bun:test';
import { harnessesTool } from './harnesses-tool.js';

test('availability is attached to every usage row without hiding unavailable usage', () => {
  const rows = [{ harness: 'codex', sessions: 4, totalTokens: 1000 }, { harness: 'claude', sessions: 2, totalTokens: 500 }];
  expect(harnessesTool(rows, { harnesses: {
    codex: { spawnable: false, unavailableReason: 'codex failed to start: update codex' },
    claude: { spawnable: true },
  } })).toEqual([
    { ...rows[0], spawnable: false, unavailableReason: 'codex failed to start: update codex' },
    { ...rows[1], spawnable: true },
  ]);
  expect(rows[0]).not.toHaveProperty('spawnable');
});

test('servers without host startup health preserve usage rows', () => {
  const rows = [{ harness: 'codex', totalTokens: 1000 }];
  expect(harnessesTool(rows, {})).toEqual(rows);
});
