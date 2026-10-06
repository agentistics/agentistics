/**
 * AuthPolicyTable — "What each action asks" (owner decision 2026-10-06): one row per kind of vault
 * action and the confirmation it asks. The SERVER decides everything here — which choices a row may
 * take (a critical row never offers "nothing"), what an absent choice means, and it refuses an invalid
 * policy on its own; this table only draws `view.authPolicy` and sends the draft through the gate
 * dialog (`GateDialog` kind 'auth-policy'), whose proof is the CURRENT 'settings' row.
 *
 * "Open the vault" leads the table but is not a choice of its own: the unlock policy already has the
 * three honest modes for an unlock, so its row states the mode and opens that editor.
 */
import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { Select } from '../../pages/settings/primitives'
import { Gate, presWordOf, unlockModeKey } from './VaultFlows'
import { vt, vtf, type VaultKey } from '../../lib/vaultText'
import { authPolicyDraft, authPolicyDiff, type ActionKind, type AuthPolicyRow, type ProofChoice, type VaultView } from '../../lib/vaultApi'

type Lang = 'en' | 'pt'
const kindKey = (k: ActionKind) => `ap_k_${k.replace(/-/g, '_')}` as VaultKey
const choiceKey = (c: ProofChoice) => `ap_c_${c}` as VaultKey

export function AuthPolicyTable({ view, lang, isMobile, gate, btn, onSave, onOpenUnlock }: {
  view: VaultView; lang: Lang; isMobile: boolean; gate: { code: boolean; gesture: boolean }; btn: React.CSSProperties
  onSave: (draft: Partial<Record<ActionKind, ProofChoice>>) => void
  /** Opens the unlock policy's own editor (the "Open the vault" row). */
  onOpenUnlock?: () => void
}) {
  const rows: AuthPolicyRow[] = view.authPolicy?.rows ?? []
  const pres = presWordOf(view, lang)
  const initial = useMemo(() => authPolicyDraft(rows), [rows])
  const [draft, setDraft] = useState(initial)
  useEffect(() => { setDraft(initial) }, [initial])
  const changed = authPolicyDiff(rows, draft) > 0
  const label = (c: ProofChoice) => vt(choiceKey(c), lang).replace(/\{presence\}/g, pres)
  const unlock = view.unlockPolicy
  const missing = view.authenticator === null || !view.presence

  const cell: React.CSSProperties = { padding: isMobile ? '12px 0' : '10px 12px', borderTop: '1px solid var(--border)', minWidth: 0 }
  const name = (title: string, desc: string, tag?: React.ReactNode) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{title}{tag}</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, marginTop: 2 }}>{desc}</div>
    </div>
  )
  const criticalTag = (
    <span title={vt('ap_critical_hint', lang)} style={{ fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '1px 6px', borderRadius: 999, color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
      {vt('ap_critical', lang)}
    </span>
  )
  const grid: React.CSSProperties = isMobile
    ? { display: 'grid', gridTemplateColumns: '1fr' }
    : { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(220px, 280px)', alignItems: 'center' }

  return (
    <form data-vault-auth-policy onSubmit={e => { e.preventDefault(); if (changed) onSave(draft) }}>
      {view.authPolicy?.state === 'unreadable' && (
        <div role="alert" style={{ fontSize: 12, color: 'var(--accent-red)', lineHeight: 1.5, marginBottom: 10 }}>{vt('ap_unreadable', lang)}</div>
      )}
      <div role="table" aria-label={vt('ap_title', lang)} style={grid}>
        {!isMobile && (
          <div role="row" style={{ display: 'contents' }}>
            <div role="columnheader" style={{ ...cell, borderTop: 'none', fontSize: 11.5, color: 'var(--text-tertiary)', paddingTop: 0 }}>{vt('ap_col_action', lang)}</div>
            <div role="columnheader" style={{ ...cell, borderTop: 'none', fontSize: 11.5, color: 'var(--text-tertiary)', paddingTop: 0 }}>{vt('ap_col_proof', lang)}</div>
          </div>
        )}
        {unlock && (
          <div role="row" style={{ display: 'contents' }} data-kind="open">
            <div role="cell" style={{ ...cell, ...(isMobile ? { paddingBottom: 6 } : null) }}>{name(vt('ap_k_open', lang), vtf('ap_k_open_d', lang, { presence: pres }), criticalTag)}</div>
            <div role="cell" style={{ ...cell, ...(isMobile ? { borderTop: 'none', paddingTop: 0 } : null), display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{vt(unlockModeKey(unlock.mode), lang).replace('{presence}', pres)}</span>
              {onOpenUnlock && <button type="button" style={{ ...btn, minHeight: isMobile ? 44 : undefined }} onClick={onOpenUnlock}>{vt('ap_k_open_btn', lang)}</button>}
            </div>
          </div>
        )}
        {rows.map(r => (
          <div role="row" key={r.kind} style={{ display: 'contents' }} data-kind={r.kind}>
            <div role="cell" style={{ ...cell, ...(isMobile ? { paddingBottom: 6 } : null) }}>{name(vt(kindKey(r.kind), lang), vt(`${kindKey(r.kind)}_d` as VaultKey, lang), r.critical ? criticalTag : undefined)}</div>
            <div role="cell" style={{ ...cell, ...(isMobile ? { borderTop: 'none', paddingTop: 0 } : null) }}>
              <Select
                value={draft[r.kind] ?? r.choice}
                onChange={v => setDraft(d => ({ ...d, [r.kind]: v as ProofChoice }))}
                options={r.choices.map(c => ({ value: c, label: c === r.default ? `${label(c)} · ${vt('ap_default_tag', lang)}` : label(c) }))}
              />
            </div>
          </div>
        ))}
      </div>
      {missing && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5, marginTop: 10 }}>{vt('ap_missing', lang)}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
        <button type="submit" style={btn} disabled={!changed}>{vt('ap_save', lang)} <Gate code={gate.code} gesture={gate.gesture} lang={lang} /></button>
        {authPolicyDiff(rows.map(r => ({ ...r, choice: r.default })), draft) > 0 && (
          <button type="button" style={{ ...btn, ...linkBtn }} onClick={() => setDraft(Object.fromEntries(rows.map(r => [r.kind, r.default])) as Partial<Record<ActionKind, ProofChoice>>)}>
            {vt('ap_reset', lang)}
          </button>
        )}
      </div>
    </form>
  )
}

const linkBtn: React.CSSProperties = { background: 'transparent', border: '1px solid transparent', color: 'var(--text-secondary)' }
