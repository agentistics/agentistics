/**
 * handoff-template.ts — PURE. The shape of a leader hand-off file and the takeover instruction.
 *
 * Two rules from the owner (29/10): a hand-off is at most 80 lines, and it opens with a block of the
 * owner's standing orders — literal and dated — so the successor reads what outranks everything first.
 * The takeover text reaches the successor as part of its SYSTEM context (`agentistics-context.ts`),
 * not as the first user prompt: the `-p` of `agentop session --handoff` is only a trigger.
 */

export const HANDOFF_MAX_LINES = 80
export const ORDERS_HEADING = 'ORDENS VIGENTES DO DONO'

export interface OwnerOrder { /** ISO date the owner said it. */ at: string; /** The owner's words, literal. */ text: string }

/** What the successor is told at startup, in the system channel. One place; the CLI prompt repeats none of it. */
export const HANDOFF_TAKEOVER_LINE =
  `You are the SUCCESSOR in a leader hand-off. Read the hand-off file first: its "${ORDERS_HEADING}" block holds the owner's literal, dated orders and outranks the rest of the file. Take over first (state, running sessions, queue); only then close the old leader. Expired orders are not in the file — do not resurrect them.`

/** Orders older than `maxAgeDays` are dropped: an expired order must not keep steering the fleet. */
export function liveOrders(orders: readonly OwnerOrder[], now: number, maxAgeDays = 14): OwnerOrder[] {
  return orders.filter(o => { const t = Date.parse(o.at); return Number.isFinite(t) && now - t <= maxAgeDays * 86_400_000 })
}

export interface HandoffTemplateInput {
  title: string
  orders: readonly OwnerOrder[]
  state: readonly string[]
  sessions: readonly string[]
  queue: readonly string[]
  decisions: readonly string[]
}

/** The hand-off document, orders block first, hard-capped at HANDOFF_MAX_LINES (sections are trimmed, never the orders). */
export function handoffTemplate(i: HandoffTemplateInput): string {
  const head = [`# ${i.title}`, '', `## ${ORDERS_HEADING}`, ...(i.orders.length > 0 ? i.orders.map(o => `- ${o.at.slice(0, 10)}: "${o.text}"`) : ['- (none)']), '']
  const sections: Array<[string, readonly string[]]> = [['Estado', i.state], ['Sessões ativas', i.sessions], ['Fila', i.queue], ['Decisões', i.decisions]]
  const body = sections.map(([h, items]) => ({ h, items: [...items] }))
  const size = () => head.length + body.reduce((n, s) => n + 2 + s.items.length, 0)
  while (size() > HANDOFF_MAX_LINES) {
    const biggest = body.reduce((a, b) => (b.items.length > a.items.length ? b : a))
    if (biggest.items.length === 0) break
    biggest.items.pop()
  }
  return [...head, ...body.flatMap(s => [`## ${s.h}`, ...s.items.map(t => `- ${t}`), ''])].join('\n').trimEnd() + '\n'
}
