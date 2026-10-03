/**
 * The `:vault` picker (VAULT.PERSONAL §8.5): choose credentials and/or whole groups to hand to THIS
 * session's agent. Metadata only — no value is ever fetched here. A locked vault runs the unlock first
 * (the gesture in the service, then the code when the policy asks); a list that needs the code asks it.
 * Full screen on a phone. `VaultCodeAsk` is the small code prompt the composer shows when the grant
 * itself asks for the code at send time.
 */
import { useEffect, useMemo, useState } from 'react'
import { Folder, KeyRound, Loader2, Lock } from 'lucide-react'
import { Err, card, input, overlay, primaryBtn } from '../MfaSetup'
import { cleanCode, codeComplete, loadVault, stepUp, unlockCode, unlockGesture } from '../../lib/vaultApi'
import { filterPersonal, listPersonal, type PersonalGroup, type PersonalMeta } from '../../lib/vaultPersonal'
import type { VaultSelection } from '../../lib/vaultChip'

type Lang = 'en' | 'pt'
const T = {
  title: { en: 'Hand secrets to this session', pt: 'Liberar segredos para esta sessão' },
  intro: {
    en: 'The agent gets REFERENCES (vault://…) and uses them in commands; it never sees a value, and any value that shows up in an output is replaced. Sending asks you to confirm.',
    pt: 'O agente recebe REFERÊNCIAS (vault://…) e as usa nos comandos; ele nunca vê um valor, e qualquer valor que aparecer numa saída é trocado. Enviar pede a sua confirmação.',
  },
  locked: { en: 'The vault is locked.', pt: 'O cofre está trancado.' },
  unlock: { en: 'Unlock', pt: 'Destrancar' },
  unlocking: { en: 'Confirm on this computer…', pt: 'Confirme neste computador…' },
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

function CodeInput({ lang, isMobile, onCode, error }: { lang: Lang; isMobile: boolean; onCode: (c: string) => Promise<void>; error?: string | null }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <form onSubmit={e => { e.preventDefault(); if (codeComplete(code) && !busy) { setBusy(true); void onCode(code).finally(() => { setBusy(false); setCode('') }) } }}>
      <input value={code} onChange={e => setCode(cleanCode(e.target.value))} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6}
        aria-label={t('code', lang)} style={{ ...input, minHeight: isMobile ? 44 : undefined }} />
      {error && <Err text={error} />}
      <button type="submit" disabled={busy || !codeComplete(code)} style={{ ...primaryBtn, minHeight: isMobile ? 44 : undefined }}>{t('confirmCode', lang)}</button>
    </form>
  )
}

export function VaultPicker({ lang, isMobile, initial, onConfirm, onClear, onClose }: {
  lang: Lang; isMobile: boolean; initial: VaultSelection | null
  onConfirm: (sel: VaultSelection) => void; onClear: () => void; onClose: () => void
}) {
  type Phase = 'loading' | 'locked' | 'unlock-code' | 'list-code' | 'ready' | 'failed'
  const [phase, setPhase] = useState<Phase>('loading')
  const [items, setItems] = useState<PersonalMeta[]>([])
  const [groups, setGroups] = useState<PersonalGroup[]>([])
  const [q, setQ] = useState('')
  const [pick, setPick] = useState<Set<string>>(() => new Set(initial?.items.map(i => i.id) ?? []))
  const [pickG, setPickG] = useState<Set<string>>(() => new Set(initial?.groups.map(g => g.id) ?? []))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const v = await loadVault()
    if (v.kind === 'failed') { setPhase('failed'); return }
    if (v.view.state !== 'open') { setPhase(v.view.pendingStepup ? 'unlock-code' : 'locked'); return }
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
      {phase === 'loading' && <Loader2 size={14} className="ag-spin" />}
      {phase === 'failed' && <Err text={t('failed', lang)} />}
      {phase === 'locked' && (
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 8 }}><Lock size={14} /> {t('locked', lang)}</div>
          <button type="button" disabled={busy} style={{ ...primaryBtn, width: 'auto', minHeight: isMobile ? 44 : undefined }} onClick={() => {
            setBusy(true); setError(null)
            void unlockGesture().then(async r => {
              setBusy(false)
              if (!r.ok) { setError(r.sentence); return }
              if (r.state === 'pending-stepup') setPhase('unlock-code'); else await load()
            })
          }}>{busy ? t('unlocking', lang) : t('unlock', lang)}</button>
          {error && <Err text={error} />}
        </div>
      )}
      {phase === 'unlock-code' && <CodeInput lang={lang} isMobile={isMobile} error={error} onCode={async c => { const r = await unlockCode(c); if (!r.ok) { setError(r.sentence); setPhase('locked'); return } await load() }} />}
      {phase === 'list-code' && <CodeInput lang={lang} isMobile={isMobile} error={error} onCode={async c => { const r = await stepUp(c); if (!r.ok) { setError(r.sentence); return } setError(null); await load() }} />}
      {phase === 'ready' && (
        <>
          {items.length === 0 ? <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('none', lang)}</div> : (
            <>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('search', lang)} aria-label={t('search', lang)} autoFocus
                style={{ ...input, letterSpacing: 'normal', minHeight: isMobile ? 44 : undefined }} />
              {groups.length > 0 && <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '8px 0 2px' }}>{t('groups', lang)}</div>}
              {groups.filter(g => !q || g.name.toLowerCase().includes(q.toLowerCase())).map(g => (
                <label key={g.id} style={row}>
                  <input type="checkbox" checked={pickG.has(g.id)} onChange={() => toggle(pickG, g.id, setPickG)} />
                  <Folder size={14} style={{ color: 'var(--anthropic-orange)' }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13.5 }}>{g.name}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{t('count', lang, items.filter(i => i.groupId === g.id).length)}</span>
                </label>
              ))}
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '10px 0 2px' }}>{t('items', lang)}</div>
              {shown.map(i => (
                <label key={i.id} style={row}>
                  <input type="checkbox" checked={pick.has(i.id)} onChange={() => toggle(pick, i.id, setPick)} />
                  <KeyRound size={14} style={{ color: 'var(--anthropic-orange)' }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, overflowWrap: 'anywhere' }}>{i.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{i.kind}</span>
                </label>
              ))}
            </>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button type="button" onClick={confirm} disabled={pick.size === 0 && pickG.size === 0} style={{ ...primaryBtn, width: 'auto', flex: 1, minHeight: isMobile ? 44 : undefined }}>{t('confirm', lang)}</button>
            {initial && <button type="button" onClick={onClear} style={{ ...primaryBtn, width: 'auto', color: 'var(--text-secondary)', borderColor: 'var(--border)', background: 'transparent', minHeight: isMobile ? 44 : undefined }}>{t('clear', lang)}</button>}
          </div>
        </>
      )}
      <button type="button" onClick={onClose} style={{ marginTop: 10, background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontFamily: 'inherit', padding: isMobile ? '12px 0' : '4px 0' }}>{t('cancel', lang)}</button>
    </Shell>
  )
}

/** The code the grant asks at send time (resolve with the code, or null when cancelled). */
export function VaultCodeAsk({ lang, isMobile, onDone }: { lang: Lang; isMobile: boolean; onDone: (code: string | null) => void }) {
  return (
    <Shell isMobile={isMobile} title={t('code', lang)} onClose={() => onDone(null)}>
      <CodeInput lang={lang} isMobile={isMobile} onCode={async c => { onDone(c) }} />
    </Shell>
  )
}
