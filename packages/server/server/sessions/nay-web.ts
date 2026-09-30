/**
 * nay-web.ts — starting a Nay conversation: an ordinary managed `claude` session in Nay's own
 * directory, filed under the "Nay" user group. See
 * docs/superpowers/specs/2026-09-29-nay-as-sessions-design.md.
 *
 * It is `runFleetSpawn` with the directory fixed, so every check a session start already makes
 * (harness on PATH, memory admission, launch settling) applies unchanged — a Nay conversation is not
 * a lesser kind of session that skipped them.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { nayTitle, planNayFiling, planNayPlacement, nayPlacementRows as corePlacementRows, type NayPlacementRow, type SessionUserGroupsValue } from '@agentistics/core'
import { sessionRunning } from '@agentistics/tui/control/session-dimensions'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import type { CliLang } from '../cli-lang'
import { NAY_CHAT_DIR } from '../chat-tty'
import { readPreferences, updatePreferences } from '../preferences'
import { runFleetSpawn, type FleetSpawnResponse } from './fleet-web'
import { readRegistry } from './registry'

export interface NaySpawnDeps {
  /** Nay's directory must hold its CLAUDE.md before a session starts in it. */
  ensureDir: () => Promise<void>
  spawn: typeof runFleetSpawn
  /** The model chosen in Settings -> Chat, already validated, or `''` for the CLI's own default. */
  model: () => Promise<string>
  /** The key the new session is filed under — its conversation id where the registry has one. */
  keyOf: (id: string) => Promise<string>
  file: (key: string) => Promise<void>
  now: () => Date
}

const label = (now: Date, lang: CliLang): string => nayTitle(now, lang === 'pt' ? 'pt' : 'en')

export async function startNaySession(lang: CliLang, deps: NaySpawnDeps): Promise<FleetSpawnResponse> {
  await deps.ensureDir()
  const model = await deps.model().catch(() => '')
  const out = await deps.spawn(lang, {
    harness: 'claude', cwd: NAY_CHAT_DIR, label: label(deps.now(), lang), ...(model ? { model } : {}),
  })
  if (!out.ok || !out.id) return out
  // Filing is a convenience on top of a session that already exists: a failed write must not turn a
  // started session into a reported failure the user would retry into a second one.
  try { await deps.file(await deps.keyOf(out.id)) } catch (err) {
    console.warn('[nay] could not file the session under the Nay group:', err instanceof Error ? err.message : String(err))
  }
  return out
}

const groupsOf = (groups: { id: string; name: string; sessionKeys: string[]; parentId?: string }[] | undefined): SessionUserGroupsValue =>
  ({ groups: (groups ?? []).map(g => ({ ...g, sessionKeys: [...g.sessionKeys] })) })

export function defaultNayDeps(port: number): NaySpawnDeps {
  return {
    ensureDir: async () => {
      if (existsSync(join(NAY_CHAT_DIR, 'CLAUDE.md'))) return
      const { ensureNayChat } = await import('../chat-tty')
      await ensureNayChat(port)
    },
    spawn: runFleetSpawn,
    model: async () => {
      const [{ readPreferences }, { modelCatalog }, { resolveChatModel }] = await Promise.all([
        import('../preferences'), import('../model-catalog'), import('../model-catalog-parse'),
      ])
      return resolveChatModel((await readPreferences()).chatModel, await modelCatalog('claude'), '')
    },
    keyOf: async id => (await readRegistry()).find(r => r.id === id)?.conversationId ?? id,
    file: async key => {
      await updatePreferences(cur => {
        const plan = planNayFiling(groupsOf(cur.sessionGroups?.groups), cur.pinnedSessions ?? [], key)
        if (!plan.ok) return undefined
        return { sessionGroups: { groups: plan.groups.groups }, pinnedSessions: plan.pins }
      })
    },
    now: () => new Date(),
  }
}

/** The Nay rows of a fleet as filing wants them — `nayPlacementRows` (core) with the fleet's own
 *  notion of RUNNING, which lives in the TUI package core cannot import. */
export function nayPlacementRows(rows: readonly Pick<ControlSession, 'id' | 'conversationId' | 'cwd' | 'state'>[]): NayPlacementRow[] {
  return corePlacementRows(rows, sessionRunning)
}

let reconciling: Promise<void> | null = null

/**
 * File every Nay conversation into "Nay › Ativas" or "Nay › Inativas" by whether it is running,
 * creating the folders the first time. Called on every fleet read, so a conversation that ENDS —
 * from the chat's own button, the row menu, the cockpit or a reboot — moves on its own.
 *
 * Reads first and writes only when something must move: this runs every few seconds. The write
 * re-plans INSIDE the preferences write chain, so a browser write landing between the read and the
 * write is built on rather than overwritten. One at a time: overlapping polls share the one in flight.
 */
export function reconcileNayFolders(rows: readonly Pick<ControlSession, 'id' | 'conversationId' | 'cwd' | 'state'>[]): Promise<void> {
  if (reconciling) return reconciling
  const placement = nayPlacementRows(rows)
  if (placement.length === 0) return Promise.resolve()
  reconciling = (async () => {
    const cur = await readPreferences()
    if (!planNayPlacement(groupsOf(cur.sessionGroups?.groups), cur.pinnedSessions ?? [], placement).changed) return
    await updatePreferences(p => {
      const plan = planNayPlacement(groupsOf(p.sessionGroups?.groups), p.pinnedSessions ?? [], placement)
      if (!plan.changed) return undefined
      return { sessionGroups: { groups: plan.groups.groups }, pinnedSessions: plan.pins }
    })
  })().catch(err => {
    console.warn('[nay] could not file Nay conversations into their folders:', err instanceof Error ? err.message : String(err))
  }).finally(() => { reconciling = null })
  return reconciling
}
