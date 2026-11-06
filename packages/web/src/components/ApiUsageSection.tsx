/**
 * The APIs section of plan usage: paid API keys with their balance, in the same visual language as the
 * account rows (ring, name + plan, words). Used by the popover (`compact`), the modal body and the usage
 * page. States `no-key` / `no-permission` / `error` are said in words and draw a dashed empty ring —
 * never a zero.
 */
import { KeyRound } from 'lucide-react'
import { apiRowLine, apiUsedPct, type ApiUsageItem } from '../lib/apiUsage'
import { PlanUsageRing, PLAN_ROW_GRID } from './PlanLimitMeter'

type Lang = 'pt' | 'en'

export const apiSectionTitle = (lang: Lang) => (lang === 'pt' ? 'APIs' : 'APIs')
export const accountsSectionTitle = (lang: Lang) => (lang === 'pt' ? 'Contas' : 'Accounts')

export function SectionTitle({ children, id }: { children: string; id?: string }) {
  return <div id={id} role="heading" aria-level={3} data-usage-section-title style={{ padding: '8px 4px 2px', fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', fontWeight: 700, color: 'var(--text-secondary)' }}>{children}</div>
}

export function ApiUsageRow({ item, now, lang, bordered = true }: { item: ApiUsageItem; now: number; lang: Lang; bordered?: boolean }) {
  const pct = apiUsedPct(item)
  const bad = item.status === 'error' || item.status === 'no-permission'
  return <div data-api-row={item.id} data-api-status={item.status} style={{ ...PLAN_ROW_GRID, padding: '8px 4px', borderTop: bordered ? '1px solid var(--border)' : undefined }}>
    <KeyRound size={18} aria-hidden style={{ color: 'var(--text-secondary)' }} />
    <div style={{ minWidth: 0 }}>
      <b style={{ display: 'block', fontSize: 13, overflowWrap: 'anywhere' }}>{item.label}</b>
      {item.plan && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>{item.plan}</span>}
      <span data-api-line style={{ display: 'block', fontSize: 11.5, color: bad ? 'var(--anthropic-orange)' : 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{apiRowLine(item, now, lang)}</span>
      {item.detail && item.status !== 'ok' && <span style={{ display: 'block', fontSize: 11, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>{item.detail}</span>}
    </div>
    <div style={{ gridColumn: '3 / -1', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <PlanUsageRing pct={pct} size={36}>{pct === null ? '–' : Math.round(pct)}</PlanUsageRing>
      <span style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{lang === 'pt' ? 'Créditos' : 'Credits'}</span>
    </div>
  </div>
}

/** Rows only (the popover supplies its own title). */
export function ApiUsageRows({ items, now, lang }: { items: ApiUsageItem[]; now: number; lang: Lang }) {
  return <div data-api-usage>{items.map(i => <ApiUsageRow key={i.id} item={i} now={now} lang={lang} />)}</div>
}

/**
 * Titled section. `items` null (not answered yet) and an empty list both hide it unless `emptyNotice`
 * (the usage page), where an empty list says "no API connected" in a sentence.
 */
export function ApiUsageSection({ items, now, lang, emptyNotice = false }: { items: ApiUsageItem[] | null; now: number; lang: Lang; emptyNotice?: boolean }) {
  if (!items || items.length === 0) {
    if (!emptyNotice || items === null) return null
    return <section data-api-usage-section style={{ marginBottom: 20 }}>
      <SectionTitle>{apiSectionTitle(lang)}</SectionTitle>
      <p data-api-empty style={{ margin: '4px 4px 0', fontSize: 12, color: 'var(--text-tertiary)' }}>{lang === 'pt' ? 'Nenhuma API conectada.' : 'No API connected.'}</p>
    </section>
  }
  return <section data-api-usage-section style={{ marginBottom: 20, minWidth: 0 }}>
    <SectionTitle>{apiSectionTitle(lang)}</SectionTitle>
    <ApiUsageRows items={items} now={now} lang={lang} />
  </section>
}
