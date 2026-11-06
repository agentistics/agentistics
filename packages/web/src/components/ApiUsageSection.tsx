/**
 * The APIs section of plan usage: paid API keys with their balance, in the same visual language as the
 * account rows (ring, name + plan, words). Used by the popover (`compact`), the modal body and the usage
 * page. States `no-key` / `no-permission` / `error` are said in words and draw a dashed empty ring —
 * never a zero.
 */
import { useState } from 'react'
import { KeyRound, Pencil } from 'lucide-react'
import { apiRowLine, apiUsedPct, refreshApiUsage, type ApiUsageItem } from '../lib/apiUsage'
import { PlanUsageRing, PLAN_ROW_GRID } from './PlanLimitMeter'
import { ConfirmModal, dialogButtonStyle } from '../pages/settings/primitives'

type Lang = 'pt' | 'en'

export const apiSectionTitle = (lang: Lang) => (lang === 'pt' ? 'APIs' : 'APIs')
export const accountsSectionTitle = (lang: Lang) => (lang === 'pt' ? 'Contas' : 'Accounts')

export function SectionTitle({ children, id }: { children: string; id?: string }) {
  return <div id={id} role="heading" aria-level={3} data-usage-section-title style={{ padding: '8px 4px 2px', fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', fontWeight: 700, color: 'var(--text-secondary)' }}>{children}</div>
}

export function ApiUsageRow({ item, now, lang, bordered = true }: { item: ApiUsageItem; now: number; lang: Lang; bordered?: boolean }) {
  const [open, setOpen] = useState(false)
  const pct = apiUsedPct(item)
  const bad = item.status === 'error' || item.status === 'no-permission'
  const tooltip = (item.status === 'no-key' || item.status === 'no-permission') && item.detail ? item.detail : undefined
  return <>
  <div data-api-row={item.id} data-api-status={item.status} title={tooltip} style={{ ...PLAN_ROW_GRID, padding: '8px 4px', borderTop: bordered ? '1px solid var(--border)' : undefined }}>
    <KeyRound size={18} aria-hidden style={{ color: 'var(--text-secondary)' }} />
    <div style={{ minWidth: 0 }}>
      <b style={{ display: 'block', fontSize: 13, overflowWrap: 'anywhere' }}>{item.label}</b>
      {item.plan && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>{item.plan}</span>}
      <span data-api-line style={{ display: 'block', fontSize: 11.5, color: bad ? 'var(--anthropic-orange)' : 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{apiRowLine(item, now, lang)}</span>
      {item.config?.status === 'set' && <span data-api-config-detail style={{ display: 'block', fontSize: 11, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>{'•••• '}{item.config.last4 ?? '••••'}{item.config.where ? ` · ${item.config.where}` : ''}</span>}
      {item.detail && item.status === 'error' && <span style={{ display: 'block', fontSize: 11, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>{item.detail}</span>}
    </div>
    <div style={{ gridColumn: '3 / -1', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <PlanUsageRing pct={pct} size={36}>{pct === null ? '–' : Math.round(pct)}</PlanUsageRing>
      <span style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{lang === 'pt' ? 'Créditos' : 'Credits'}</span>
    </div>
    {item.config && <button type="button" data-api-config-open aria-label={lang === 'pt' ? `Editar chave · ${item.label}` : `Edit key · ${item.label}`} title={lang === 'pt' ? 'Editar' : 'Edit'} onClick={() => setOpen(true)} style={{ border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', borderRadius: 7, padding: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}><Pencil size={14} aria-hidden /></button>}
  </div>
  {item.config && <ApiKeyDialog item={item} lang={lang} open={open} onClose={() => setOpen(false)} onChanged={() => { setOpen(false); void refreshApiUsage() }} />}
  </>
}

function ApiKeyDialog({ item, lang, open, onClose, onChanged }: { item: ApiUsageItem; lang: Lang; open: boolean; onClose: () => void; onChanged: () => void }) {
  const pt = lang === 'pt'
  const config = item.config!
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [missing, setMissing] = useState<{ pt: string; en: string }[]>([])
  const [unverified, setUnverified] = useState<{ pt: string; en: string }[]>([])
  const [error, setError] = useState('')
  const save = async () => {
    if (!key || busy) return
    const submitted = key
    setError(''); setMissing([]); setUnverified([])
    setBusy(true)
    try {
      const response = await fetch(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: submitted }) })
      const body = await response.json().catch(() => null) as { missing?: unknown; unverified?: unknown; error?: unknown } | null
      const read = (v: unknown) => Array.isArray(v) ? v.filter(x => x && typeof x === 'object' && typeof (x as { pt?: unknown }).pt === 'string' && typeof (x as { en?: unknown }).en === 'string') as { pt: string; en: string }[] : []
      const nextMissing = read(body?.missing), nextUnverified = read(body?.unverified)
      setMissing(nextMissing); setUnverified(nextUnverified)
      if (!response.ok) { setError(typeof body?.error === 'string' ? body.error : (pt ? 'Não foi possível salvar a chave.' : 'Could not save the key.')); return }
      setKey('')
      if (!nextMissing.length && !nextUnverified.length) onChanged()
      else void refreshApiUsage()
    } catch { setError(pt ? 'Não foi possível salvar a chave.' : 'Could not save the key.') }
    finally { setBusy(false) }
  }
  const remove = async () => {
    if (busy) return
    setBusy(true)
    try { const response = await fetch(config.endpoint, { method: 'DELETE' }); if (response.ok) onChanged(); else setError(pt ? 'Não foi possível remover a chave.' : 'Could not remove the key.') }
    catch { setError(pt ? 'Não foi possível remover a chave.' : 'Could not remove the key.') }
    finally { setBusy(false) }
  }
  const requirements = config.requirements ?? []
  return <ConfirmModal open={open} onCancel={onClose} onConfirm={() => { void save() }} busy={busy || !key} tone="default" mobileSheet maxWidth={520}
    title={pt ? `Configurar ${item.label}` : `Configure ${item.label}`} message={pt ? 'A chave fica somente no serviço local. Ela nunca é exibida nem guardada nesta página.' : 'The key stays in the local service. It is never displayed or stored by this page.'}
    confirmLabel={config.status === 'set' ? (pt ? 'Trocar' : 'Change') : (pt ? 'Salvar' : 'Save')} cancelLabel={pt ? 'Cancelar' : 'Cancel'}>
    <div data-api-key-dialog style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {config.createUrl && <a href={config.createUrl} target="_blank" rel="noreferrer" data-api-create-link>{pt ? 'Criar chave ↗' : 'Create key ↗'}</a>}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, color: 'var(--text-secondary)' }}>
        {pt ? 'Chave' : 'Key'}
        <input data-api-key-input type="password" value={key} autoComplete="new-password" onInput={e => setKey(e.currentTarget.value)} placeholder={config.status === 'set' ? (pt ? 'Digite para trocar' : 'Type to change') : undefined} style={{ width: '100%', boxSizing: 'border-box', padding: '10px 11px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-primary)', fontSize: 16 }} />
      </label>
      {config.status === 'set' && <button type="button" data-api-key-remove disabled={busy} onClick={() => { void remove() }} style={{ ...dialogButtonStyle('danger', false, busy), alignSelf: 'flex-start' }}>{pt ? 'Remover' : 'Remove'}</button>}
      {requirements.length > 0 && <div data-api-requirements style={{ fontSize: 12, color: 'var(--text-secondary)' }}><b>{pt ? 'Permissões' : 'Requirements'}</b><ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{requirements.map((r, i) => <li key={i}>{r.label[lang]} — {r.level[lang]}{r.required ? ` · ${pt ? 'obrigatório' : 'required'}` : ` · ${pt ? 'opcional' : 'optional'}`}</li>)}</ul></div>}
      {config.pricingUrl && <a href={config.pricingUrl} target="_blank" rel="noreferrer" data-api-pricing-link>{pt ? 'Ver preços ↗' : 'View pricing ↗'}</a>}
      {config.notes && <ul data-api-plan-notes style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--text-secondary)' }}>{config.notes.map((n, i) => <li key={i}>{n[lang]}</li>)}</ul>}
      {missing.length > 0 && <div data-api-missing role="alert" style={{ color: 'var(--anthropic-orange)', fontSize: 12 }}><b>{pt ? 'Permissões ausentes' : 'Missing permissions'}</b><ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{missing.map((m, i) => <li key={i}>{m[lang]}</li>)}</ul></div>}
      {unverified.length > 0 && <div data-api-unverified role="status" style={{ color: 'var(--text-secondary)', fontSize: 12 }}><b>{pt ? 'Não verificado' : 'Not verified'}</b><ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{unverified.map((m, i) => <li key={i}>{m[lang]}</li>)}</ul></div>}
      {error && <div data-api-key-error role="alert" style={{ color: 'var(--anthropic-orange)', fontSize: 12 }}>{error}</div>}
    </div>
  </ConfirmModal>
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
