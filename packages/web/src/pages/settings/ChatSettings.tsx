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
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Volume2, VolumeX } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { useNayDefaults, useNayHarnesses, saveNayDefaults } from '../../hooks/useNayDefaults'
import { normalizeChoice } from '../../lib/nayLaunch'
import { NayLaunchFields } from '../../components/nay/NayLaunchFields'
import { CHAT_SOUNDS, DEFAULT_CHAT_SOUND_ID, findChatSound } from '../../lib/chatSounds'
import { getNotificationSettings, saveNotificationSettings, subscribeNotificationSettings } from '../../lib/sessionNotifications'
import { NAY_ANIMATIONS, NAY_ANIMATION_HINT, NAY_ANIMATION_LABEL, type NayAnimation } from '../../lib/nayNotify'
import { SectionHeader, Divider, PrefRow, Toggle, Select } from './primitives'

export default function ChatSettings() {
  const ctx = useOutletContext<AppContext>()
  const pt = ctx.lang === 'pt'

  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [capable, setCapable] = useState(true)
  const [saving, setSaving] = useState(false)

  const harnesses = useNayHarnesses(pt ? 'pt' : 'en')
  const nayDefaults = useNayDefaults()
  const [chatSoundEnabled, setChatSoundEnabled] = useState(true)
  const [chatSoundId, setChatSoundId] = useState(DEFAULT_CHAT_SOUND_ID)

  const previewCtxRef = useRef<AudioContext | null>(null)
  const previewSound = useCallback((id: string) => {
    if (!previewCtxRef.current) {
      try { previewCtxRef.current = new AudioContext() } catch { return }
    }
    // Preview at the SAME volume a real reply would use, read fresh — so picking a sound here shows
    // exactly what the Notifications screen's volume slider will make it sound like, immediately.
    findChatSound(id).play(previewCtxRef.current, getNotificationSettings().soundVolume)
  }, [])

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
      setChatSoundEnabled(prefs.chatSoundEnabled ?? true)
      setChatSoundId(prefs.chatSoundId ?? DEFAULT_CHAT_SOUND_ID)
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

  const toggleSound = useCallback(() => {
    const next = !chatSoundEnabled
    setChatSoundEnabled(next)
    ctx.setChatSoundEnabled(next)  // keeps the live chat widget (TtyChat) in sync, no reload needed
    if (next) previewSound(chatSoundId)
    void fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSoundEnabled: next }),
    }).catch(() => {})
  }, [chatSoundEnabled, chatSoundId, previewSound, ctx])

  const selectSound = useCallback((id: string) => {
    setChatSoundId(id)
    ctx.setChatSoundId(id)
    previewSound(id)
    void fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSoundId: id }),
    }).catch(() => {})
  }, [previewSound, ctx])


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
      <NayAnimationSetting pt={pt} />

      {/* Two gates, not one: the switch above is reachable whenever the PROFILE allows chat, on or
          off — this row is what turns it back on. The sound and model only matter once chat is
          actually serving, so they are gated on the user's own switch, not just the profile. */}
      {enabled === true && (
        <>
          <Divider />
          <SectionHeader label={pt ? 'Som' : 'Sound'} />

          <PrefRow
            label={pt ? 'Som de notificação' : 'Notification sound'}
            sub={pt
              ? 'Toca quando uma resposta chega com o chat minimizado. Volume e chave geral em Configurações → Notificações → Efeitos Sonoros; esta chave só pode silenciar, nunca reativar aquela.'
              : 'Plays when a reply arrives while chat is minimized. Volume and the master switch live in Settings → Notifications → Sound Effects; this switch can only silence it further, never override that one.'}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {chatSoundEnabled ? <Volume2 size={14} color="var(--anthropic-orange)" /> : <VolumeX size={14} color="var(--text-tertiary)" />}
              <Toggle on={chatSoundEnabled} onToggle={toggleSound} />
            </div>
          </PrefRow>

          {/* Sound picker — only visible when sound is enabled */}
          {chatSoundEnabled && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {CHAT_SOUNDS.map(s => {
                const active = chatSoundId === s.id
                return (
                  <button
                    key={s.id}
                    onClick={() => selectSound(s.id)}
                    style={{
                      padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: active ? 700 : 500,
                      border: active ? '1.5px solid var(--anthropic-orange)' : '1px solid var(--border)',
                      background: active ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
                      color: active ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
                      cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s',
                    }}
                  >
                    {s.label[pt ? 'pt' : 'en']}
                  </button>
                )
              })}
            </div>
          )}
          <Divider />
          <SectionHeader label={pt ? 'Novas conversas da Nay' : 'New Nay conversations'} />
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6, marginBottom: 10 }}>
            {pt
              ? 'O assistente, o modelo e o esforço de raciocínio com que toda conversa nova da Nay começa. O botão "Nova conversa" do chat já vem com estes valores, e dá para trocar ali mesmo. Só aparecem as opções que a CLI de cada assistente aceita.'
              : 'The assistant, model and reasoning effort every new Nay conversation starts with. The chat\'s "New conversation" picker comes filled with these, and can change them right there. Only the options each assistant\'s CLI accepts are offered.'}
          </div>
          {!harnesses || !nayDefaults ? (
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{pt ? 'Carregando os assistentes desta máquina…' : 'Loading the assistants on this machine…'}</div>
          ) : harnesses.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{pt ? 'Nenhum assistente pode ser iniciado nesta máquina.' : 'No assistant can be started on this machine.'}</div>
          ) : (
            <NayLaunchFields layout="rows" pt={pt} harnesses={harnesses}
              value={normalizeChoice(nayDefaults, harnesses)} onChange={saveNayDefaults} />
          )}
        </>
      )}
    </>
  )
}

/**
 * How the floating Nay button delivers a session notification. The same stored value the dock's
 * gear popover writes (`NotificationSettings.nayAnimation`), so the two places can never disagree.
 */
function NayAnimationSetting({ pt }: { pt: boolean }) {
  const [value, setValue] = useState<NayAnimation>(() => getNotificationSettings().nayAnimation)
  useEffect(() => subscribeNotificationSettings(() => setValue(getNotificationSettings().nayAnimation)), [])
  const lang = pt ? 'pt' : 'en'
  return (
    <>
      <SectionHeader label={pt ? 'Notificações do botão Nay' : 'Nay button notifications'} />
      <PrefRow
        label={pt ? 'Como o botão avisa' : 'How the button tells you'}
        sub={`${NAY_ANIMATION_HINT[value][lang]}. ${pt ? 'Com movimento reduzido no sistema, qualquer escolha vira um fade.' : 'With reduced motion on, every choice becomes a fade.'}`}
      >
        <div style={{ minWidth: 180 }}>
          <Select
            value={value}
            onChange={v => {
              const next = v as NayAnimation
              setValue(next)
              saveNotificationSettings({ ...getNotificationSettings(), nayAnimation: next })
            }}
            options={NAY_ANIMATIONS.map(a => ({ value: a, label: NAY_ANIMATION_LABEL[a][lang] }))}
          />
        </div>
      </PrefRow>
    </>
  )
}
