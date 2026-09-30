import React, { useState, useEffect } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { AppContext } from '../../lib/app-context'
import {
  getNotificationSettings,
  saveNotificationSettings,
  requestNotificationPermission,
  getBrowserNotificationPermission,
  notificationSupport,
  type NotificationSupport,
  playNotificationSound,
  triggerSessionNotification,
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  type SoundPreset,
  type NotifyEvent,
} from '../../lib/sessionNotifications'
import { NAY_SOUNDS } from '../../lib/notificationSounds'
import { alertKey, formatSpan, STALE_OPTIONS_MIN } from '../../lib/nayNotify'
import { pushAlert } from '../../lib/nayNotifyStore'
import { SectionHeader, Divider, PrefRow, Toggle, Select } from './primitives'
import { Bell, Volume2, VolumeX, ShieldAlert, Sparkles, CheckCircle2, AlertCircle, Clock, Activity, XCircle, Hourglass } from 'lucide-react'

export default function NotificationsSettings() {
  const ctx = useOutletContext<AppContext>()
  const pt = ctx.lang === 'pt'

  const [settings, setSettings] = useState<NotificationSettings>(getNotificationSettings)
  const [permission, setPermission] = useState<NotificationPermission>('default')
  // WHETHER THIS BROWSER CAN NOTIFY AT ALL, which is a different question from whether it has been
  // asked. On iPhone the API exists only in a web app installed on the Home Screen — in a tab it is
  // simply absent, so the button below could never do anything and the screen had no way to say
  // why. Read once, in an effect, so a server render never touches `navigator`.
  const [support, setSupport] = useState<NotificationSupport>('ok')
  /**
   * WHERE THIS DASHBOARD IS ALREADY SERVED OVER HTTPS, when it is.
   *
   * The page cannot work this out: from inside a browser one IP address looks like any other, and
   * the machine's name on a tailnet is not something the document knows. The SERVER reads a
   * `tailscale serve` configuration that already exists and reports the origin only when it
   * provably proxies to this very dashboard — so the row stops being a rule and becomes a link.
   *
   * Asked for ONLY when the origin is insecure: that is the one state where the answer changes
   * anything, and it spawns a process on the machine.
   */
  const [secureOrigin, setSecureOrigin] = useState<string | null>(null)
  useEffect(() => {
    if (support !== 'insecure') return
    let alive = true
    void fetch('/api/secure-origin')
      .then(r => (r.ok ? r.json() : null))
      .then((j: { origin?: string } | null) => { if (alive && j?.origin) setSecureOrigin(j.origin) })
      // A hint that cannot be fetched is simply not shown — the sentence above still stands alone.
      .catch(() => {})
    return () => { alive = false }
  }, [support])

  useEffect(() => {
    setPermission(getBrowserNotificationPermission())
    setSupport(notificationSupport())
  }, [])

  function update(partial: Partial<NotificationSettings>) {
    const next = { ...settings, ...partial }
    setSettings(next)
    saveNotificationSettings(next)
  }

  function updateEvent(eventKey: keyof NotificationSettings['events'], value: boolean) {
    const nextEvents = { ...settings.events, [eventKey]: value }
    update({ events: nextEvents })
  }

  function updateEventSound(eventKey: NotifyEvent, value: SoundPreset) {
    const base = settings.eventSounds || DEFAULT_NOTIFICATION_SETTINGS.eventSounds!
    const nextSounds: NonNullable<NotificationSettings['eventSounds']> = { ...base, [eventKey]: value }
    update({ eventSounds: nextSounds })
  }

  async function handleRequestPermission() {
    const res = await requestNotificationPermission()
    setPermission(res)
    if (res === 'granted') {
      update({ enabled: true })
      triggerSessionNotification({
        title: pt ? 'Notificações Ativadas' : 'Notifications Enabled',
        body: pt
          ? 'Você receberá alertas sonoros e notificações do navegador para suas Live Sessions.'
          : 'You will receive browser notifications and sound alerts for your Live Sessions.',
        soundEnabled: settings.soundEnabled,
        soundPreset: settings.soundPreset,
        soundVolume: settings.soundVolume,
      })
    }
  }

  function handleTestSoundAndNotification() {
    // The Nay button's own card, as a DEMO: it carries no real session, so it offers only snooze and
    // dismiss — a reply or an approval sent from a test would reach nothing, or the wrong thing.
    const now = Date.now()
    pushAlert({
      key: alertKey('turn', 'demo', now), kind: 'turn', sessionId: 'demo', demo: true,
      name: pt ? 'Sessão de exemplo' : 'Example session', harness: 'claude', model: 'claude-opus-5-5',
      sinceMs: now - 3 * 60_000, sinceKnown: true,
    })
    triggerSessionNotification({
      title: pt ? 'Notificação de Teste' : 'Test Notification',
      body: pt
        ? 'Isso é uma demonstração do alerta sonoro e visual das Live Sessions.'
        : 'This is a test of the Live Sessions visual and sound notification.',
      soundEnabled: true,
      soundPreset: settings.soundPreset,
      soundVolume: settings.soundVolume,
    })
  }

  const SOUND_PRESETS: { key: SoundPreset; labelPt: string; labelEn: string; descPt: string; descEn: string }[] = [
    { key: 'chime', labelPt: 'Chime Melódico', labelEn: 'Melodic Chime', descPt: 'Acorde suave triplo em C5', descEn: 'Soft triple chord in C5' },
    { key: 'soft', labelPt: 'Suave / Discreto', labelEn: 'Soft / Subtle', descPt: 'Pulso duplo de baixa frequência', descEn: 'Double low-frequency pulse' },
    { key: 'alert', labelPt: 'Alerta / Destaque', labelEn: 'Alert Tone', descPt: 'Tom triplo de atenção em E5', descEn: 'Triple attention tone in E5' },
    { key: 'ping', labelPt: 'Ping de Cristal', labelEn: 'Crystal Ping', descPt: 'Sino agudo de alta clareza', descEn: 'High clarity bell' },
    // The thirteen synthesized for the Nay button's cards (`notificationSounds.ts`).
    ...NAY_SOUNDS.map(n => ({ key: n.id as SoundPreset, labelPt: n.label.pt, labelEn: n.label.en, descPt: n.about.pt, descEn: n.about.en })),
  ]

  const EVENT_CONFIGS: {
    key: keyof NotificationSettings['events']
    titlePt: string
    titleEn: string
    color: string
    icon: React.ReactNode
    descPt: string
    descEn: string
  }[] = [
    {
      key: 'waiting-approval',
      titlePt: 'Precisa de Aprovação',
      titleEn: 'Needs Approval',
      color: '#ef4444',
      icon: <AlertCircle size={15} style={{ color: '#ef4444' }} />,
      descPt: 'Quando a sessão é pausada aguardando confirmação ou autorização do usuário',
      descEn: 'When session is paused waiting for user confirmation or tool authorization',
    },
    {
      key: 'waiting',
      titlePt: 'Aguardando Resposta',
      titleEn: 'Waiting Response',
      color: 'var(--anthropic-orange)',
      icon: <Clock size={15} style={{ color: 'var(--anthropic-orange)' }} />,
      descPt: 'Quando a IA concluiu a resposta e aguarda sua nova mensagem/comando',
      descEn: 'When AI completes its turn and awaits your input/command',
    },
    {
      key: 'working',
      titlePt: 'Trabalhando',
      titleEn: 'Working',
      color: '#22c55e',
      icon: <Activity size={15} style={{ color: '#22c55e' }} />,
      descPt: 'Quando a sessão retoma a execução / geração de código',
      descEn: 'When session resumes execution / code generation',
    },
    {
      key: 'exited',
      titlePt: 'Sessão Encerrada',
      titleEn: 'Session Exited',
      color: 'var(--text-secondary)',
      icon: <XCircle size={15} style={{ color: 'var(--text-tertiary)' }} />,
      descPt: 'Quando o processo de uma sessão ao vivo é finalizado',
      descEn: 'When a live session process exits or terminates',
    },
    {
      key: 'stale',
      titlePt: 'Sem abrir',
      titleEn: 'Not opened',
      color: 'var(--text-secondary)',
      icon: <Hourglass size={15} style={{ color: 'var(--text-secondary)' }} />,
      descPt: 'Quando uma sessão espera por você e ninguém a abre pelo tempo escolhido',
      descEn: 'When a session waits for you and nobody opens it for the chosen time',
    },
  ]

  return (
    <div style={{ maxWidth: 720 }}>
      {/* Browser Permission Banner / Card */}
      <div
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          padding: '16px 20px',
          marginBottom: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: permission === 'granted' ? 'rgba(34,197,94,0.12)' : 'rgba(232,105,11,0.12)',
              color: permission === 'granted' ? '#22c55e' : 'var(--anthropic-orange)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Bell size={20} />
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
              {pt ? 'Permissão do Navegador' : 'Browser Permission'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              {support !== 'ok' ? (
                <>
                  <ShieldAlert size={12} style={{ color: 'var(--anthropic-orange)' }} />
                  <span>
                    {support === 'insecure'
                      ? (secureOrigin
                          ? (pt
                              ? 'Esta página está em http://, e notificações (assim como o service worker e a instalação) só existem em uma origem segura. Esta máquina JÁ é servida em https — abra o painel pelo endereço abaixo e adicione-o à tela de início a partir dele.'
                              : 'This page is on http://, and notifications — like the service worker and installability — exist only on a secure origin. This machine is ALREADY served over https — open the dashboard at the address below and add it to your Home Screen from there.')
                          : (pt
                              ? 'Esta página está em http://, e notificações (assim como o service worker e a instalação) só existem em uma origem segura. Se você acessa por Tailscale, use `tailscale serve` para servir em https:// pelo nome da máquina — é o que destrava tudo isto.'
                              : 'This page is on http://, and notifications — like the service worker and installability — exist only on a secure origin. If you reach it over Tailscale, use `tailscale serve` to serve it over https:// on the machine name; that is what unlocks all of this.'))
                      : support === 'needs-safari'
                        ? (pt
                            ? 'Este app foi adicionado à tela de início pelo Chrome, e no iPhone só um app adicionado pelo Safari roda de verdade em modo standalone — que é o único que recebe notificações. Remova este ícone e adicione de novo pelo Safari.'
                            : 'This app was added to the Home Screen from Chrome, and on iPhone only an app added from Safari actually runs standalone — the only mode given notifications. Remove this icon and add it again from Safari.')
                        : support === 'needs-install'
                          ? (pt
                              ? 'O iPhone só permite notificações depois que o app é instalado na tela de início pelo Safari — abra o menu de compartilhar e escolha “Adicionar à Tela de Início”.'
                              : 'iPhone only allows notifications once the app is installed on the Home Screen from Safari — open the share menu and choose “Add to Home Screen”.')
                          : (pt
                              ? 'Este navegador não oferece notificações. Os alertas sonoros continuam funcionando.'
                              : 'This browser offers no notifications. The sound alerts still work.')}
                    {/* THE ADDRESS, not the rule. The sentence above can only ever name
                        `tailscale serve`; this is where this machine is actually served, read from
                        a configuration that already exists — so the row becomes something to press
                        rather than something to go and do. Absent unless the server could prove an
                        https origin proxies to THIS dashboard. */}
                    {support === 'insecure' && secureOrigin && (
                      <a
                        href={secureOrigin}
                        style={{
                          display: 'block', marginTop: 8, fontSize: 12, lineHeight: 1.5,
                          color: 'var(--anthropic-orange)', overflowWrap: 'anywhere',
                          textDecoration: 'none', fontWeight: 600,
                        }}
                      >
                        {pt ? `Abrir em ${secureOrigin}` : `Open at ${secureOrigin}`}
                      </a>
                    )}
                  </span>
                </>
              ) : permission === 'granted' ? (
                <>
                  <CheckCircle2 size={12} style={{ color: '#22c55e' }} />
                  <span>{pt ? 'Permissão concedida no navegador' : 'Permission granted in browser'}</span>
                </>
              ) : permission === 'denied' ? (
                <>
                  <AlertCircle size={12} style={{ color: '#ef4444' }} />
                  {/* A DENIED PERMISSION CANNOT BE ASKED FOR AGAIN. The browser resolves
                      `requestPermission()` straight to `denied` without showing anything, so a
                      button here is one that does nothing when pressed — which is exactly what
                      "não tá pedindo permissão" looked like from the other side. The way back is
                      the system's own settings, and the sentence says where. */}
                  <span>
                    {pt
                      ? 'Bloqueada. O navegador não pergunta de novo — libere em Ajustes › Notificações › agentistics (ou remova o app da tela de início e adicione outra vez).'
                      : 'Blocked. The browser will not ask again — allow it in Settings › Notifications › agentistics (or remove the app from the Home Screen and add it again).'}
                  </span>
                </>
              ) : (
                <>
                  <ShieldAlert size={12} style={{ color: 'var(--anthropic-orange)' }} />
                  <span>{pt ? 'Ainda não solicitada ao navegador' : 'Not requested yet'}</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Absent rather than disabled where it cannot work: a button that does nothing when
            pressed is indistinguishable from a broken one, and the sentence above already says
            what to do instead. */}
        {/* Only where pressing it can actually do something: `default` is the one state the
            browser will still show a prompt for. */}
        {support === 'ok' && permission === 'default' && (
          <button
            onClick={handleRequestPermission}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              background: 'var(--anthropic-orange)',
              color: '#fff',
              border: 'none',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'opacity 0.15s',
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={e => { e.currentTarget.style.opacity = '0.9' }}
            onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
          >
            {pt ? 'Autorizar Notificações' : 'Enable Notifications'}
          </button>
        )}
      </div>

      {/* Master Enable Toggle */}
      <PrefRow
        label={pt ? 'Ativar Notificações das Live Sessions' : 'Enable Live Session Notifications'}
        sub={
          pt
            ? 'Dispara alertas visuais e sonoros ao mudar de status (Central e Machine)'
            : 'Fires visual and sound alerts when session status changes (Central and Machine)'
        }
      >
        <Toggle on={settings.enabled} onToggle={() => update({ enabled: !settings.enabled })} />
      </PrefRow>

      <PrefRow
        label={pt ? 'Não perturbe' : 'Do not disturb'}
        sub={pt
          ? 'Sem cartão do botão Nay, sem som e sem notificação do sistema. Tudo continua registrado no sino.'
          : 'No Nay button card, no sound and no system notification. Everything is still recorded in the bell.'}
      >
        <Toggle on={settings.doNotDisturb} onToggle={() => update({ doNotDisturb: !settings.doNotDisturb })} />
      </PrefRow>

      <PrefRow
        label={pt ? 'Notificação do sistema com a aba em segundo plano' : 'System notification while the tab is in the background'}
        sub={pt
          ? 'Com a aba visível, o aviso é o cartão que sai do botão Nay. Com ela escondida, o cartão não seria visto — então usa a notificação do navegador.'
          : 'With the tab visible, the alert is the card that comes out of the Nay button. With it hidden the card would not be seen, so the browser notification is used.'}
      >
        <Toggle on={settings.systemWhenHidden} onToggle={() => update({ systemWhenHidden: !settings.systemWhenHidden })} />
      </PrefRow>

      <Divider />

      {/* Event Types & Per-Status Sound Customization */}
      <SectionHeader label={pt ? 'Eventos e Toques por Status' : 'Events & Per-Status Tones'} />
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 14 }}>
        {pt
          ? 'Escolha em quais momentos notificar e defina o toque específico para cada status:'
          : 'Choose when to notify and select a specific sound chime for each status:'}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
        {EVENT_CONFIGS.map(evt => {
          const events = settings.events || DEFAULT_NOTIFICATION_SETTINGS.events
          const eventSounds = settings.eventSounds || DEFAULT_NOTIFICATION_SETTINGS.eventSounds!
          const enabled = events[evt.key] ?? true
          const currentSound = eventSounds[evt.key] ?? 'chime'

          return (
            <div
              key={evt.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 14px',
                borderRadius: 8,
                border: '1px solid var(--border-subtle)',
                background: 'var(--bg-elevated)',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: evt.color, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {evt.icon}
                  <span>{pt ? evt.titlePt : evt.titleEn}</span>
                  <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-tertiary)', marginLeft: 4 }}>
                    ({evt.key})
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                  {pt ? evt.descPt : evt.descEn}
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                {/* Per-Status Sound Dropdown */}
                {settings.soundEnabled && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div style={{ minWidth: 150, opacity: enabled ? 1 : 0.6 }}>
                      <Select
                        value={currentSound}
                        onChange={v => updateEventSound(evt.key, v as SoundPreset)}
                        disabled={!enabled}
                        options={SOUND_PRESETS.map(p => ({ value: p.key, label: pt ? p.labelPt : p.labelEn }))}
                      />
                    </div>

                    <button
                      onClick={() => playNotificationSound(currentSound, settings.soundVolume)}
                      disabled={!enabled}
                      title={pt ? 'Ouvir toque deste status' : 'Play sound'}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 28,
                        height: 28,
                        borderRadius: 6,
                        border: '1px solid var(--border-subtle)',
                        background: 'var(--bg-surface)',
                        color: enabled ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                        cursor: enabled ? 'pointer' : 'not-allowed',
                        padding: 0,
                        opacity: enabled ? 1 : 0.6,
                      }}
                    >
                      <Volume2 size={13} />
                    </button>
                  </div>
                )}

                {evt.key === 'stale' && (
                  <div style={{ minWidth: 110, opacity: enabled ? 1 : 0.6 }} title={pt ? 'Depois de quanto tempo sem abrir' : 'After how long unopened'}>
                    <Select
                      value={String(settings.staleAfterMin)}
                      onChange={v => update({ staleAfterMin: Number(v) })}
                      disabled={!enabled}
                      options={STALE_OPTIONS_MIN.map(m => ({
                        value: String(m),
                        label: m === 0 ? (pt ? 'nunca' : 'never') : formatSpan(m * 60_000),
                      }))}
                    />
                  </div>
                )}
                <Toggle
                  on={enabled}
                  onToggle={() => updateEvent(evt.key, !enabled)}
                />
              </div>
            </div>
          )
        })}
      </div>

      <Divider />

      {/* General Sound Effects Section */}
      <SectionHeader label={pt ? 'Efeitos Sonoros Globais' : 'Sound Effects'} />

      <PrefRow
        label={pt ? 'Tocar Som nas Notificações' : 'Play Sound on Notifications'}
        sub={pt
          ? 'Efeito sonoro sintetizado via Web Audio API sem arquivos externos. É a chave e o volume GERAIS — também controlam o som de resposta do chat (Configurações → Chat), que só pode ser silenciado por aqui, nunca reativado de lá.'
          : 'Synthesized audio chime via Web Audio API without external downloads. This is the GLOBAL switch and volume — it also governs the chat reply sound (Settings → Chat), which can only be silenced from here, never re-enabled from there.'}
      >
        <Toggle on={settings.soundEnabled} onToggle={() => update({ soundEnabled: !settings.soundEnabled })} />
      </PrefRow>

      {settings.soundEnabled && (
        <>
          <div style={{ marginTop: 14, marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>
              {pt ? 'Toque Padrão / Fallback' : 'Default Sound Style'}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
              {SOUND_PRESETS.map(preset => {
                const active = settings.soundPreset === preset.key
                return (
                  <button
                    key={preset.key}
                    onClick={() => {
                      update({ soundPreset: preset.key })
                      playNotificationSound(preset.key, settings.soundVolume)
                    }}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 8,
                      border: active ? '1px solid var(--anthropic-orange)' : '1px solid var(--border-subtle)',
                      background: active ? 'rgba(232,105,11,0.1)' : 'var(--bg-elevated)',
                      color: active ? 'var(--anthropic-orange)' : 'var(--text-primary)',
                      textAlign: 'left',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      fontFamily: 'inherit',
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{pt ? preset.labelPt : preset.labelEn}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 }}>
                      {pt ? preset.descPt : preset.descEn}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                {settings.soundVolume > 0 ? <Volume2 size={14} /> : <VolumeX size={14} />}
                <span>{pt ? 'Volume do Som' : 'Sound Volume'}</span>
              </div>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)' }}>
                {Math.round(settings.soundVolume * 100)}%
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={settings.soundVolume}
              onChange={e => {
                const vol = parseFloat(e.target.value)
                update({ soundVolume: vol })
              }}
              style={{
                width: '100%',
                accentColor: 'var(--anthropic-orange)',
                cursor: 'pointer',
              }}
            />
          </div>
        </>
      )}

      <Divider />

      {/* Test Sound & Notification Button */}
      <div style={{ display: 'flex', justifyContent: 'flex-start', paddingTop: 6 }}>
        <button
          onClick={handleTestSoundAndNotification}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 18px',
            borderRadius: 8,
            border: '1px solid var(--border-subtle)',
            background: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.15s',
            fontFamily: 'inherit',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.borderColor = 'var(--anthropic-orange)'
            e.currentTarget.style.color = 'var(--anthropic-orange)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = 'var(--border-subtle)'
            e.currentTarget.style.color = 'var(--text-primary)'
          }}
        >
          <Sparkles size={14} style={{ color: 'var(--anthropic-orange)' }} />
          <span>{pt ? 'Testar Som e Notificação' : 'Test Sound & Notification'}</span>
        </button>
      </div>
    </div>
  )
}
