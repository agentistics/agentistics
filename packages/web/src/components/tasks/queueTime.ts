/**
 * queueTime — PURE: how a scheduled start is said ("começa às 14:00"). Its own file because both the Live card's model and the
 * Fila tab's model say it, and the two import each other's neighbours — one definition, no cycle.
 */
const two = (n: number) => String(n).padStart(2, '0')

/** "14:00" in the reader's local clock. */
export const clock = (iso: string): string => { const d = new Date(iso); return `${two(d.getHours())}:${two(d.getMinutes())}` }

/** "começa às 14:00" today, "começa amanhã às 14:00", "começa 09/11 às 14:00" otherwise (en: "starts at …"). */
export function startsLine(untilIso: string, nowMs: number, pt: boolean): string {
  const u = new Date(untilIso), n = new Date(nowMs)
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((day(u) - day(n)) / 86_400_000)
  const hhmm = clock(untilIso)
  if (diff <= 0) return pt ? `começa às ${hhmm}` : `starts at ${hhmm}`
  if (diff === 1) return pt ? `começa amanhã às ${hhmm}` : `starts tomorrow at ${hhmm}`
  const date = pt ? `${two(u.getDate())}/${two(u.getMonth() + 1)}` : `${two(u.getMonth() + 1)}/${two(u.getDate())}`
  return pt ? `começa ${date} às ${hhmm}` : `starts ${date} at ${hhmm}`
}
