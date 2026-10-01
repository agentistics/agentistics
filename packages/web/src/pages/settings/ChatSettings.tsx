/**
 * Chat settings — the switch that decides whether this machine serves the chat at all, plus (once
 * it is on) the notification sound and what new Nay conversations start with.
 *
 * It is ON unless someone turns it off (owner decision, 2026-09-29 — see `chat-gate.ts`). Chat
 * spawns an assistant CLI on this host, which is the most powerful thing the server does, so the
 * switch stays here and an explicit "off" is always respected.
 *
 * The switch can only NARROW what the exposure profile already permits (`chat-gate.ts`). When the
 * profile has revoked `localChat` the row says so and stays disabled — offering a toggle that the
 * server would refuse is the affordance this whole capability model exists to remove.
 *
 * The sound and model rows live in THIS section (not Preferences) because they are chat's own
 * settings — but they render only while `enabled === true`. The section itself stays visible
 * whenever the profile allows chat at all, on or off: it holds the enable switch, and hiding the
 * whole section the moment chat is off would make that switch unreachable — a one-way door with no
 * way back. `chatEnabled` gates these ROWS; `capabilities.localChat` (in `settingsSections.ts`)
 * gates the SECTION.
 *
 * Everything below the switch is `NaySettingsPanel` — the SAME component the chat window's own
 * settings screen draws, so the two can never offer different groups, words or values.
 */
import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { AppContext } from '../../lib/app-context'
import { useIsMobile } from '../../hooks/useIsMobile'
import { SectionHeader, Divider, PrefRow, Toggle } from './primitives'
import { NaySettingsPanel } from '../../components/nay/NaySettingsPanel'

export default function ChatSettings() {
  const ctx = useOutletContext<AppContext>()
  const pt = ctx.lang === 'pt'

  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [capable, setCapable] = useState(true)
  const [saving, setSaving] = useState(false)

  const isMobile = useIsMobile()

  useEffect(() => {
    void (async () => {
      const [prefs, session] = await Promise.all([
        fetch('/api/preferences')
          .then(r => (r.ok ? r.json() : {}) as Promise<{
            chatEnabled?: boolean
            chatModel?: string
            chatSoundEnabled?: boolean
            chatSoundId?: string
          }>)
          .catch(() => ({}) as { chatEnabled?: boolean; chatModel?: string; chatSoundEnabled?: boolean; chatSoundId?: string }),
        fetch('/api/team/session')
          .then(r => (r.ok ? r.json() : {}) as Promise<{ capabilities?: { localChat?: boolean } }>)
          .catch(() => ({}) as { capabilities?: { localChat?: boolean } }),
      ])
      // Absent reads as ON (owner decision 2026-09-29, `chat-gate.ts`); only an explicit false is off.
      setEnabled(prefs.chatEnabled !== false)
      // Undefined on an older server, which had no capability model — treat as permitted, the same
      // reading the rest of the app uses.
      setCapable(session.capabilities?.localChat !== false)
    })()
  }, [])

  const toggle = useCallback(async () => {
    if (enabled === null || !capable) return
    const next = !enabled
    setSaving(true)
    setEnabled(next)
    try {
      await fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatEnabled: next }),
      })
    } catch {
      setEnabled(!next)  // put the switch back where it was; nothing was saved
    } finally {
      setSaving(false)
    }
  }, [enabled, capable])

  return (
    <>
      <SectionHeader label={pt ? 'Chat nesta máquina' : 'Chat on this machine'} />

      <PrefRow
        label={pt ? 'Habilitar o chat' : 'Enable chat'}
        sub={capable
          ? (pt
            ? 'Ligado por padrão. Permite que o painel execute a CLI de um assistente nesta máquina; desligue para fechar essa porta.'
            : 'On by default. It lets the dashboard run an assistant CLI on this machine; turn it off to close that door.')
          : (pt
            ? 'Indisponível: o perfil de exposição desta instância não permite executar nada no host.'
            : 'Unavailable: this instance’s exposure profile does not allow running anything on the host.')}
      >
        <Toggle
          on={enabled === true}
          onToggle={() => { void toggle() }}
          disabled={!capable || enabled === null || saving}
        />
      </PrefRow>

      <Divider />

      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
        {pt
          ? 'O servidor é quem decide: com o chat desligado, /api/chat-tty e /api/chat-harnesses respondem 403. Esconder o botão não fecharia a porta.'
          : 'The server is what decides: with chat off, /api/chat-tty and /api/chat-harnesses answer 403. Hiding the button would not close the door.'}
      </div>

      <Divider />
      <NaySettingsPanel pt={pt} isMobile={isMobile} layout={isMobile ? 'stack' : 'rows'} chat={ctx}
        conversations={enabled === true} />
    </>
  )
}
