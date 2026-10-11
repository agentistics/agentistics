import React, { useEffect, useState, useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Plus, Trash2, Settings } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { SectionHeader, Section, Select, Checkbox, ConfirmModal, RecordCard, RecordCardAction } from './primitives'
import { Drawer } from '../../components/Drawer'
import { useIsMobile } from '../../hooks/useIsMobile'
import { stepUpFetch } from '../../lib/stepup'

interface Team { _id: string; name: string }
interface Membership { teamId: string; role: 'manager' | 'user' }
interface Account { id: string; name: string; email: string; role: 'owner' | 'member'; memberships: Membership[] }
interface Machine {
  id: string; machineName: string; user: string; teamId?: string; teamIds?: string[]
  /** Teams the machine actually belongs to: own ∪ inherited from its owner accounts − excluded. */
  effectiveTeamIds?: string[]
  /** The subset of the above that came from an owner account rather than a direct link. */
  inheritedTeamIds?: string[]
  accountId?: string; accountIds?: string[]; accountName?: string; accountEmail?: string
  owners?: { id: string; name: string; email: string }[]
  lastSeenAt: string | null
}

/** A machine's EFFECTIVE team set. Adding an account to a team brings its machines along, so this
 *  must be the inherited-aware set — reading only `teamIds` is what let the same machine be added
 *  to a team it was already in, and left it out of that team's list. Falls back to the stored
 *  fields for a server that predates the effective ones. */
const machineTeams = (m: Machine): string[] =>
  m.effectiveTeamIds ?? m.teamIds ?? (m.teamId ? [m.teamId] : [])

/** True when the machine is in this team only because one of its owner accounts is. */
const inheritsTeam = (m: Machine, teamId: string): boolean =>
  (m.inheritedTeamIds ?? []).includes(teamId)

/** Badge marking a machine that joined the team through its owner account. */
const inheritedTag: React.CSSProperties = {
  padding: '1px 6px', borderRadius: 999, fontSize: 9.5, fontWeight: 700,
  letterSpacing: '0.04em', textTransform: 'uppercase',
  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
  color: 'var(--text-tertiary)', whiteSpace: 'nowrap',
}

// shared inline styles
const input: React.CSSProperties = {
  padding: '9px 11px', background: 'var(--bg-elevated)', border: '1px solid var(--border)',
  borderRadius: 7, fontSize: 13, color: 'var(--text-primary)', fontFamily: 'inherit',
  outline: 'none', width: '100%', boxSizing: 'border-box',
}
const primaryBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  padding: '8px 14px', borderRadius: 7, border: '1px solid var(--anthropic-orange)',
  background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)',
  fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
}
const ghostBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 7,
  border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
  fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
}
const th: React.CSSProperties = {
  textAlign: 'left', fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)',
  letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0 10px 8px', whiteSpace: 'nowrap',
}
const td: React.CSSProperties = {
  fontSize: 12.5, color: 'var(--text-secondary)', padding: '9px 10px',
  borderTop: '1px solid var(--border-subtle)', verticalAlign: 'middle',
}
const trashBtn: React.CSSProperties = {
  border: 'none', background: 'transparent', color: '#ef4444', cursor: 'pointer',
  display: 'inline-flex', padding: 4,
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{label}</span>
      {children}
    </label>
  )
}

