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
import { planNayFiling, type SessionUserGroupsValue } from '@agentistics/core'
import type { CliLang } from '../cli-lang'
import { NAY_CHAT_DIR } from '../chat-tty'
import { updatePreferences } from '../preferences'
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

function label(now: Date, lang: CliLang): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = lang === 'pt'
    ? `${pad(now.getDate())}/${pad(now.getMonth() + 1)}`
    : `${pad(now.getMonth() + 1)}/${pad(now.getDate())}`
  return `Nay · ${day} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

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
