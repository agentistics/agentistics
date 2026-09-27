#!/usr/bin/env bun
/**
 * scripts/parity-matrix.ts — runs every harness's differential over the CHECKED-IN FIXTURES ONLY
 * (P3 §5/§8.1, master §40) and writes the §40 parity matrix as `parity-matrix.json` +
 * `parity-matrix.md` to an output directory, printing a summary and exiting non-zero on any
 * `regression` row.
 *
 * ## Safety — this script NEVER reads a real machine's store
 *
 * Every `run<Harness>Differential` call below is handed an EXPLICIT directory built from
 * `packages/server/test/fixtures/**` or a throwaway `tmpdir()` root — never a bare call that would
 * fall back to `config.ts`'s per-harness defaults (`CLAUDE_DIR`, `CODEX_SESSIONS_DIR`, `GEMINI_DIR`,
 * `COPILOT_SESSION_STATE_DIR`, `KIMI_SESSIONS_DIR`/`session_index.jsonl`, `OPENCODE_DB_PATH`), which
 * resolve under the OWNER's real `$HOME` on their machine. Two of those defaults live one level
 * deeper than the top-level option (`runKimiDifferential`'s `indexFile`, `runOpencodeDifferential`'s
 * `dbPath`) and are therefore *also* passed explicitly here, not merely the directory the harness
 * itself is obviously keyed on.
 *
 * On top of that: (1) every server module is imported DYNAMICALLY, after `$HOME` and every
 * `<HARNESS>_DIR` env var are pointed at a throwaway directory, so even a FUTURE hidden default in
 * `config.ts` resolves under the safe root rather than the real one; and (2) `assertSafe` refuses
 * outright — before any directory is even opened — if a path this script is about to hand to a
 * differential resolves under one of the OWNER's real per-harness stores (captured from `$HOME`
 * BEFORE the override above). Belt and suspenders: either mechanism alone would already prevent the
 * defect this guards against.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// ── SAFETY: set up the throwaway home BEFORE anything server-side is imported ──────────────────

const REAL_HOME = process.env.HOME ?? homedir() ?? ''
const REAL_OWNER_ROOTS = ['.claude', '.agentistics', '.codex', '.gemini', '.copilot', '.kimi-code']
  .map(d => resolve(REAL_HOME, d))
  .filter(d => d !== resolve('/') && d.length > 1)

/** Throws if `path` IS, or is nested inside, one of the owner's real per-harness stores. Returns the
 *  resolved path so a call site can use it inline. PURE apart from the throw. */
function assertSafe(label: string, path: string): string {
  const resolved = resolve(path)
  for (const root of REAL_OWNER_ROOTS) {
    if (resolved === root || resolved.startsWith(root + '/')) {
      throw new Error(
        `parity-matrix: refusing to run — ${label} ("${resolved}") resolves under the real owner `
        + `store "${root}". This script may only read packages/server/test/fixtures/** and throwaway `
        + 'tmpdir() roots, never ~/.claude, ~/.agentistics or any other harness home directory.',
      )
    }
  }
  return resolved
}

const SAFE_HOME = mkdtempSync(join(tmpdir(), 'agentistics-parity-home-'))
process.env.HOME = SAFE_HOME
process.env.AGENTISTICS_DIR = join(SAFE_HOME, '.agentistics')
process.env.CLAUDE_DIR = join(SAFE_HOME, '.claude')
process.env.CODEX_DIR = join(SAFE_HOME, '.codex')
process.env.GEMINI_DIR = join(SAFE_HOME, '.gemini')
process.env.COPILOT_DIR = join(SAFE_HOME, '.copilot')
process.env.KIMI_DIR = join(SAFE_HOME, '.kimi-code')
process.env.ANTIGRAVITY_DIR = join(SAFE_HOME, '.gemini', 'antigravity-cli')
process.env.OPENCODE_DIR = join(SAFE_HOME, '.local', 'share', 'opencode')
process.env.OPENCODE_DB_PATH = join(SAFE_HOME, '.local', 'share', 'opencode', 'opencode.db')

