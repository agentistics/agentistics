/**
 * task-live-steps — PURE. The step a piece is on INSIDE its current stage, read from facts agentistics already
 * observes, so the Live card's "% desta etapa" does not wait for a worker to remember to report one.
 *
 * Every rule here is one observed fact → one step number. There is no estimate and no inference from silence:
 * a stage with no observable signal answers `null` and the card draws no percent line (the same rule
 * `stagePercent` follows). The words of each step are the web's (`STAGE_STEPS` in `liveCardModel.ts`); the
 * numbers here are positions in those lists, so the two files must agree — `task-live-steps.test.ts` pins it.
 *
 * Signals, by stage:
 *   running  1 a session is open · 2 it edited a file · 3 it ran a test command · 4 it committed (or the
 *            `salvo` gate saw its head on origin) · 5 it sent its handback
 *   adjust   1 a session is open · 3 the `salvo` gate saw the fix pushed · 4 it sent its handback
 *   qa       1 the QA session is open · 2 it ran tests · 3 it drove a browser · 4 its verdict is recorded
 *   leader   1 the review is open · 2 the `delecoes` gate ran · 3 the review decision is recorded
 *   merge    1 the PR is being opened · 2 the PR exists · 3 the PR is merged
 *   ci       not here — `cardPercent` derives it from the CI signal
 */
import type { SessionMeta } from '@agentistics/core'
import type { LiveStage } from './task-live'

/** What one session's transcript says it DID. Each field is null when the transcript was not read for it. */
export interface SessionActivity {
  /** File-writing tool calls (Edit / Write / MultiEdit / NotebookEdit, any harness's names mapped to those). */
  edits: number | null
  /** Test-runner commands (`countTestCommands`). */
  tests: number | null
  /** `git commit` commands. */
  commits: number | null
  /** The session drove a browser (a Playwright / Chrome / computer-use MCP tool). */
  browser: boolean | null
}

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const
const BROWSER_TOOL = /^mcp__(playwright|claude-in-chrome|claude_browser|computer-use|chrome|browser)/i

/** PURE: a session's activity off its stored meta; `undefined` when no meta exists (nothing was read — no signal at all). */
export function sessionActivityOf(meta: Pick<SessionMeta, 'tool_counts' | 'git_commits' | 'test_runs'> | null | undefined): SessionActivity | undefined {
  if (!meta) return undefined
  const counts = meta.tool_counts ?? {}
  return {
    edits: EDIT_TOOLS.reduce((n, t) => n + (counts[t] ?? 0), 0),
    tests: typeof meta.test_runs === 'number' ? meta.test_runs : null,
    commits: typeof meta.git_commits === 'number' ? meta.git_commits : null,
    browser: Object.keys(counts).some(k => BROWSER_TOOL.test(k) && (counts[k] ?? 0) > 0),
  }
}

/** The delivery-record facts the steps read (structural, so this module stays free of the flow's types). */
export interface StepRecord {
  phase: string
  gates?: Partial<Record<string, { ok: boolean; at: string }>>
  headSha?: string
  qaSessionId?: string
  qa?: { at: string }
  review?: { at: string }
  pr?: number
  mergeSha?: string
}

export interface StepSession { id: string; live: boolean; isQa: boolean; activity?: SessionActivity }

export interface StepFacts {
  stage: LiveStage
  /** When the piece entered this stage (ms), when the log says. Facts older than that belong to an earlier stage. */
  sinceMs: number | null
  sessions: readonly StepSession[]
  rec?: StepRecord | undefined
  /** A handback comment on this piece, newer than the stage's start. */
  handback: boolean
}

export interface DerivedStep { step: number; signal: string }

const at = (iso: string | undefined): number | null => { const n = iso ? Date.parse(iso) : NaN; return Number.isFinite(n) ? n : null }
/** A gate counts for THIS stage only when it ran after the stage began (or the stage's start is unknown). */
const gateOk = (rec: StepRecord | undefined, name: string, sinceMs: number | null): boolean => {
  const g = rec?.gates?.[name]
  if (!g?.ok) return false
  const t = at(g.at)
  return sinceMs === null || t === null || t >= sinceMs
}
const since = (iso: string | undefined, sinceMs: number | null): boolean => {
  const t = at(iso)
  return t !== null && (sinceMs === null || t >= sinceMs)
}
const total = (xs: readonly (number | null | undefined)[]): number => xs.reduce<number>((n, x) => n + (x ?? 0), 0)

/** PURE: the highest step whose signal is observed, with the signal's name; null = nothing observable (draw no percent). */
export function deriveStep(f: StepFacts): DerivedStep | null {
  const work = f.sessions.filter(s => !s.isQa)
  switch (f.stage) {
    case 'running': {
      if (work.length === 0) return null
      const acts = work.map(s => s.activity)
      if (f.handback) return { step: 5, signal: 'handback' }
      if (total(acts.map(a => a?.commits)) > 0 || gateOk(f.rec, 'salvo', f.sinceMs)) return { step: 4, signal: 'commit' }
      if (total(acts.map(a => a?.tests)) > 0) return { step: 3, signal: 'tests' }
      if (total(acts.map(a => a?.edits)) > 0) return { step: 2, signal: 'edit' }
      return { step: 1, signal: 'session' }
    }
    case 'adjust': {
      if (f.handback) return { step: 4, signal: 'handback' }
      if (gateOk(f.rec, 'salvo', f.sinceMs)) return { step: 3, signal: 'commit' }
      return work.some(s => s.live) ? { step: 1, signal: 'session' } : null
    }
    case 'qa': {
      const qa = f.sessions.filter(s => s.isQa || (f.rec?.qaSessionId !== undefined && s.id === f.rec.qaSessionId))
      if (f.rec?.qa && since(f.rec.qa.at, f.sinceMs)) return { step: 4, signal: 'verdict' }
      if (qa.length === 0) return null
      if (qa.some(s => s.activity?.browser)) return { step: 3, signal: 'browser' }
      if (total(qa.map(s => s.activity?.tests)) > 0) return { step: 2, signal: 'tests' }
      return { step: 1, signal: 'session' }
    }
    case 'leader': {
      if (!f.rec) return null
      if (f.rec.review && since(f.rec.review.at, f.sinceMs)) return { step: 3, signal: 'review' }
      if (gateOk(f.rec, 'delecoes', f.sinceMs)) return { step: 2, signal: 'deletions-gate' }
      return { step: 1, signal: 'stage' }
    }
    case 'merge': {
      if (!f.rec) return null
      if (f.rec.mergeSha || gateOk(f.rec, 'mergeado', f.sinceMs)) return { step: 3, signal: 'merged' }
      if (f.rec.pr) return { step: 2, signal: 'pr' }
      return { step: 1, signal: 'stage' }
    }
    default: return null
  }
}

/** PURE: the step to show — the larger of what the worker reported and what the signals observed, and where it came from. */
export function mergeStep(reported: number | null, derived: DerivedStep | null): { step: number; source: 'reported' | 'signals'; signal?: string } | null {
  if (reported !== null && (derived === null || reported >= derived.step)) return { step: reported, source: 'reported' }
  return derived ? { step: derived.step, source: 'signals', signal: derived.signal } : null
}
