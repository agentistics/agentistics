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
import { planNayLaunch, type NayLaunch, type NayLaunchRequest, type NayLaunchResult } from './nay-launch'

const LAUNCH_REFUSAL: Record<string, { pt: string; en: string }> = {
  unknown_harness: { pt: 'Este assistente não pode ser iniciado nesta máquina.', en: 'That assistant cannot be started on this machine.' },
  unknown_effort: { pt: 'Este assistente não aceita esse esforço de raciocínio.', en: 'That assistant does not accept that reasoning effort.' },
  no_model_flag: { pt: 'Este assistente não permite escolher o modelo.', en: 'That assistant has no way to choose a model.' },
  no_harness: { pt: 'Nenhum assistente pode ser iniciado nesta máquina.', en: 'No assistant can be started on this machine.' },
}

export interface NaySpawnDeps {
  /** Nay's directory must hold its CLAUDE.md before a session starts in it. */
  ensureDir: () => Promise<void>
  spawn: typeof runFleetSpawn
  /** What the conversation starts with — the picker's request over the Settings -> Chat defaults
   *  (`planNayLaunch`). A refusal is returned to the caller in words. */
  launch: (req: NayLaunchRequest) => Promise<NayLaunchResult>
  /** The key the new session is filed under — its conversation id where the registry has one. */
  keyOf: (id: string) => Promise<string>
  file: (key: string) => Promise<void>
  now: () => Date
}

const label = (now: Date, lang: CliLang): string => nayTitle(now, lang === 'pt' ? 'pt' : 'en')

export async function startNaySession(
  lang: CliLang,
  deps: NaySpawnDeps,
  req: NayLaunchRequest = {},
): Promise<FleetSpawnResponse & { launch?: NayLaunch }> {
  await deps.ensureDir()
  const plan = await deps.launch(req)
  if (!plan.ok) return { ok: false, message: LAUNCH_REFUSAL[plan.reason]![lang === 'pt' ? 'pt' : 'en'] }
  const { ok: _ok, ...launch } = plan
  const out = await deps.spawn(lang, { cwd: NAY_CHAT_DIR, label: label(deps.now(), lang), ...launch })
  if (!out.ok || !out.id) return out
  // Filing is a convenience on top of a session that already exists: a failed write must not turn a
  // started session into a reported failure the user would retry into a second one.
  try { await deps.file(await deps.keyOf(out.id)) } catch (err) {
    console.warn('[nay] could not file the session under the Nay group:', err instanceof Error ? err.message : String(err))
  }
  return { ...out, launch }
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
    launch: async req => {
      const { readNewOptions } = await import('./fleet-web')
      const [prefs, options] = await Promise.all([readPreferences(), readNewOptions('en', '')])
      return planNayLaunch(req, prefs, options.harnesses.map(h => ({
        id: h.id, supportsModel: h.supportsModel, efforts: h.efforts, models: h.models, modelFreeText: h.modelFreeText === true,
      })))
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
