/**
 * NayEndSession.tsx — the "Encerrar" choice on a "not opened for a while" card.
 *
 * A reminder that a session has been sitting unopened is the moment somebody decides they are done
 * with it, so the card offers to end it — and NEVER blindly (owner, 2026-09-29):
 *  - a session already in a FOLDER says so, since that is where it will stay, and offers to end it
 *    or end and pin it;
 *  - a session in NO folder is offered a folder by the SAME rule the idle-review modal uses
 *    (`defaultGroupFor` in `@agentistics/core/idleSessions.ts`), plus: pick another folder with the
 *    Agentistics `Select`, create one by name, end without filing, or end and pin.
 *
 * Every path then goes through `StopSessionConfirm` — the very confirmation the session's own End
 * verb shows, including its question about the task part — and only its button runs anything.
 *
 * ORDER IS LOAD-BEARING, the rule `runIdlePlan` keeps: the session is FILED (or pinned) first and
 * ended only if that worked. Ending first would take the row away, and a filing that then failed
 * would leave a closed session in no folder with nothing on screen saying so. Filing goes through
 * `/api/session-groups`, whose `add` is `planGroupOp`'s MOVE rule (it leaves any other folder and
 * drops a pin); the shared preferences are then re-read so this page's own copy matches.
 */

import { useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { defaultGroupFor, sessionIdentityKey, type GroupSuggestion, type IdleCandidate } from '@agentistics/core'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { Select } from '../../pages/settings/primitives'
import { StopSessionConfirm } from '../tasks/StopSessionConfirm'
import { getSessionGroups, sessionGroupsServerSnapshot, subscribeSessionGroups } from '../../lib/sessionUserGroups'
import { isSessionPinned, togglePinnedSession } from '../../lib/pinnedSessions'
import { loadSharedPrefs } from '../../lib/sharedPref'
import { toIdleRow } from '../../lib/idleRows'
import type { FleetState } from '../../lib/fleet'

type Filing = { kind: 'existing'; groupId: string; name: string } | { kind: 'new'; name: string } | null

interface Plan { filing: Filing; pin: boolean; label: string }

export interface NayEndSessionProps {
  row: ControlSession
  rows: readonly ControlSession[]
  finishedTasks: readonly string[]
  lang: 'pt' | 'en'
  isMobile: boolean
  act: FleetState['act']
  /** The session ended (or a step failed): the card closes with this sentence. */
  onDone: (message: string, ended: boolean) => void
  onBack: () => void
}

async function fileSession(filing: Exclude<Filing, null>, sessionId: string): Promise<boolean> {
  try {
    const res = filing.kind === 'existing'
      ? await fetch(`/api/session-groups/${encodeURIComponent(filing.groupId)}/sessions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: sessionId }),
        })
      : await fetch('/api/session-groups', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: filing.name, sessions: [sessionId] }),
        })
    const out = await res.json().catch(() => null) as { ok?: boolean } | null
    if (!res.ok || out?.ok !== true) return false
    await loadSharedPrefs()
    return true
  } catch { return false }
}

export function NayEndSession({ row, rows, finishedTasks, lang, isMobile, act, onDone, onBack }: NayEndSessionProps) {
  const pt = lang === 'pt'
  const groupsValue = useSyncExternalStore(subscribeSessionGroups, getSessionGroups, sessionGroupsServerSnapshot)
  const groups = groupsValue.groups
  const key = sessionIdentityKey(row)
  const current = groups.find(g => g.sessionKeys.includes(key)) ?? null

  const suggestion: GroupSuggestion = useMemo(() => {
    const idleRows = rows.map(r => toIdleRow(r, finishedTasks))
    const candidate: IdleCandidate = { row: toIdleRow(row, finishedTasks), key, idleMs: 0, reasons: [] }
    return defaultGroupFor(candidate, groups, idleRows, row.task, new Date().toISOString().slice(0, 10))
  }, [rows, row, finishedTasks, groups, key])

  const [step, setStep] = useState<'choose' | 'pick' | 'create' | 'confirm'>('choose')
  const [picked, setPicked] = useState('')
  const [newName, setNewName] = useState(suggestion.name)
  const [nameError, setNameError] = useState<string | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const confirm = (p: Plan) => { setPlan(p); setStep('confirm') }
  const btn: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: isMobile ? '10px 12px' : '6px 10px',
    minHeight: isMobile ? 44 : 32, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-elevated)',
    color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 500, cursor: 'pointer', textAlign: 'left',
  }
  const wide: CSSProperties = { ...btn, width: '100%', justifyContent: 'flex-start' }
  const hint: CSSProperties = { fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }

  const run = async () => {
    if (!plan) return
    setBusy(true)
    if (plan.filing && !(await fileSession(plan.filing, row.id))) {
      setBusy(false)
      setNotice(pt ? 'Não consegui guardar na pasta. A sessão continua aberta.' : 'Could not file it into the folder. The session is still running.')
      return
    }
    if (plan.pin && !isSessionPinned(key)) {
      const pinned = togglePinnedSession(key)
      if (!pinned.ok) {
        setBusy(false)
        setNotice(pt ? 'Já há 10 sessões fixadas. Desafixe uma e tente de novo; nada foi encerrado.' : 'There are already 10 pinned sessions. Unpin one and try again; nothing was ended.')
        return
      }
    }
    const out = await act({ id: row.id, action: 'kill' })
    setBusy(false)
    onDone(out.ok ? (pt ? `Encerrada: ${plan.label}.` : `Ended: ${plan.label}.`) : out.message, out.ok)
  }

  if (step === 'confirm' && plan) {
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        <span style={hint}>{pt ? 'Depois de encerrar: ' : 'After ending: '}<b style={{ color: 'var(--text-secondary)' }}>{plan.label}</b></span>
        {notice && <span role="alert" style={{ ...hint, color: 'var(--accent-red)' }}>{notice}</span>}
        <StopSessionConfirm
          title={row.title}
          sessionId={row.id}
          {...(row.task ? { task: row.task } : {})}
          lang={lang}
          busy={busy}
          onStop={run}
          onCancel={() => { setStep('choose'); setNotice(null) }}
          onNotice={setNotice}
          layout="stack"
          styles={{ danger: { ...btn, background: 'var(--accent-red)', borderColor: 'var(--accent-red)', color: '#fff' }, plain: btn }}
        />
      </div>
    )
  }

  if (step === 'pick') {
    const options = groups.map(g => ({ value: g.id, label: g.name }))
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        <span style={hint}>{pt ? 'Guardar em qual pasta?' : 'File it in which folder?'}</span>
        {options.length === 0
          ? <span style={hint}>{pt ? 'Ainda não existe nenhuma pasta.' : 'There are no folders yet.'}</span>
          : <Select value={picked} onChange={setPicked} options={options} placeholder={pt ? 'Escolha uma pasta' : 'Choose a folder'} />}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" style={btn} onClick={() => setStep('choose')}>{pt ? 'Voltar' : 'Back'}</button>
          <button type="button" style={{ ...btn, opacity: picked ? 1 : 0.5 }} disabled={!picked} onClick={() => {
            const g = groups.find(x => x.id === picked)
            if (g) confirm({ filing: { kind: 'existing', groupId: g.id, name: g.name }, pin: false, label: pt ? `guardada em ${g.name}` : `filed in ${g.name}` })
          }}>{pt ? 'Encerrar e guardar' : 'End and file'}</button>
        </div>
      </div>
    )
  }

  if (step === 'create') {
    return (
      <form style={{ display: 'grid', gap: 8 }} onSubmit={e => {
        e.preventDefault()
        const name = newName.trim()
        if (!name) { setNameError(pt ? 'Dê um nome à pasta.' : 'Give the folder a name.'); return }
        if (groups.some(g => g.name.toLowerCase() === name.toLowerCase())) {
          setNameError(pt ? 'Já existe uma pasta com esse nome. Escolha-a em “Escolher pasta…”.' : 'A folder with that name exists. Pick it under “Choose folder…”.')
          return
        }
        confirm({ filing: { kind: 'new', name }, pin: false, label: pt ? `guardada na nova pasta ${name}` : `filed in the new folder ${name}` })
      }}>
        <label style={hint} htmlFor="nay-new-folder">{pt ? 'Nome da nova pasta' : 'New folder name'}</label>
        <input id="nay-new-folder" value={newName} autoFocus onChange={e => { setNewName(e.target.value); setNameError(null) }}
          style={{
            fontFamily: 'inherit', fontSize: isMobile ? 16 : 13, padding: '7px 9px', borderRadius: 8,
            border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-primary)', minWidth: 0,
          }} />
        {nameError && <span role="alert" style={{ ...hint, color: 'var(--accent-red)' }}>{nameError}</span>}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" style={btn} onClick={() => setStep('choose')}>{pt ? 'Voltar' : 'Back'}</button>
          <button type="submit" style={btn}>{pt ? 'Criar pasta e guardar' : 'Create folder and file'}</button>
        </div>
      </form>
    )
  }

  const pinPlan: Plan = { filing: null, pin: true, label: pt ? 'fixada' : 'pinned' }
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {current ? (
        <>
          <span style={hint}>
            {pt ? 'Ela já está na pasta ' : 'It is already in the folder '}
            <b style={{ color: 'var(--text-secondary)' }}>{current.name}</b>
            {pt ? ' e vai ficar guardada lá.' : ' and will stay filed there.'}
          </span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" style={{ ...btn, color: 'var(--accent-red)' }}
              onClick={() => confirm({ filing: null, pin: false, label: pt ? `guardada em ${current.name}` : `filed in ${current.name}` })}>
              {pt ? 'Encerrar' : 'End'}
            </button>
            <button type="button" style={btn} onClick={() => confirm(pinPlan)}>{pt ? 'Encerrar e fixar' : 'End and pin'}</button>
          </div>
        </>
      ) : (
        <>
          <span style={hint}>
            {pt ? 'Não está em nenhuma pasta. Sugestão: ' : 'It is in no folder. Suggested: '}
            <b style={{ color: 'var(--text-secondary)' }}>{suggestion.name}</b>
            {suggestion.kind === 'new' ? (pt ? ' (pasta nova)' : ' (new folder)') : ''}
          </span>
          <button type="button" style={wide} onClick={() => confirm({
            filing: suggestion.kind === 'existing' ? { kind: 'existing', groupId: suggestion.groupId, name: suggestion.name } : { kind: 'new', name: suggestion.name },
            pin: false, label: pt ? `guardada em ${suggestion.name}` : `filed in ${suggestion.name}`,
          })}>
            {pt ? `Encerrar e guardar em ${suggestion.name}` : `End and file in ${suggestion.name}`}
          </button>
          <button type="button" style={wide} onClick={() => setStep('pick')}>{pt ? 'Escolher pasta…' : 'Choose folder…'}</button>
          <button type="button" style={wide} onClick={() => setStep('create')}>{pt ? 'Criar pasta e guardar' : 'Create folder and file'}</button>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" style={{ ...btn, color: 'var(--accent-red)' }}
              onClick={() => confirm({ filing: null, pin: false, label: pt ? 'sem pasta' : 'no folder' })}>
              {pt ? 'Só encerrar' : 'Just end'}
            </button>
            <button type="button" style={btn} onClick={() => confirm(pinPlan)}>{pt ? 'Encerrar e fixar' : 'End and pin'}</button>
          </div>
        </>
      )}
      <button type="button" style={{ ...btn, border: 'none', background: 'transparent', color: 'var(--text-tertiary)', justifySelf: 'start' }} onClick={onBack}>
        {pt ? 'Voltar' : 'Back'}
      </button>
    </div>
  )
}