// ── Gemini has no ready-made directory fixture (its own differential test builds one at test time
// over a tmpdir); this mirrors that test's own PROVEN-CLEAN literal sessions — the e2e rich-json
// session (a tool error + a model switch) and the jsonl-shape session — into the `tmp/<project>/
// chats/` layout `runGeminiDifferential` actually scans. Nothing here is read from disk: the content
// is the checked-in literal from differential-gemini.test.ts, reproduced so this script needs no
// fixture file the test does not already prove clean. ──────────────────────────────────────────
async function writeGeminiFixture(geminiDir: string): Promise<void> {
  const chatsDir = join(geminiDir, 'tmp', 'proj', 'chats')
  mkdirSync(chatsDir, { recursive: true })

  const richJson = JSON.stringify({
    sessionId: 'x', startTime: '2026-03-01T10:00:00.000Z', lastUpdated: '2026-03-01T10:04:30.000Z',
    messages: [
      { id: 'u1', timestamp: '2026-03-01T10:00:00.000Z', type: 'user', content: [{ text: 'hi' }] },
      {
        id: 'g1', timestamp: '2026-03-01T10:00:10.000Z', type: 'gemini', content: 'ok',
        model: 'gemini-3-flash-preview', tokens: { input: 100, output: 10, cached: 0 },
        toolCalls: [{ id: 'tc1', name: 'replace', args: { file_path: 'x' }, status: 'error', timestamp: '2026-03-01T10:00:12.000Z' }],
      },
      {
        id: 'g2', timestamp: '2026-03-01T10:04:00.000Z', type: 'gemini', content: 'done',
        model: 'gemini-4-preview', tokens: { input: 50, output: 5, cached: 0 },
      },
    ],
  })
  writeFileSync(join(chatsDir, 'session-e2e.json'), richJson)

  const jsonlLines = [
    JSON.stringify({ sessionId: 's', startTime: '2026-04-01T08:00:00.000Z', lastUpdated: '2026-04-01T08:00:00.000Z', kind: 'main' }),
    JSON.stringify({ $set: { messages: [] } }),
    JSON.stringify({ id: 'j1', timestamp: '2026-04-01T08:00:05.000Z', type: 'user', content: [{ text: 'hi' }] }),
    JSON.stringify({ id: 'j2', timestamp: '2026-04-01T08:00:20.000Z', type: 'gemini', content: 'hello', tokens: { input: 1, output: 1 }, model: 'x' }),
  ].join('\n')
  writeFileSync(join(chatsDir, 'session-jsonl.jsonl'), jsonlLines)
}

// ── Run every harness's differential over its own checked-in fixtures ──────────────────────────

