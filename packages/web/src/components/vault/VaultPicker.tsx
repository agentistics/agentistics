import { AgentisticsLoader } from '../../components/AgentisticsLoader'
/**
 * The `:vault` picker (VAULT.PERSONAL §8.5): choose credentials and/or whole groups to hand to THIS
 * session's agent. Metadata only — no value is ever fetched here. A locked vault runs the unlock first
 * (the gesture in the service, then the code when the policy asks); a list that needs the code asks it.
 * Full screen on a phone. `VaultCodeAsk` is the small code prompt the composer shows when the grant
 * itself asks for the code at send time.
 */
import { useEffect, useMemo, useState } from 'react'
import { Folder, KeyRound } from 'lucide-react'
import { Err, card, input, overlay } from '../MfaSetup'
import { codeComplete, loadVault, stepUp } from '../../lib/vaultApi'
import { CodeField } from './VaultUnlock'
import { VaultStage } from './VaultStage'
import { Checkbox, DialogActions, dialogButtonStyle } from '../../pages/settings/primitives'
import { filterPersonal, listPersonal, type PersonalGroup, type PersonalMeta } from '../../lib/vaultPersonal'
import type { VaultSelection } from '../../lib/vaultChip'
import { pt_, type PKey } from '../../lib/personalText'

type Lang = 'en' | 'pt'
const T = {
  title: { en: 'Hand secrets to this session', pt: 'Liberar segredos para esta sessão' },
  intro: {
    en: 'The agent gets REFERENCES (vault://…) and uses them in commands; it never sees a value, and any value that shows up in an output is replaced. Sending is immediate when the vault is open, unless a credential requires step-up confirmation.',
    pt: 'O agente recebe REFERÊNCIAS (vault://…) e as usa nos comandos; ele nunca vê um valor, e qualquer valor que aparecer numa saída é trocado. Enviar é imediato com o cofre aberto, salvo quando uma credencial exige confirmação adicional.',
  },
  code: { en: 'Authenticator code', pt: 'Código do autenticador' },
  confirmCode: { en: 'Confirm', pt: 'Confirmar' },
  search: { en: 'Search…', pt: 'Buscar…' },
  groups: { en: 'Groups', pt: 'Grupos' },
  items: { en: 'Credentials', pt: 'Credenciais' },
  none: { en: 'Your vault has no secrets yet. Add them on the Vault page.', pt: 'O seu cofre ainda não tem segredos. Adicione na página Cofre.' },
  confirm: { en: 'Confirm', pt: 'Confirmar' },
  clear: { en: 'Remove from the message', pt: 'Tirar da mensagem' },
  cancel: { en: 'Cancel', pt: 'Cancelar' },
  failed: { en: 'Could not read the vault on this computer.', pt: 'Não foi possível ler o cofre neste computador.' },
  count: { en: '{n} secret(s) in the group', pt: '{n} segredo(s) no grupo' },
} as const
const t = (k: keyof typeof T, lang: Lang, n?: number) => T[k][lang].replace('{n}', String(n ?? ''))

function Shell({ isMobile, title, onClose, children }: { isMobile: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h) }, [onClose])
  const o: React.CSSProperties = isMobile ? { ...overlay, padding: 0, zIndex: 3000 } : { ...overlay, zIndex: 3000 }
  const c: React.CSSProperties = isMobile
    ? { ...card, maxWidth: 'none', width: '100%', height: '100dvh', maxHeight: '100dvh', borderRadius: 0, border: 'none', overflowY: 'auto', boxSizing: 'border-box' }
    : { ...card, maxWidth: 520, maxHeight: '88vh', overflowY: 'auto', boxSizing: 'border-box' }
  return (
    <div style={o} role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div style={c} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 700, marginBottom: 8 }}><KeyRound size={16} /> {title}</div>
        {children}
      </div>
    </div>
  )
}

