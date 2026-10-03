/**
 * notifyMenu.ts — the "mute / unmute notifications" entry every session menu carries.
 *
 * CLIENT-SIDE like `link-task` and the group entries: it acts on the local mute store rather than
 * resolving a server verb, so `rowMenuEntries` could not have composed it. One builder, so the
 * aside, the Nay dock and the gallery cannot word it three ways.
 */

import { useSyncExternalStore } from 'react'
import { sessionIdentityKey } from '@agentistics/core'
import { getMutedKeys, mutedServerSnapshot, subscribeMutedSessions } from './mutedSessions'
import type { MenuEntry } from './rowMenu'

export const NOTIFY_TOGGLE = 'toggle-notify'

export function notifyMenuExtras(
  row: { id: string; conversationId?: string | undefined } | undefined,
  muted: readonly string[],
  pt: boolean,
): MenuEntry[] {
  if (!row) return []
  const off = muted.includes(sessionIdentityKey(row))
  return [{
    action: NOTIFY_TOGGLE,
    label: off
      ? (pt ? 'Reativar notificações' : 'Unmute notifications')
      : (pt ? 'Silenciar notificações' : 'Mute notifications'),
    enabled: true,
  }]
}

/** The muted keys, live. */
export function useMutedKeys(): string[] {
  return useSyncExternalStore(subscribeMutedSessions, getMutedKeys, mutedServerSnapshot)
}

/** Copy for the BellOff indicator's tooltip. */
export function mutedTooltip(pt: boolean): string {
  return pt
    ? 'Notificações silenciadas — a sessão continua aparecendo como "precisa de você"'
    : 'Notifications muted — the session still shows as waiting'
}

/** Is this one session muted — for the BellOff indicator in a header. */
export function useSessionMuted(row: { id: string; conversationId?: string | undefined } | undefined): boolean {
  const keys = useMutedKeys()
  return row !== undefined && keys.includes(sessionIdentityKey(row))
}