async function collectDiffs(): Promise<{
  perHarness: Record<string, unknown[]>
  cleanup: () => void
  notes: string[]
}> {
  const { runDifferential } = await import('../server/projections/differential')
  const { runCodexDifferential } = await import('../server/projections/differential-codex')
  const { runGeminiDifferential } = await import('../server/projections/differential-gemini')
  const { runCopilotDifferential } = await import('../server/projections/differential-copilot')
  const { runKimiDifferential } = await import('../server/projections/differential-kimi')
  const { runAntigravityDifferential } = await import('../server/projections/differential-antigravity')
  const { runOpencodeDifferential } = await import('../server/projections/differential-opencode')
  const { buildFixtureRoot } = await import('../server/integrations/antigravity/fixture-db')
  const { buildFixtureDb, loadFixture } = await import('../server/integrations/opencode/fixture-db')

  const FIXTURES = assertSafe('fixtures root', join(import.meta.dir, '..', 'test', 'fixtures'))
  const cleanups: (() => void)[] = []
  const notes: string[] = []
  const perHarness: Record<string, unknown[]> = {}

  // claude — every claude-replay* fixture directory, each one conversation (A2.2/A2.8's redacted set).
  {
    const dirs = ['claude-replay', 'claude-replay-compact', 'claude-replay-turns', 'claude-replay-turn-end']
    const diffs: unknown[] = []
    for (const d of dirs) {
      const projectsDir = assertSafe(`claude:${d}`, join(FIXTURES, d))
      const r = await runDifferential({ projectsDir, settledMs: 0, keepDiffs: true })
      diffs.push(...(r.diffs ?? []))
    }
    perHarness.claude = diffs
  }

  // codex — the five redacted rollouts (the fifth is the synthetic reset/model-switch/web-search one).
  {
    const sessionsDir = assertSafe('codex', join(FIXTURES, 'codex-replay', 'sessions'))
    const r = await runCodexDifferential({ sessionsDir, now: () => Date.parse('2100-01-01T00:00:00.000Z'), keepDiffs: true })
    perHarness.codex = r.diffs ?? []
  }

  // gemini — see writeGeminiFixture's header: no ready-made fixture directory exists, so this
  // reproduces differential-gemini.test.ts's own proven-clean literal sessions into the layout the
  // differential scans.
  {
    const geminiDir = mkdtempSync(join(tmpdir(), 'agentistics-parity-gemini-'))
    cleanups.push(() => rmSync(geminiDir, { recursive: true, force: true }))
    await writeGeminiFixture(geminiDir)
    // GeminiDifferentialReport does not itself declare `diffs` in its type (unlike the other
    // harness-specific report interfaces) though `runGeminiDifferential` adds it at runtime when
    // `keepDiffs: true` — differential-gemini.ts is read-only here, so this is a local cast.
    const r = await runGeminiDifferential({ geminiDir: assertSafe('gemini', geminiDir), settledMs: 0, keepDiffs: true }) as
      Awaited<ReturnType<typeof runGeminiDifferential>> & { diffs?: unknown[] }
    perHarness.gemini = r.diffs ?? []
  }

  // copilot — the two checked-in redacted session-state fixtures (a clean shutdown, and a crash
  // with no session.shutdown at all).
  {
    const diffs: unknown[] = []
    for (const d of ['copilot-replay-basic', 'copilot-replay-crashed']) {
      const sessionStateDir = assertSafe(`copilot:${d}`, join(FIXTURES, d, 'session-state'))
      const r = await runCopilotDifferential({ sessionStateDir, settledMs: 0, keepDiffs: true })
      diffs.push(...(r.diffs ?? []))
    }
    perHarness.copilot = diffs
  }

  // kimi — both fixtures, the single-agent "basic" and the two-agent "subagent". The subagent fixture
  // was excluded from the first A4.2 run because it carried a real `bug` (legacy input_tokens 80 against
  // projected 50): legacy folds EVERY kimi agent into the session while sessionMeta v1 summed the main
  // agent only. sessionMeta v2 states legacy's rule (`HARNESS_TOOL_RULES.kimi.countScope`), and the rows
  // that still differ are explained with per-session proofs in differential-kimi.ts — nothing excluded.
  {
    const diffs: unknown[] = []
    for (const d of ['basic', 'subagent']) {
      const sessionsDir = assertSafe(`kimi:${d}`, join(FIXTURES, 'kimi-replay', d))
      const indexFile = assertSafe(`kimi:${d}:indexFile`, join(FIXTURES, 'kimi-replay', d, 'session_index.jsonl'))
      const r = await runKimiDifferential({
        sessionsDir, indexFile, now: () => 1_800_000_000_000, settledMs: 60_000, keepDiffs: true,
      })
      diffs.push(...(r.diffs ?? []))
    }
    perHarness.kimi = diffs
  }

  // antigravity — both fixtures (the synthetic one, and the redacted real parent/child pair),
  // each materialised into its own throwaway sqlite root by the integration's own fixture-db.
  {
    const diffs: unknown[] = []
    for (const d of ['antigravity-replay', 'antigravity-replay-real']) {
      const src = assertSafe(`antigravity:${d}:src`, join(FIXTURES, d))
      const root = buildFixtureRoot(src)
      cleanups.push(() => rmSync(root, { recursive: true, force: true }))
      const rootDir = assertSafe(`antigravity:${d}:root`, root)
      const r = await runAntigravityDifferential({ rootDir, now: () => Date.parse('2027-01-01T00:00:00Z'), keepDiffs: true })
      diffs.push(...(r.diffs ?? []))
    }
    perHarness.antigravity = diffs
  }

  // opencode — the committed, redacted __fixtures__/sessions.json, built into a throwaway sqlite db
  // (there is no legacy adapter at all — both sides of this comparison are the differential's own).
  {
    const dbPath = buildFixtureDb(loadFixture())
    cleanups.push(() => rmSync(dirname(dbPath), { recursive: true, force: true }))
    const r = await runOpencodeDifferential({
      dbPath: assertSafe('opencode', dbPath), now: () => Date.parse('2027-01-01T00:00:00Z'), keepDiffs: true,
    })
    perHarness.opencode = r.diffs ?? []
  }

  return {
    perHarness,
    notes,
    cleanup: () => { for (const fn of cleanups) fn(); rmSync(SAFE_HOME, { recursive: true, force: true }) },
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv: readonly string[]): { outDir: string } {
  const i = argv.indexOf('--out')
  const outDir = i >= 0 && argv[i + 1] ? argv[i + 1]! : join(import.meta.dir, '..', '..', '..', 'parity-matrix-out')
  return { outDir }
}

async function main(): Promise<number> {
  const { outDir } = parseArgs(process.argv.slice(2))
  const { perHarness, cleanup, notes } = await collectDiffs()

  try {
    const { buildParityMatrix, renderParityMatrixJson, renderParityMatrixMarkdown, summarizeParityMatrix } =
      await import('../server/projections/parity-matrix')

    const matrix = buildParityMatrix(perHarness as Parameters<typeof buildParityMatrix>[0])
    const summary = summarizeParityMatrix(matrix)

    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'parity-matrix.json'), renderParityMatrixJson(matrix))
    const md = [
      renderParityMatrixMarkdown(matrix),
      '',
      ...(notes.length > 0 ? ['## Notes', '', ...notes.map(n => `- ${n}`)] : []),
    ].join('\n')
    writeFileSync(join(outDir, 'parity-matrix.md'), md)

    console.log(`parity matrix: ${summary.total} rows — equal ${summary.equal}, explained ${summary.explained}, regression ${summary.regression}`)
    for (const [harness, counts] of Object.entries(summary.byHarness)) {
      console.log(`  ${harness}: equal ${counts.equal}, explained ${counts.explained}, regression ${counts.regression}`)
    }
    console.log(`written: ${join(outDir, 'parity-matrix.json')}`)
    console.log(`written: ${join(outDir, 'parity-matrix.md')}`)
    for (const n of notes) console.log(`note: ${n}`)

    if (summary.regression > 0) {
      console.error(`\nFAIL: ${summary.regression} regression row(s) — a phase may not ship with a regression row (master spec §40).`)
      for (const r of matrix.rows) {
        if (r.status === 'regression') {
          console.error(`  regression: ${r.harness}/${r.metric} — legacy=${JSON.stringify(r.legacyValue)} projected=${JSON.stringify(r.projectedValue)} sessions=${(r.bugSessions ?? []).join(',')}`)
        }
      }
      return 1
    }
    return 0
  } finally {
    cleanup()
  }
}

if (import.meta.main) {
  main().then(code => process.exit(code)).catch(err => {
    console.error(err instanceof Error ? err.stack ?? err.message : err)
    process.exit(1)
  })
}

export { collectDiffs, parseArgs }
