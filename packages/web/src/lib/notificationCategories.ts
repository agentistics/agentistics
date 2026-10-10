/**
 * notificationCategories.ts — PURE: which KIND of thing a bell notification is about, so Settings →
 * Notifications can let a person turn off whole kinds (owner, 2026-09-30: "choose what notifies").
 *
 * The category is read off the notification's `code` prefix, the one stable thing every
 * notification carries. A code no category claims is NEVER muted: silencing something nobody could
 * have chosen to silence is how a real warning goes missing. Session notifications are not here —
 * they have their own master switch and per-kind switches (`NotificationSettings.enabled`/`events`).
 */

export type NotificationCategory = 'updates' | 'idle' | 'tasks' | 'backup' | 'team' | 'accounts' | 'hardware' | 'limits'

export interface CategoryInfo { id: NotificationCategory; pt: string; en: string; hintPt: string; hintEn: string }

export const NOTIFICATION_CATEGORIES: readonly CategoryInfo[] = [
  { id: 'updates', pt: 'Atualizações', en: 'Updates', hintPt: 'Quando sai uma versão nova do agentistics.', hintEn: 'When a new agentistics version is out.' },
  { id: 'idle', pt: 'Sessões paradas', en: 'Idle sessions', hintPt: 'Sugestões de encerrar sessões paradas há muito tempo.', hintEn: 'Suggestions to end sessions idle for a long time.' },
  { id: 'tasks', pt: 'Agentask', en: 'Agentask', hintPt: 'Avisos do Agentask, como um arquivamento bloqueado.', hintEn: 'Notices from Agentask, such as a blocked filing.' },
  { id: 'backup', pt: 'Backup', en: 'Backup', hintPt: 'Quando um backup começa, termina ou falha.', hintEn: 'When a backup starts, finishes or fails.' },
  { id: 'limits', pt: 'Limites do plano', en: 'Plan limits', hintPt: 'Quando uma janela do plano (5 h ou semana) passa de 75%, 85%, 95% e 100%.', hintEn: 'When a plan window (5 hours or week) crosses 75%, 85%, 95% and 100%.' },
  { id: 'hardware', pt: 'Memória da máquina', en: 'Machine memory', hintPt: 'Quando a máquina está ficando sem memória.', hintEn: 'When the machine is running low on memory.' },
]

const PREFIX: ReadonlyArray<[string, NotificationCategory]> = [
  ['app.', 'updates'], ['sessions.', 'idle'], ['tasks.', 'tasks'], ['backup.', 'backup'],
  ['member.', 'team'], ['central.', 'team'], ['machine.', 'team'], ['iam.', 'accounts'], ['hardware.', 'hardware'], ['limits.', 'limits'],
]

/** The category a notification code belongs to, or null when none claims it (then it is never muted). */
export function categoryOf(code: string | undefined): NotificationCategory | null {
  if (!code) return null
  for (const [p, c] of PREFIX) if (code.startsWith(p)) return c
  return null
}

export function isNotificationCategory(v: unknown): v is NotificationCategory {
  return typeof v === 'string' && NOTIFICATION_CATEGORIES.some(c => c.id === v)
}

/** Is this notification in a category the person turned off? */
export function notificationMuted(code: string | undefined, muted: ReadonlySet<string>): boolean {
  const c = categoryOf(code)
  return c !== null && muted.has(c)
}