function CodeInput({ lang, isMobile, onCode, error, onCancel }: { lang: Lang; isMobile: boolean; onCode: (c: string) => Promise<void>; error?: string | null; onCancel?: () => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const ok = codeComplete(code) && !busy
  return (
    <form onSubmit={e => { e.preventDefault(); if (ok) { setBusy(true); void onCode(code).finally(() => { setBusy(false); setCode('') }) } }}>
      <CodeField value={code} onChange={setCode} label={t('code', lang)} autoFocus />
      {error && <Err text={error} />}
      <DialogActions>
        {onCancel && <button type="button" onClick={onCancel} style={dialogButtonStyle('secondary', isMobile)}>{t('cancel', lang)}</button>}
        <button type="submit" disabled={!ok} style={dialogButtonStyle('primary', isMobile, !ok)}>{busy && <AgentisticsLoader size={14} />} {t('confirmCode', lang)}</button>
      </DialogActions>
    </form>
  )
}

export function VaultPicker({ lang, isMobile, initial, onConfirm, onClear, onClose }: {
  lang: Lang; isMobile: boolean; initial: VaultSelection | null
  onConfirm: (sel: VaultSelection) => void; onClear: () => void; onClose: () => void
}) {
  type Phase = 'loading' | 'locked' | 'list-code' | 'ready' | 'failed'
  const [phase, setPhase] = useState<Phase>('loading')
  const [items, setItems] = useState<PersonalMeta[]>([])
  const [groups, setGroups] = useState<PersonalGroup[]>([])
  const [q, setQ] = useState('')
  const [pick, setPick] = useState<Set<string>>(() => new Set(initial?.items.map(i => i.id) ?? []))
  const [pickG, setPickG] = useState<Set<string>>(() => new Set(initial?.groups.map(g => g.id) ?? []))
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    const v = await loadVault()
    if (v.kind === 'failed') { setPhase('failed'); return }
    if (v.view.state !== 'open') { setPhase('locked'); return }
    const r = await listPersonal()
    if (r.ok) { setItems(r.items.filter(i => !i.deletedAt)); setGroups(r.groups); setPhase('ready'); return }
    setPhase(r.code === 'stepup-required' || r.status === 401 ? 'list-code' : 'failed')
  }
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => filterPersonal(items, groups, { q, kind: 'all', groupId: 'all', trash: false }), [items, groups, q])
  const toggle = (set: Set<string>, id: string, upd: (s: Set<string>) => void) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); upd(n) }
  const confirm = () => onConfirm({
    items: items.filter(i => pick.has(i.id)).map(i => ({ id: i.id, name: i.name })),
    groups: groups.filter(g => pickG.has(g.id)).map(g => ({ id: g.id, name: g.name })),
  })
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: isMobile ? '10px 4px' : '6px 4px', minHeight: isMobile ? 44 : undefined, cursor: 'pointer', borderTop: '1px solid var(--border)' }

  return (
    <Shell isMobile={isMobile} title={t('title', lang)} onClose={onClose}>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>{t('intro', lang)}</div>
      {phase === 'loading' && <AgentisticsLoader size={14} />}
      {phase === 'failed' && <Err text={t('failed', lang)} />}
      {/* §10: the shared unlock — Hello + code on this computer, the phone's own ways on a phone. */}
      {phase === 'locked' && <VaultStage lang={lang} isMobile={isMobile} compact onOpened={() => { void load() }} />}
      {phase === 'list-code' && <CodeInput lang={lang} isMobile={isMobile} error={error} onCode={async c => { const r = await stepUp(c); if (!r.ok) { setError(r.sentence); return } setError(null); await load() }} />}
      {phase === 'ready' && (
        <>
          {items.length === 0 ? <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('none', lang)}</div> : (
            <>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('search', lang)} aria-label={t('search', lang)} autoFocus
                style={{ ...input, letterSpacing: 'normal', minHeight: isMobile ? 44 : undefined }} />
              {groups.length > 0 && <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '8px 0 2px' }}>{t('groups', lang)}</div>}
              {groups.filter(g => !q || g.name.toLowerCase().includes(q.toLowerCase())).map(g => (
                <div key={g.id} style={row} onClick={() => toggle(pickG, g.id, setPickG)}>
                  <Checkbox checked={pickG.has(g.id)} onChange={() => toggle(pickG, g.id, setPickG)} label="" ariaLabel={g.name} />
                  <Folder size={14} style={{ color: 'var(--anthropic-orange)' }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13.5 }}>{g.name}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{t('count', lang, items.filter(i => i.groupId === g.id).length)}</span>
                </div>
              ))}
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '10px 0 2px' }}>{t('items', lang)}</div>
              {shown.map(i => (
                <div key={i.id} style={row} onClick={() => toggle(pick, i.id, setPick)}>
                  <Checkbox checked={pick.has(i.id)} onChange={() => toggle(pick, i.id, setPick)} label="" ariaLabel={i.name} />
                  <KeyRound size={14} style={{ color: 'var(--anthropic-orange)' }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, overflowWrap: 'anywhere' }}>{i.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{pt_(`kind_${i.kind}` as PKey, lang)}</span>
                </div>
              ))}
            </>
          )}
        </>
      )}
      {/* Pinned to the bottom of the scrolling card: with 50+ secrets, "Confirm" must not sit at the
          end of the list (owner 08/10). Bottom/padding cancel the card's 22px padding. */}
      <div style={{ position: 'sticky', bottom: -22, margin: '0 -22px -22px', padding: '0 22px 22px', background: 'var(--bg-card)', borderTop: '1px solid var(--border)' }}>
        <DialogActions>
          <button type="button" onClick={onClose} style={dialogButtonStyle('secondary', isMobile)}>{t('cancel', lang)}</button>
          {phase === 'ready' && initial && <button type="button" onClick={onClear} style={dialogButtonStyle('secondary', isMobile)}>{t('clear', lang)}</button>}
          {phase === 'ready' && <button type="button" onClick={confirm} disabled={pick.size === 0 && pickG.size === 0} style={dialogButtonStyle('primary', isMobile, pick.size === 0 && pickG.size === 0)}>{t('confirm', lang)}</button>}
        </DialogActions>
      </div>
    </Shell>
  )
}

/** The code the grant asks at send time (resolve with the code, or null when cancelled). */
export function VaultCodeAsk({ lang, isMobile, onDone }: { lang: Lang; isMobile: boolean; onDone: (code: string | null) => void }) {
  return (
    <Shell isMobile={isMobile} title={t('code', lang)} onClose={() => onDone(null)}>
      <CodeInput lang={lang} isMobile={isMobile} onCode={async c => { onDone(c) }} onCancel={() => onDone(null)} />
    </Shell>
  )
}