// page
export default function TeamsSettings() {
  const { lang, me } = useOutletContext<AppContext>()
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const viewerIsOwner = me?.role === 'owner'
  const managedTeamIds = new Set((me?.memberships ?? []).filter(m => m.role === 'manager').map(m => m.teamId))

  const [teams, setTeams] = useState<Team[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [machines, setMachines] = useState<Machine[]>([])
  const [err, setErr] = useState<string | null>(null)
  // Single pending-confirm target for destructive actions (delete team / remove member / remove machine).
  const [confirm, setConfirm] = useState<{ kind: 'team' | 'member' | 'machine'; id: string; label: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const [t, a, m] = await Promise.all([
        fetch('/api/iam/teams').then(r => r.json() as Promise<{ teams: Team[] }>),
        fetch('/api/iam/accounts').then(r => r.json() as Promise<{ accounts: Account[] }>),
        fetch('/api/iam/machines').then(r => r.json() as Promise<{ machines: Machine[] }>),
      ])
      setTeams(t.teams ?? []); setAccounts(a.accounts ?? []); setMachines(m.machines ?? [])
    } catch (e) { setErr(String(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  // team create drawer
  const [teamOpen, setTeamOpen] = useState(false)
  const [teamName, setTeamName] = useState('')
  const [teamErr, setTeamErr] = useState<string | null>(null)
  // Optional member/machine editors in the create drawer: multi-select picks (bulk).
  const [newMembers, setNewMembers] = useState<{ accountId: string; role: 'manager' | 'user' }[]>([])
  const [newMachineIds, setNewMachineIds] = useState<string[]>([])

  function openTeamDrawer() {
    setTeamName('')
    setTeamErr(null)
    setNewMembers([])
    setNewMachineIds([])
    setTeamOpen(true)
  }
  async function createTeam() {
    if (!teamName.trim()) { setTeamErr(pt ? 'Informe o nome do time.' : 'Enter a team name.'); return }
    const res = await stepUpFetch('/api/iam/teams', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: teamName.trim() }),
    })
    if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; setTeamErr(d.error || `HTTP ${res.status}`); return }
    const created = await res.json().catch(() => ({})) as { team?: { _id: string } }
    const newId = created.team?._id
    if (newId) {
      // Attach chosen members sequentially (append to each account's memberships).
      for (const row of newMembers) {
        const account = accounts.find(a => a.id === row.accountId)
        if (!account) continue
        const existing = account.memberships.find(m => m.teamId === newId)
        const memberships = existing ? account.memberships : [...account.memberships, { teamId: newId, role: row.role }]
        const r = await stepUpFetch('/api/iam/accounts', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: row.accountId, memberships }),
        })
        if (!r.ok) { const d = await r.json().catch(() => ({})) as { error?: string }; setTeamErr(d.error || `HTTP ${r.status}`); void load(); return }
      }
      // Reassign chosen machines sequentially.
      for (const machineId of newMachineIds) {
        const r = await fetch('/api/iam/machines', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reassignId: machineId, addTeamId: newId }),
        })
        if (!r.ok) { const d = await r.json().catch(() => ({})) as { error?: string }; setTeamErr(d.error || `HTTP ${r.status}`); void load(); return }
      }
    }
    setTeamOpen(false); void load()
  }
  async function deleteTeam(id: string) {
    await stepUpFetch('/api/iam/teams', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    void load()
  }

  const memberCountOf = (teamId: string) =>
    accounts.filter(a => a.role !== 'owner' && a.memberships.some(m => m.teamId === teamId)).length

  // manage team drawer
  const [manageOpen, setManageOpen] = useState(false)
  const [manageTeamId, setManageTeamId] = useState<string | null>(null)
  const [manageErr, setManageErr] = useState<string | null>(null)
  // Bulk picks in the manage drawer: many accounts (each with its own role) / many machines at once.
  const [addAccounts, setAddAccounts] = useState<{ accountId: string; role: 'manager' | 'user' }[]>([])
  const [addMachineIds, setAddMachineIds] = useState<string[]>([])
  // Per-section edit toggle inside the (read-first) manage drawer. Only one section edits at a time.
  const [editingSection, setEditingSection] = useState<null | 'members' | 'machines'>(null)

  function openManageDrawer(teamId: string) {
    setManageTeamId(teamId)
    setManageErr(null)
    setAddAccounts([])
    setAddMachineIds([])
    setEditingSection(null)
    setManageOpen(true)
  }

  async function removeAccountFromTeam(accountId: string, teamId: string) {
    const account = accounts.find(a => a.id === accountId)
    if (!account) return
    const newMemberships = account.memberships.filter(m => m.teamId !== teamId)
    const res = await stepUpFetch('/api/iam/accounts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: accountId, memberships: newMemberships }),
    })
    if (!res.ok) { const d = await res.json() as { error?: string }; setManageErr(d.error || `HTTP ${res.status}`); return }
    void load()
  }

  // Bulk add: the selection is many, the requests stay sequential (one PATCH per account).
  async function addAccountsToTeam() {
    if (addAccounts.length === 0 || !manageTeamId) return
    for (const pick of addAccounts) {
      const account = accounts.find(a => a.id === pick.accountId)
      if (!account) continue
      const existing = account.memberships.find(m => m.teamId === manageTeamId)
      const newMemberships = existing
        ? account.memberships
        : [...account.memberships, { teamId: manageTeamId, role: pick.role }]
      const res = await stepUpFetch('/api/iam/accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pick.accountId, memberships: newMemberships }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; setManageErr(d.error || `HTTP ${res.status}`); void load(); return }
    }
    setAddAccounts([])
    void load()
  }

  // Update the role of a member already in the team (this team's membership only).
  async function changeMemberRole(accountId: string, role: 'manager' | 'user') {
    if (!manageTeamId) return
    const account = accounts.find(a => a.id === accountId)
    if (!account) return
    const newMemberships = account.memberships.map(m =>
      m.teamId === manageTeamId ? { ...m, role } : m)
    const res = await stepUpFetch('/api/iam/accounts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: accountId, memberships: newMemberships }),
    })
    if (!res.ok) { const d = await res.json() as { error?: string }; setManageErr(d.error || `HTTP ${res.status}`); return }
    void load()
  }

  async function removeMachineFromTeam(machineId: string) {
    if (!manageTeamId) return
    const res = await fetch('/api/iam/machines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reassignId: machineId, removeTeamId: manageTeamId }),
    })
    if (!res.ok) { const d = await res.json() as { error?: string }; setManageErr(d.error || `HTTP ${res.status}`); return }
    void load()
  }

  // Bulk add: the selection is many, the requests stay sequential (one reassign per machine).
  async function addMachinesToTeam() {
    if (addMachineIds.length === 0 || !manageTeamId) return
    for (const machineId of addMachineIds) {
      const res = await fetch('/api/iam/machines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reassignId: machineId, addTeamId: manageTeamId }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; setManageErr(d.error || `HTTP ${res.status}`); void load(); return }
    }
    setAddMachineIds([])
    void load()
  }

  const drawerErr = (m: string | null) => m && (
    <div style={{ fontSize: 12, color: '#ef4444', background: 'color-mix(in srgb, #ef4444 12%, transparent)', border: '1px solid color-mix(in srgb, #ef4444 35%, transparent)', borderRadius: 7, padding: '8px 10px' }}>{m}</div>
  )

  const canManageTeam = (teamId: string) => viewerIsOwner || managedTeamIds.has(teamId)
  const manageTeam = teams.find(t => t._id === manageTeamId)
  const canEditManage = manageTeamId ? canManageTeam(manageTeamId) : false
  // The Members/Machines sections persist each add/remove immediately, so their footer
  // must not imply a pending save — it just closes the editor.
  const manageSectionLabels = {
    edit: pt ? 'Editar' : 'Edit',
    save: pt ? 'Concluir' : 'Done',
    cancel: pt ? 'Fechar' : 'Close',
  }
  const teamMembers = manageTeamId ? accounts.filter(a => a.memberships.some(m => m.teamId === manageTeamId)) : []
  const teamMachines = manageTeamId ? machines.filter(m => machineTeams(m).includes(manageTeamId)) : []
  const eligibleAccounts = accounts.filter(a => {
    if (a.role === 'owner') return false
    if (manageTeamId && a.memberships.some(m => m.teamId === manageTeamId)) return false
    if (!viewerIsOwner) {
      // Manager: can only add accounts that are either (1) not yet in any team, or (2) only in teams they manage, as user
      if (a.memberships.length === 0) return true
      return a.memberships.every(m => m.role === 'user' && managedTeamIds.has(m.teamId))
    }
    return true
  })
  const eligibleMachines = manageTeamId ? machines.filter(m => {
    const mTeams = machineTeams(m)
    if (mTeams.includes(manageTeamId)) return false
    // Manager: cannot pull in a machine that belongs to a team they don't manage.
    if (!viewerIsOwner && mTeams.length > 0 && !mTeams.some(id => managedTeamIds.has(id))) return false
    return true
  }) : []

  const userRoleLabel = pt ? 'Usuário (leitura)' : 'User (read)'
  const managerRoleLabel = pt ? 'Manager (gerencia o time)' : 'Manager (manages the team)'
  const roleOptions: { value: 'manager' | 'user'; label: string }[] = viewerIsOwner
    ? [{ value: 'user', label: userRoleLabel }, { value: 'manager', label: managerRoleLabel }]
    : [{ value: 'user', label: userRoleLabel }]

  // create-drawer eligibility (no team yet, so independent of manageTeamId)
  const canCreateWithMembers = viewerIsOwner || managedTeamIds.size > 0
  const createEligibleAccounts = accounts.filter(a => {
    if (a.role === 'owner') return false
    if (!viewerIsOwner) {
      if (a.memberships.length === 0) return true
      return a.memberships.every(m => m.role === 'user' && managedTeamIds.has(m.teamId))
    }
    return true
  })
  const createEligibleMachines = machines.filter(m => {
    const mTeams = machineTeams(m)
    if (!viewerIsOwner && mTeams.length > 0 && !mTeams.some(id => managedTeamIds.has(id))) return false
    return true
  })

  // Bulk pick list: scrollable rows with a checkbox each; rows stay 44px tall on mobile.
  const pickList: React.CSSProperties = {
    maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)',
    borderRadius: 7, background: 'var(--bg-elevated)',
  }
  const pickRow: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, padding: isMobile ? '8px 10px' : '7px 10px',
    minHeight: isMobile ? 44 : 34, borderTop: '1px solid var(--border-subtle)',
  }
  const pickHeadRow: React.CSSProperties = {
    ...pickRow, borderTop: 'none', position: 'sticky', top: 0, zIndex: 1,
    background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-subtle)',
  }
  const pickEmpty = (msg: string) => (
    <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '8px 2px' }}>{msg}</div>
  )
  const selectAllLabel = pt ? 'Selecionar todos' : 'Select all'
  const selectedLabel = (n: number) => pt ? `${n} selecionado(s)` : `${n} selected`

  // Toggle helpers for the two multi-select shapes (accounts carry a role, machines are plain ids).
  const toggleAccountPick = (
    set: React.Dispatch<React.SetStateAction<{ accountId: string; role: 'manager' | 'user' }[]>>,
    accountId: string, on: boolean,
  ) => set(rows => on
    ? (rows.some(r => r.accountId === accountId) ? rows : [...rows, { accountId, role: 'user' as const }])
    : rows.filter(r => r.accountId !== accountId))
  const setAccountPickRole = (
    set: React.Dispatch<React.SetStateAction<{ accountId: string; role: 'manager' | 'user' }[]>>,
    accountId: string, role: 'manager' | 'user',
  ) => set(rows => rows.some(r => r.accountId === accountId)
    ? rows.map(r => r.accountId === accountId ? { ...r, role } : r)
    : [...rows, { accountId, role }])
  const toggleIdPick = (
    set: React.Dispatch<React.SetStateAction<string[]>>, id: string, on: boolean,
  ) => set(ids => on ? (ids.includes(id) ? ids : [...ids, id]) : ids.filter(x => x !== id))

  const ROLE_BADGE_COLORS: Record<string, string> = { manager: 'var(--anthropic-orange)', user: '#3b82f6' }
  function RoleBadge({ role }: { role: string }) {
    const color = ROLE_BADGE_COLORS[role] ?? 'var(--text-tertiary)'
    return (
      <span style={{
        display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 10.5,
        fontWeight: 700, color, background: `color-mix(in srgb, ${color} 16%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`, textTransform: 'capitalize',
      }}>
        {role}
      </span>
    )
  }

  return (
    <div>
      <SectionHeader label={pt ? 'Times' : 'Teams'} />

      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 18px' }}>
        {pt
          ? 'Times agrupam usuários e máquinas para escopo de acesso e agregação de métricas.'
          : 'Teams group users and machines for access scoping and metric aggregation.'}
      </p>

      {err && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 12 }}>{err}</div>}

      {/* Teams */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{pt ? 'Times' : 'Teams'}</div>
        <button style={primaryBtn} onClick={openTeamDrawer}><Plus size={14} /> {pt ? 'Novo time' : 'New team'}</button>
      </div>
      {isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {teams.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', padding: '16px 2px' }}>
              {pt ? 'Nenhum time.' : 'No teams.'}
            </div>
          )}
          {teams.map(t => (
            <RecordCard
              key={t._id}
              title={t.name}
              onClick={canManageTeam(t._id) ? () => openManageDrawer(t._id) : undefined}
              fields={[{ label: pt ? 'Membros' : 'Members', value: memberCountOf(t._id) }]}
              actions={
                <>
                  {canManageTeam(t._id) && (
                    <RecordCardAction label="Manage team" onClick={() => openManageDrawer(t._id)}>
                      <Settings size={14} /> {pt ? 'Gerenciar' : 'Manage'}
                    </RecordCardAction>
                  )}
                  {/* Any team is deletable now (no special Default) — deletion cascades to detach it. */}
                  <RecordCardAction label="Delete team" danger onClick={() => setConfirm({ kind: 'team', id: t._id, label: t.name })}>
                    <Trash2 size={14} /> {pt ? 'Excluir' : 'Delete'}
                  </RecordCardAction>
                </>
              }
            />
          ))}
        </div>
      ) : (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>{pt ? 'Nome' : 'Name'}</th>
              <th style={th}>{pt ? 'Membros' : 'Members'}</th>
              <th style={{ ...th, width: 80 }} />
            </tr>
          </thead>
          <tbody>
            {teams.length === 0 && (
              <tr><td style={{ ...td, color: 'var(--text-tertiary)' }} colSpan={3}>{pt ? 'Nenhum time.' : 'No teams.'}</td></tr>
            )}
            {teams.map(t => {
              const clickable = canManageTeam(t._id)
              return (
              <tr key={t._id}
                onClick={clickable ? () => openManageDrawer(t._id) : undefined}
                style={{ cursor: clickable ? 'pointer' : 'default' }}
                onMouseEnter={clickable ? e => { e.currentTarget.style.background = 'var(--bg-elevated)' } : undefined}
                onMouseLeave={clickable ? e => { e.currentTarget.style.background = '' } : undefined}>
                <td style={{ ...td, color: 'var(--text-primary)', fontWeight: 500 }}>
                  {t.name}
                </td>
                <td style={td}>{memberCountOf(t._id)}</td>
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {canManageTeam(t._id) && (
                    <button onClick={e => { e.stopPropagation(); openManageDrawer(t._id) }} style={{ ...trashBtn, color: 'var(--text-tertiary)' }} aria-label="Manage team" title={pt ? 'Gerenciar' : 'Manage'}>
                      <Settings size={14} />
                    </button>
                  )}
                  {/* Any team is deletable now (no special Default) — deletion cascades to detach it. */}
                  <button onClick={e => { e.stopPropagation(); setConfirm({ kind: 'team', id: t._id, label: t.name }) }} style={trashBtn} aria-label="Delete team"><Trash2 size={14} /></button>
                </td>
              </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      )}

      {/* Team create drawer */}
      <Drawer open={teamOpen} onClose={() => setTeamOpen(false)} title={pt ? 'Novo time' : 'New team'}
        lang={lang}
        dirty={teamName.trim() !== '' || newMembers.length > 0 || newMachineIds.length > 0}>
        {drawerErr(teamErr)}
        <Field label={pt ? 'Nome do time' : 'Team name'}>
          <input style={input} value={teamName} onChange={e => setTeamName(e.target.value)} placeholder={pt ? 'Nome do time' : 'Team name'} />
        </Field>

        {canCreateWithMembers && (
          <>
            {/* Optional members editor */}
            <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '0.07em', textTransform: 'uppercase' }}>
                {pt ? 'Membros (opcional)' : 'Members (optional)'}
              </div>
              {createEligibleAccounts.length === 0
                ? pickEmpty(pt ? 'Nenhuma conta disponível.' : 'No accounts available.')
                : (
                  <div style={pickList}>
                    <div style={pickHeadRow}>
                      <Checkbox
                        checked={newMembers.length === createEligibleAccounts.length && createEligibleAccounts.length > 0}
                        onChange={on => setNewMembers(on ? createEligibleAccounts.map(a => ({ accountId: a.id, role: 'user' as const })) : [])}
                        label={selectAllLabel}
                      />
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)' }}>{selectedLabel(newMembers.length)}</span>
                    </div>
                    {createEligibleAccounts.map(a => {
                      const pick = newMembers.find(r => r.accountId === a.id)
                      return (
                        <div key={a.id} style={pickRow}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <Checkbox
                              checked={!!pick}
                              onChange={on => toggleAccountPick(setNewMembers, a.id, on)}
                              label={a.name}
                            />
                            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', paddingLeft: 24 }}>{a.email}</div>
                          </div>
                          <div style={{ width: 120, flexShrink: 0 }}>
                            <Select
                              value={pick?.role ?? 'user'}
                              onChange={v => setAccountPickRole(setNewMembers, a.id, v as 'manager' | 'user')}
                              options={roleOptions}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
            </div>

            {/* Optional machines editor */}
            <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '0.07em', textTransform: 'uppercase' }}>
                {pt ? 'Máquinas (opcional)' : 'Machines (optional)'}
              </div>
              {createEligibleMachines.length === 0
                ? pickEmpty(pt ? 'Nenhuma máquina disponível.' : 'No machines available.')
                : (
                  <div style={pickList}>
                    <div style={pickHeadRow}>
                      <Checkbox
                        checked={newMachineIds.length === createEligibleMachines.length && createEligibleMachines.length > 0}
                        onChange={on => setNewMachineIds(on ? createEligibleMachines.map(m => m.id) : [])}
                        label={selectAllLabel}
                      />
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)' }}>{selectedLabel(newMachineIds.length)}</span>
                    </div>
                    {createEligibleMachines.map(m => (
                      <div key={m.id} style={pickRow}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Checkbox
                            checked={newMachineIds.includes(m.id)}
                            onChange={on => toggleIdPick(setNewMachineIds, m.id, on)}
                            label={m.machineName}
                          />
                          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', paddingLeft: 24 }}>{m.accountName ?? (pt ? 'sem conta' : 'no account')}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
            </div>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button style={ghostBtn} onClick={() => setTeamOpen(false)}>{pt ? 'Cancelar' : 'Cancel'}</button>
          <button style={primaryBtn} onClick={() => void createTeam()}>
            <Plus size={14} /> {pt ? 'Criar time' : 'Create team'}
            {newMembers.length + newMachineIds.length > 0 && ` (${newMembers.length + newMachineIds.length})`}
          </button>
        </div>
      </Drawer>

      {/* Manage team drawer */}
      <Drawer open={manageOpen} onClose={() => setManageOpen(false)} title={manageTeam?.name ?? ''}
        lang={lang}
        dirty={
          (editingSection === 'members' && addAccounts.length > 0)
          || (editingSection === 'machines' && addMachineIds.length > 0)
        }>
        {drawerErr(manageErr)}

        {/* MEMBERS SECTION (read-first; add/remove behind the section's Edit toggle) */}
        <Section
          title={pt ? 'Membros' : 'Members'}
          editing={editingSection === 'members'}
          canEdit={canEditManage}
          onEdit={() => { setManageErr(null); setAddAccounts([]); setEditingSection('members') }}
          onCancel={() => { setAddAccounts([]); setEditingSection(null) }}
          onSave={() => { void (async () => { if (addAccounts.length > 0) await addAccountsToTeam(); setAddAccounts([]); setEditingSection(null) })() }}
          labels={manageSectionLabels}
          editChildren={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {teamMembers.length === 0 ? (
                <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '4px 0' }}>
                  {pt ? 'Nenhum membro neste time.' : 'No members in this team.'}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {teamMembers.map(a => {
                    const membership = a.memberships.find(m => m.teamId === manageTeamId)
                    return (
                      <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '10px 12px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>{a.name}</span>
                          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{a.email}</span>
                        </div>
                        {canEditManage
                          ? (
                            <div style={{ width: 120, flexShrink: 0 }}>
                              <Select
                                value={membership?.role ?? 'user'}
                                onChange={v => void changeMemberRole(a.id, v as 'manager' | 'user')}
                                options={roleOptions}
                              />
                            </div>
                          )
                          : membership && <RoleBadge role={membership.role} />}
                        <button type="button" style={{ ...ghostBtn, padding: '5px 10px', color: '#ef4444', fontSize: 11.5 }} onClick={() => setConfirm({ kind: 'member', id: a.id, label: a.name })}>
                          {pt ? 'Remover' : 'Remove'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Add members (bulk pick) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
                  {pt ? 'Adicionar membros' : 'Add members'}
                </div>
                {eligibleAccounts.length === 0
                  ? pickEmpty(pt ? 'Nenhuma conta disponível.' : 'No accounts available.')
                  : (
                    <>
                      <div style={pickList}>
                        <div style={pickHeadRow}>
                          <Checkbox
                            checked={addAccounts.length === eligibleAccounts.length && eligibleAccounts.length > 0}
                            onChange={on => setAddAccounts(on ? eligibleAccounts.map(a => ({ accountId: a.id, role: 'user' as const })) : [])}
                            label={selectAllLabel}
                          />
                          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)' }}>{selectedLabel(addAccounts.length)}</span>
                        </div>
                        {eligibleAccounts.map(a => {
                          const pick = addAccounts.find(r => r.accountId === a.id)
                          return (
                            <div key={a.id} style={pickRow}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <Checkbox
                                  checked={!!pick}
                                  onChange={on => toggleAccountPick(setAddAccounts, a.id, on)}
                                  label={a.name}
                                />
                                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', paddingLeft: 24 }}>{a.email}</div>
                              </div>
                              <div style={{ width: 120, flexShrink: 0 }}>
                                <Select
                                  value={pick?.role ?? 'user'}
                                  onChange={v => setAccountPickRole(setAddAccounts, a.id, v as 'manager' | 'user')}
                                  options={roleOptions}
                                />
                              </div>
                            </div>
                          )
                        })}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          disabled={addAccounts.length === 0}
                          style={{ ...primaryBtn, whiteSpace: 'nowrap', opacity: addAccounts.length === 0 ? 0.5 : 1, cursor: addAccounts.length === 0 ? 'default' : 'pointer' }}
                          onClick={() => void addAccountsToTeam()}>
                          <Plus size={13} /> {pt ? 'Adicionar' : 'Add'} {addAccounts.length > 0 ? addAccounts.length : ''}
                        </button>
                      </div>
                    </>
                  )}
              </div>
            </div>
          }
        >
          {teamMembers.length === 0 ? (
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '4px 0' }}>
              {pt ? 'Nenhum membro neste time.' : 'No members in this team.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {teamMembers.map(a => {
                const membership = a.memberships.find(m => m.teamId === manageTeamId)
                return (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '10px 12px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>{a.name}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{a.email}</span>
                    </div>
                    {canEditManage
                      ? (
                        <div style={{ width: 120, flexShrink: 0 }}>
                          <Select
                            value={membership?.role ?? 'user'}
                            onChange={v => void changeMemberRole(a.id, v as 'manager' | 'user')}
                            options={roleOptions}
                          />
                        </div>
                      )
                      : membership && <RoleBadge role={membership.role} />}
                  </div>
                )
              })}
            </div>
          )}
        </Section>

        {/* MACHINES SECTION (read-first; attach/detach behind the section's Edit toggle) */}
        <Section
          title={pt ? 'Máquinas' : 'Machines'}
          editing={editingSection === 'machines'}
          canEdit={canEditManage}
          onEdit={() => { setManageErr(null); setAddMachineIds([]); setEditingSection('machines') }}
          onCancel={() => { setAddMachineIds([]); setEditingSection(null) }}
          onSave={() => { void (async () => { if (addMachineIds.length > 0) await addMachinesToTeam(); setAddMachineIds([]); setEditingSection(null) })() }}
          labels={manageSectionLabels}
          editChildren={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {teamMachines.length === 0 ? (
                <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '4px 0' }}>
                  {pt ? 'Nenhuma máquina neste time.' : 'No machines in this team.'}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {teamMachines.map(m => (
                    <div key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                          {m.machineName}
                          {manageTeamId && inheritsTeam(m, manageTeamId) && (
                            // The machine came in with its owner account. Saying so is what makes
                            // "why is this here and not in the add list?" answerable at a glance.
                            <span style={inheritedTag} title={pt
                              ? 'Entrou no time junto com a conta dona. Remover cria uma exceção só para esta máquina.'
                              : 'Joined with its owner account. Removing creates an exception for this machine only.'}>
                              {pt ? 'via conta' : 'via account'}
                            </span>
                          )}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                          {m.accountName ? `${m.accountName} — ${m.accountEmail}` : (pt ? 'sem conta' : 'no account')} · {m.lastSeenAt ? new Date(m.lastSeenAt).toLocaleString() : (pt ? 'nunca' : 'never')}
                        </span>
                      </div>
                      <button type="button" style={{ ...ghostBtn, padding: '5px 10px', color: '#ef4444', fontSize: 11.5 }} onClick={() => setConfirm({ kind: 'machine', id: m.id, label: m.machineName })}>
                        {pt ? 'Remover' : 'Remove'}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add machines (bulk pick) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
                  {pt ? 'Adicionar máquinas' : 'Add machines'}
                </div>
                {eligibleMachines.length === 0
                  ? pickEmpty(pt ? 'Nenhuma máquina disponível.' : 'No machines available.')
                  : (
                    <>
                      <div style={pickList}>
                        <div style={pickHeadRow}>
                          <Checkbox
                            checked={addMachineIds.length === eligibleMachines.length && eligibleMachines.length > 0}
                            onChange={on => setAddMachineIds(on ? eligibleMachines.map(m => m.id) : [])}
                            label={selectAllLabel}
                          />
                          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)' }}>{selectedLabel(addMachineIds.length)}</span>
                        </div>
                        {eligibleMachines.map(m => (
                          <div key={m.id} style={pickRow}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <Checkbox
                                checked={addMachineIds.includes(m.id)}
                                onChange={on => toggleIdPick(setAddMachineIds, m.id, on)}
                                label={m.machineName}
                              />
                              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', paddingLeft: 24 }}>{m.accountName ?? (pt ? 'sem conta' : 'no account')}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          disabled={addMachineIds.length === 0}
                          style={{ ...primaryBtn, whiteSpace: 'nowrap', opacity: addMachineIds.length === 0 ? 0.5 : 1, cursor: addMachineIds.length === 0 ? 'default' : 'pointer' }}
                          onClick={() => void addMachinesToTeam()}>
                          <Plus size={13} /> {pt ? 'Adicionar' : 'Add'} {addMachineIds.length > 0 ? addMachineIds.length : ''}
                        </button>
                      </div>
                    </>
                  )}
              </div>
            </div>
          }
        >
          {teamMachines.length === 0 ? (
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '4px 0' }}>
              {pt ? 'Nenhuma máquina neste time.' : 'No machines in this team.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {teamMachines.map(m => (
                <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 12px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                    {m.machineName}
                    {manageTeamId && inheritsTeam(m, manageTeamId) && (
                      <span style={inheritedTag}>{pt ? 'via conta' : 'via account'}</span>
                    )}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {m.accountName ? `${m.accountName} — ${m.accountEmail}` : (pt ? 'sem conta' : 'no account')} · {m.lastSeenAt ? new Date(m.lastSeenAt).toLocaleString() : (pt ? 'nunca' : 'never')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
          <button style={ghostBtn} onClick={() => setManageOpen(false)}>{pt ? 'Fechar' : 'Close'}</button>
        </div>
      </Drawer>

      <ConfirmModal
        open={confirm !== null}
        title={
          confirm?.kind === 'team' ? (pt ? 'Excluir time?' : 'Delete team?')
            : confirm?.kind === 'member' ? (pt ? 'Remover membro do time?' : 'Remove member from team?')
              : (pt ? 'Remover máquina do time?' : 'Remove machine from team?')
        }
        message={
          confirm?.kind === 'team'
            ? (pt
              ? `O time "${confirm.label}" será excluído. As máquinas e membros vinculados serão desvinculados.`
              : `The team "${confirm.label}" will be deleted. Its machines and members will be detached.`)
            : confirm?.kind === 'member'
              ? (pt
                ? `Remover "${confirm.label}" deste time?`
                : `Remove "${confirm.label}" from this team?`)
              : (pt
                ? `Remover a máquina "${confirm?.label}" deste time?`
                : `Remove the machine "${confirm?.label}" from this team?`)
        }
        confirmLabel={confirm?.kind === 'team' ? (pt ? 'Excluir' : 'Delete') : (pt ? 'Remover' : 'Remove')}
        cancelLabel={pt ? 'Cancelar' : 'Cancel'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const c = confirm
          setConfirm(null)
          if (!c) return
          if (c.kind === 'team') void deleteTeam(c.id)
          else if (c.kind === 'member') { if (manageTeamId) void removeAccountFromTeam(c.id, manageTeamId) }
          else if (c.kind === 'machine') void removeMachineFromTeam(c.id)
        }}
      />
    </div>
  )
}
