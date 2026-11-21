/**
 * Browser settings (NAVEGADOR S12) — the switch for the built-in browser, what it is using now, which
 * executable it found, "Delete profiles", and which harnesses do not get its tools.
 *
 * Same pattern as `ChatSettings`: ON unless someone turns it off (`browser-gate.ts`), the switch can only
 * NARROW the exposure profile (`capabilities.localShell`), and the SERVER refuses with the switch off —
 * which also answers `/api/browser/status` 403, so with the switch off the numbers rows simply are not drawn.
 * Every threshold comes from `GET /api/browser/status` (the server's `browser-spec.ts`).
 */
import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { AppContext } from '../../lib/app-context'
import { SectionHeader, Divider, PrefRow, Toggle, Button, ConfirmModal } from './primitives'
import {
  ceilingSentence, executableLine, fmtBytes, harnessLines, memoryLines, profilesRow, totalBytes,
  type BrowserStatusView,
} from '../../lib/browserSettings'

const TONE_COLOR = { ok: 'var(--text-secondary)', trim: '#f59e0b', kill: '#ef4444' } as const

export default function BrowserSettings() {
  const ctx = useOutletContext<AppContext>()
  const pt = ctx.lang === 'pt'

  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [capable, setCapable] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<BrowserStatusView | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/browser/status')
      setStatus(r.ok ? (await r.json()) as BrowserStatusView : null)
    } catch { setStatus(null) }
  }, [])

  useEffect(() => {
    void (async () => {
      const [prefs, session] = await Promise.all([
        fetch('/api/preferences').then(r => (r.ok ? r.json() : {}) as Promise<{ browserEnabled?: boolean }>).catch(() => ({}) as { browserEnabled?: boolean }),
        fetch('/api/session').then(r => (r.ok ? r.json() : {}) as Promise<{ capabilities?: { localShell?: boolean } }>).catch(() => ({}) as { capabilities?: { localShell?: boolean } }),
      ])
      // Absent reads as ON (`browser-gate.ts`); only an explicit false is off.
      const on = prefs.browserEnabled !== false
      setEnabled(on)
      setCapable(session.capabilities?.localShell !== false)
      if (on) await loadStatus()
    })()
  }, [loadStatus])

  const toggle = useCallback(async () => {
    if (enabled === null || !capable) return
    const next = !enabled
    setSaving(true)
    setEnabled(next)
    try {
      await fetch('/api/preferences', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ browserEnabled: next }),
      })
      if (next) await loadStatus(); else setStatus(null)
    } catch {
      setEnabled(!next)
    } finally {
      setSaving(false)
    }
  }, [enabled, capable, loadStatus])

  const deleteProfiles = useCallback(async () => {
    setBusy(true)
    try {
      const r = await fetch('/api/browser/profiles/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const body = await r.json().catch(() => ({})) as { ok?: boolean; removed?: number; sentence?: string }
      setNotice(r.ok
        ? (pt ? `${body.removed ?? 0} perfil(is) apagado(s).` : `${body.removed ?? 0} profile(s) deleted.`)
        : (body.sentence ?? (pt ? 'Não foi possível apagar os perfis.' : 'Could not delete the profiles.')))
    } catch {
      setNotice(pt ? 'Não foi possível apagar os perfis.' : 'Could not delete the profiles.')
    } finally {
      setBusy(false); setConfirm(false); await loadStatus()
    }
  }, [pt, loadStatus])

  const lines = status ? memoryLines(status.live, pt) : []
  const total = status ? totalBytes(status.live) : null
  const exe = status ? executableLine(status.executable, pt) : null
  const prof = status ? profilesRow(status, pt) : null

  return (
    <>
      <SectionHeader label={pt ? 'Navegador embutido' : 'Built-in browser'} />

      <PrefRow
        label={pt ? 'Habilitar o navegador' : 'Enable the browser'}
        sub={capable
          ? (pt
            ? 'Ligado por padrão. Deixa o modelo navegar em um Chromium desta máquina; desligue para fechar essa porta.'
            : 'On by default. It lets the model browse in a Chromium on this machine; turn it off to close that door.')
          : (pt
            ? 'Indisponível: o perfil de exposição desta instância não permite executar nada no host.'
            : 'Unavailable: this instance’s exposure profile does not allow running anything on the host.')}
      >
        <Toggle
          on={enabled === true}
          onToggle={() => { void toggle() }}
          disabled={!capable || enabled === null || saving}
          label={pt ? 'Habilitar o navegador' : 'Enable the browser'}
        />
      </PrefRow>

      {enabled === true && status && exe && prof && (
        <>
          <Divider />
          <SectionHeader label={pt ? 'Uso de memória' : 'Memory use'} />
          {lines.length === 0 && (
            <PrefRow label={pt ? 'Nenhum navegador aberto' : 'No browser open'}
              sub={pt ? 'O Chromium só sobe quando alguém o usa.' : 'Chromium only starts when someone uses it.'}>
              <span />
            </PrefRow>
          )}
          {lines.map(l => (
            <PrefRow key={l.label} label={l.label}>
              <span data-browser-memory style={{ fontSize: 13, fontWeight: 600, color: TONE_COLOR[l.tone] }}>{l.value}</span>
            </PrefRow>
          ))}
          {lines.length > 1 && total !== null && (
            <PrefRow label={pt ? 'Total' : 'Total'}>
              <span data-browser-total style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>{fmtBytes(total)}</span>
            </PrefRow>
          )}
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6, marginBottom: 14 }}>{ceilingSentence(status, pt)}</div>

          <Divider />
          <SectionHeader label={pt ? 'Executável' : 'Executable'} />
          <PrefRow label={exe.value} sub={exe.sub}><span /></PrefRow>

          <Divider />
          <SectionHeader label={pt ? 'Perfis' : 'Profiles'} />
          <PrefRow label={pt ? 'Apagar perfis' : 'Delete profiles'} sub={prof.sub}>
            <Button kind="danger" disabled={!prof.canDelete || busy} onClick={() => setConfirm(true)}>
              {pt ? 'Apagar perfis' : 'Delete profiles'}
            </Button>
          </PrefRow>
          {notice && <div data-browser-notice style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 14 }}>{notice}</div>}
          <ConfirmModal open={confirm} title={pt ? 'Apagar perfis?' : 'Delete profiles?'}
            message={pt ? 'Isto apaga os cookies e o cache guardados dos navegadores já encerrados. Você terá de entrar de novo nos sites.'
              : 'This deletes the cookies and cache stored for browsers already closed. You will have to sign in to sites again.'}
            confirmLabel={pt ? 'Apagar' : 'Delete'} cancelLabel={pt ? 'Cancelar' : 'Cancel'} busy={busy}
            onConfirm={() => { void deleteProfiles() }} onCancel={() => setConfirm(false)} />
        </>
      )}

      <Divider />
      <SectionHeader label={pt ? 'Assistentes' : 'Assistants'} />
      {harnessLines(pt).map(h => (
        <div key={h.id} data-browser-harness={h.id} style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6, marginBottom: 6 }}>
          <b style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{h.name}</b> — {h.text}
        </div>
      ))}
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6, marginTop: 8 }}>
        {pt
          ? 'O servidor é quem decide: com o navegador desligado, /api/browser responde 403. Esconder o botão não fecharia a porta.'
          : 'The server is what decides: with the browser off, /api/browser answers 403. Hiding the button would not close the door.'}
      </div>
    </>
  )
}
