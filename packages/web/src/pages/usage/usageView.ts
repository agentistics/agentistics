import { SURFACE_HARNESS_ORDER } from '@agentistics/core' // @native-gated: ordering subscription rows already returned by the plan store.
import type { UsageBudgetRow } from '../../lib/usagePlan'
import { HARNESS_LABELS } from '../../lib/harness'

export type Lang = 'pt' | 'en'
export const accountKey = (row: Pick<UsageBudgetRow, 'harness' | 'account' | 'accountLabel'>) => `${row.harness}:${row.account ?? 'default'}`
export const accountLabel = (row: Pick<UsageBudgetRow, 'harness' | 'account' | 'accountLabel'>) => row.accountLabel ?? row.account ?? HARNESS_LABELS[row.harness]
export function orderedBudgets(rows: readonly UsageBudgetRow[]): UsageBudgetRow[] {
  return [...rows].sort((a, b) => SURFACE_HARNESS_ORDER.indexOf(a.harness) - SURFACE_HARNESS_ORDER.indexOf(b.harness) || accountLabel(a).localeCompare(accountLabel(b)) || accountKey(a).localeCompare(accountKey(b))) // @native-gated: ordering only, no new harness rows.
}
export const unmeasured = (lang: Lang) => lang === 'pt'
  ? 'Sem medida ainda — abra uma sessão para medir o ritmo'
  : 'Not measured yet — open a session to measure the pace'
