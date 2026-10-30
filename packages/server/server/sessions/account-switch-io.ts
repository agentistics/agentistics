/**
 * account-switch-io.ts — the I/O half of `account-switch.ts` (CONTA.TROCA): find the conversation's
 * files in the account root it runs in now, copy them into the target account's root, read the
 * transcript's tail for a usage limit, and list the accounts a session could move to.
 *
 * Nothing here ends a process or spawns one — that is the host's (`switchSessionAccount` in
 * `cli-start.ts`), which calls these in order. Nothing here reads or copies a credential: the only
 * paths it touches are the conversation's own transcript, its sidecar directory and a Codex rollout.
 */
import { copyFile, cp, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { HarnessId } from '@agentistics/core'
import { defaultHarnessRoot, readAccounts } from '../harness-accounts'
import { readTailBytes, windowLines } from './transcript-window'
import {
  SWITCH_LAYOUT, allSwitchOptions, unavailableSwitchTargets, claudeProjectDir, claudeSidecarOf, detectLimitInTail, isCodexRolloutOf,
  type LimitState, type SourceFiles, type SwitchAccountMeta, type SwitchCopy, type SwitchOption, type SwitchUnavailable,
} from './account-switch'
import { spawnAccountContext, spawnAccountRows } from './spawn-account-io'
import { decideRecordedAccount } from './spawn-account'

const isFile = async (p: string) => { try { return (await stat(p)).isFile() } catch { return false } }
const isDir = async (p: string) => { try { return (await stat(p)).isDirectory() } catch { return false } }
const list = async (p: string) => { try { return await readdir(p) } catch { return [] as string[] } }

/** A root of `null` is the harness's default login root. */
export const resolveRoot = (harness: HarnessId, root: string | null): string => root ?? defaultHarnessRoot(harness)

/** Find the conversation's files under one login root. Direct path first, then one scan. */
export async function findSourceFiles(harness: HarnessId, root: string, conversationId: string, cwd: string): Promise<SourceFiles> {
  const layout = SWITCH_LAYOUT[harness]
  if (layout === 'claude-projects') {
    const projects = join(root, 'projects')
    const direct = join(projects, claudeProjectDir(cwd), `${conversationId}.jsonl`)
    let transcript: string | undefined = (await isFile(direct)) ? direct : undefined
    if (!transcript) {
      for (const d of await list(projects)) {
        const p = join(projects, d, `${conversationId}.jsonl`)
        if (await isFile(p)) { transcript = p; break }
      }
    }
    if (!transcript) return {}
    const sidecar = claudeSidecarOf(transcript, conversationId)
    return { transcript, ...((await isDir(sidecar)) ? { sidecar } : {}) }
  }
  if (layout === 'codex-sessions') {
    // sessions/YYYY/MM/DD/rollout-…-<id>.jsonl — newest days first, the live one is almost always recent.
    const base = join(root, 'sessions')
    const desc = (a: string[]) => a.sort().reverse()
    for (const y of desc(await list(base))) {
      for (const m of desc(await list(join(base, y)))) {
        for (const d of desc(await list(join(base, y, m)))) {
          const hit = (await list(join(base, y, m, d))).find(f => isCodexRolloutOf(f, conversationId))
          if (hit) return { transcript: join(base, y, m, d, hit) }
        }
      }
    }
  }
  return {}
}

/** Carry the files. Overwrites a stale copy in the target (the source is the newer one), never deletes. */
export async function executeCopies(copies: readonly SwitchCopy[]): Promise<void> {
  for (const c of copies) {
    if (c.from === c.to) continue
    await mkdir(dirname(c.to), { recursive: true, mode: 0o700 })
    if (c.kind === 'file') await copyFile(c.from, c.to)
    else await cp(c.from, c.to, { recursive: true, force: true })
  }
}

/** The root a recorded account runs in (`null` account: the default root). Unknown: the default. */
export async function rootOfAccount(harness: HarnessId, accountId: string | undefined): Promise<string> {
  if (!accountId) return defaultHarnessRoot(harness)
  const d = decideRecordedAccount(accountId, await spawnAccountRows())
  if (d.ok) return resolveRoot(harness, d.account?.root ?? null)
  const row = (await spawnAccountRows()).find(a => a.id === accountId)
  return resolveRoot(harness, row?.root ?? null)
}

/** Is this conversation stopped on a usage limit? Read from the transcript's last 256 KiB. */
export async function readLimitState(o: { harness: HarnessId; conversationId: string; cwd: string; accountId?: string }): Promise<LimitState | null> {
  const r = await readLimitProbe(o)
  return r.kind === 'limited' ? r.state : null
}

/**
 * The same read, with the THREE answers a caller that acts on it needs: `limited`, `clear` (a transcript was read and its
 * last turn is not a limit — a positive answer) and `unread` (no transcript found / unreadable: it proves nothing).
 * `cache` (CONTA.AUTO's 60 s tick): the transcript path is remembered per conversation (no directory walk after the
 * first) and the tail is re-read only when the file's mtime changed.
 */
export type LimitProbe = { kind: 'limited'; state: LimitState } | { kind: 'clear' } | { kind: 'unread' }
export interface LimitProbeCache { entries: Map<string, { path: string; mtimeMs: number; result: LimitProbe }> }
export const newLimitProbeCache = (): LimitProbeCache => ({ entries: new Map() })

export async function readLimitProbe(o: { harness: HarnessId; conversationId: string; cwd: string; accountId?: string }, cache?: LimitProbeCache): Promise<LimitProbe> {
  if (!SWITCH_LAYOUT[o.harness]) return { kind: 'unread' }
  const key = `${o.harness}:${o.accountId ?? ''}:${o.conversationId}`
  const hit = cache?.entries.get(key)
  let path = hit?.path
  if (path) {
    const st = await stat(path).catch(() => null)
    if (!st) { cache!.entries.delete(key); path = undefined }
    else if (hit && st.mtimeMs === hit.mtimeMs) return hit.result
  }
  if (!path) {
    const root = await rootOfAccount(o.harness, o.accountId)
    path = (await findSourceFiles(o.harness, root, o.conversationId, o.cwd)).transcript
  }
  if (!path) return { kind: 'unread' }
  const st = await stat(path).catch(() => null)
  const tail = await readTailBytes(path, 256 * 1024)
  if (!st || !tail) return { kind: 'unread' }
  const state = detectLimitInTail(o.harness, windowLines(tail))
  const result: LimitProbe = state ? { kind: 'limited', state } : { kind: 'clear' }
  cache?.entries.set(key, { path, mtimeMs: st.mtimeMs, result })
  return result
}

/** The harnesses a hand-off could start here: spec'd and on PATH. A blind PATH offers none. */
export async function startableHere(): Promise<HarnessId[]> {
  const { availableHarnesses } = await import('./harness-available')
  const a = availableHarnesses()
  return a.blind ? [] : a.ids
}

/**
 * The accounts a session could move to, labelled for a person — its own harness's other accounts
 * first, then every account of every other harness that can start a session here (CONTA.TROCA v2).
 */
export async function listSwitchOptions(o: { harness: HarnessId; accountId?: string; agentCaller: boolean }): Promise<SwitchOption[]> {
  return (await listSwitchTargets(o)).options
}

/** The options PLUS every account they leave out, with the reason (CONTA.LIMITES's picker). */
export async function listSwitchTargets(o: { harness: HarnessId; accountId?: string; agentCaller: boolean }): Promise<{ options: SwitchOption[]; unavailable: SwitchUnavailable[] }> {
  const startable = await startableHere()
  const context = await spawnAccountContext([o.harness, ...startable.filter(h => h !== o.harness)])
  let meta: SwitchAccountMeta[] = []
  try {
    meta = (await readAccounts()).accounts.map(a => ({ id: a.id, label: a.nickname || a.label, ...(a.plan ? { plan: a.plan } : {}) }))
  } catch { /* no labels: ids are shown */ }
  const current = o.accountId ? { currentAccountId: o.accountId } : {}
  const options = allSwitchOptions({ harness: o.harness, ...current, agentCaller: o.agentCaller, context, meta, startable })
  return { options, unavailable: unavailableSwitchTargets({ harness: o.harness, ...current, context, meta, startable, offered: options }) }
}

/** The label of the account a session runs on now, for the notice ("this account hit its limit"). */
export async function accountLabel(harness: HarnessId, accountId: string | undefined): Promise<string | undefined> {
  try {
    const file = await readAccounts()
    const id = accountId ?? (await spawnAccountRows()).find(a => a.harness === harness && a.bound && a.root === null)?.id
    const a = file.accounts.find(x => x.id === id)
    return a ? a.nickname || a.label : undefined
  } catch { return undefined }
}
