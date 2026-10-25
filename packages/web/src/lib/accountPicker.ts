/**
 * accountPicker.ts — CONTA.LIMITES, PURE. The rows of the "switch account" picker: every account of
 * this machine, drawn like the "Plan usage" list (name, plan, 5 h + week rings), each one either the
 * session's CURRENT account, a target that can be picked, or a row that cannot — with the reason in
 * words. Which accounts are targets is the SERVER's decision (`SwitchInfo.options`); this module only
 * adds what the browser can see on its own: a target whose plan window is spent is not one to pick
 * until it renews.
 */
import { currentUsedPct, type PlanLimits } from '@agentistics/core'
import { fmtWhen } from './planLimits'
import { isHandoff, type SwitchInfo, type SwitchUnavailableReason } from './accountSwitch'

type Lang = 'pt' | 'en'

export interface PickerRow {
  /** `harness:id` — unique across the list. */
  key: string
  id: string
  harness: string
  label: string
  plan?: string
  /** This account's plan reading, or `null` when it has none yet (no ring, never a zero). */
  limits: PlanLimits | null
  kind: 'current' | 'option' | 'disabled'
  /** Why a `disabled` row cannot be picked, in words. */
  reason?: string
  /** Picking it starts a NEW conversation on another harness (v2), rather than continuing this one. */
  handoff: boolean
  recommended?: boolean
}

const REASON: Record<SwitchUnavailableReason, { pt: string; en: string }> = {
  not_agentic: { pt: 'Não liberada para uso por agentes', en: 'Not available for agent use' },
  signed_out: { pt: 'Sem login nesta máquina', en: 'Not signed in on this machine' },
  cant_carry: { pt: 'Este assistente não leva a conversa para outra conta', en: "This assistant can't carry the conversation to another account" },
  harness_unavailable: { pt: 'Não encontrado neste computador', en: 'Not found on this computer' },
  unavailable: { pt: 'Indisponível agora', en: 'Unavailable right now' },
}

export const unavailableReason = (r: SwitchUnavailableReason, lang: Lang): string => (REASON[r] ?? REASON.unavailable)[lang]

/**
 * The reading for one account: the exact `harness + account` record, else — for a meter recorded
 * before accounts existed (`account: 'default'`) — the harness's ONLY record, never a guess between two.
 */
export function limitsFor(limits: readonly PlanLimits[] | null, harness: string, id: string | undefined): PlanLimits | null {
  if (!limits) return null
  const mine = limits.filter(l => l.harness === harness)
  return (id ? mine.find(l => l.account === id) : undefined)
    ?? (mine.length === 1 && mine[0]!.account === 'default' ? mine[0]! : null)
}

/**
 * When a spent account is usable again: the LATEST reset among its windows at 100% (both spent means
 * waiting for both). `null` while every window has room.
 */
export function spentUntil(l: PlanLimits | null, now: number): number | null {
  const spent = (l?.windows ?? []).filter(w => currentUsedPct(w, now) >= 100)
  return spent.length ? Math.max(...spent.map(w => w.resetsAt)) : null
}

export function pickerRows(info: SwitchInfo, limits: readonly PlanLimits[] | null, now: number, lang: Lang): PickerRow[] {
  const pt = lang === 'pt'
  const rows: PickerRow[] = []
  const cur = info.current
  if (cur?.harness) {
    const l = limitsFor(limits, cur.harness, cur.id)
    const plan = cur.plan ?? l?.plan ?? l?.sourcePlan
    rows.push({
      key: `${cur.harness}:${cur.id ?? ''}`, id: cur.id ?? '', harness: cur.harness, label: cur.label ?? '',
      ...(plan ? { plan } : {}), limits: l, kind: 'current', handoff: false,
    })
  }
  for (const o of info.options) {
    const l = limitsFor(limits, o.harness, o.id)
    const until = spentUntil(l, now)
    const plan = o.plan ?? l?.plan ?? l?.sourcePlan
    rows.push({
      key: `${o.harness}:${o.id}`, id: o.id, harness: o.harness, label: o.label, ...(plan ? { plan } : {}), limits: l,
      kind: until === null ? 'option' : 'disabled',
      ...(until !== null ? { reason: pt ? `No limite · renova ${fmtWhen(until, now, lang)}` : `At its limit · resets ${fmtWhen(until, now, lang)}` } : {}),
      handoff: isHandoff(info, o.harness),
      ...(o.recommended ? { recommended: true } : {}),
    })
  }
  for (const u of info.unavailable ?? []) {
    const l = limitsFor(limits, u.harness, u.id)
    const plan = u.plan ?? l?.plan ?? l?.sourcePlan
    rows.push({
      key: `${u.harness}:${u.id}`, id: u.id, harness: u.harness, label: u.label, ...(plan ? { plan } : {}), limits: l,
      kind: 'disabled', reason: unavailableReason(u.reason, lang), handoff: isHandoff(info, u.harness),
    })
  }
  return rows
}

/**
 * The row the picker starts on: an account of the SAME assistant first (the conversation continues;
 * pressing the primary button without reading must never start a new one elsewhere) — the router's
 * pick among those, else the first — and only then the router's pick anywhere, else the first.
 */
export function defaultPick(rows: readonly PickerRow[]): string {
  const open = rows.filter(r => r.kind === 'option')
  const same = open.filter(r => !r.handoff)
  return (same.find(r => r.recommended) ?? same[0] ?? open.find(r => r.recommended) ?? open[0])?.key ?? ''
}
