/**
 * Settings → Notifications — WHAT notifies, and how it sounds (owner, 2026-09-30).
 *
 * In-app only: the Nay button's card, its sound and the header bell. Operating-system notifications
 * (the browser permission, the "system notification while the tab is hidden" switch) are gone from
 * the web app; a desktop delivery when no browser is open belongs to `agentop events`.
 *
 * "What notifies" is chosen at two levels: the SESSIONS switch with a switch per kind of session
 * event (each with its own sound), and a switch per CATEGORY of everything else the bell carries
 * (`notificationCategories.ts`) — so a person can turn off the general ones or one specific kind.
 * Everything about the Nay button itself (how the card appears, its sounds per Nay/other sessions,
 * how long it stays) lives in Settings → Chat, and this page says so.
 */
import React, { useState, useEffect } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import type { AppContext } from '../../lib/app-context'
import {
  getNotificationSettings,
  saveNotificationSettings,
  subscribeNotificationSettings,
  playNotificationSound,
  previewNayNotification,
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  type SoundPreset,
  type NotifyEvent,
} from '../../lib/sessionNotifications'
import { SOUND_PRESET_OPTIONS } from '../../lib/soundPresetOptions'
import { NOTIFICATION_CATEGORIES } from '../../lib/notificationCategories'
import { formatSpan, STALE_OPTIONS_MIN } from '../../lib/nayNotify'
import { SectionHeader, Divider, PrefRow, Toggle, Select } from './primitives'
import { ArrowUpRight, Volume2, VolumeX, Sparkles, AlertCircle, Clock, Activity, XCircle, Hourglass } from 'lucide-react'

export default function NotificationsSettings() {
  const ctx = useOutletContext<AppContext>()
  const pt = ctx.lang === 'pt'

  const [settings, setSettings] = useState<NotificationSettings>(getNotificationSettings)
  useEffect(() => subscribeNotificationSettings(() => setSettings(getNotificationSettings())), [])

  function update(partial: Partial<NotificationSettings>) {
    const next = { ...settings, ...partial }
    setSettings(next)
    saveNotificationSettings(next)
  }

  function updateEvent(eventKey: keyof NotificationSettings['events'], value: boolean) {
    update({ events: { ...settings.events, [eventKey]: value } })
  }

  function updateEventSound(eventKey: NotifyEvent, value: SoundPreset) {
    update({ eventSounds: { ...(settings.eventSounds || DEFAULT_NOTIFICATION_SETTINGS.eventSounds), [eventKey]: value } })
  }

  const muted = new Set(settings.mutedCategories ?? [])
  function setCategory(id: string, on: boolean) {
    const next = new Set(muted)
    if (on) next.delete(id); else next.add(id)
    update({ mutedCategories: [...next] })
  }

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
      key: 'waiting-approval', titlePt: 'Pede aprovação', titleEn: 'Needs approval', color: '#ef4444',
      icon: <AlertCircle size={15} style={{ color: '#ef4444' }} />,
      descPt: 'Uma sessão parou esperando você autorizar uma ação.',
      descEn: 'A session stopped, waiting for you to authorize an action.',
    },
    {
      key: 'waiting', titlePt: 'Precisa de você', titleEn: 'Needs you', color: 'var(--anthropic-orange)',
      icon: <Clock size={15} style={{ color: 'var(--anthropic-orange)' }} />,
      descPt: 'Uma sessão terminou a vez e espera sua próxima mensagem.',
      descEn: 'A session finished its turn and waits for your next message.',
    },
    {
      key: 'stale', titlePt: 'Sem abrir', titleEn: 'Not opened', color: 'var(--text-secondary)',
      icon: <Hourglass size={15} style={{ color: 'var(--text-secondary)' }} />,
      descPt: 'Uma sessão espera por você e ninguém a abriu pelo tempo escolhido.',
      descEn: 'A session waits for you and nobody opened it for the chosen time.',
    },
    {
      key: 'working', titlePt: 'Voltou a trabalhar', titleEn: 'Back at work', color: '#22c55e',
      icon: <Activity size={15} style={{ color: '#22c55e' }} />,
      descPt: 'Uma sessão começou a trabalhar de novo.',
      descEn: 'A session started working again.',
    },
    {
      key: 'exited', titlePt: 'Encerrada', titleEn: 'Closed', color: 'var(--text-secondary)',
      icon: <XCircle size={15} style={{ color: 'var(--text-tertiary)' }} />,
      descPt: 'O processo de uma sessão terminou.',
      descEn: 'A session’s process ended.',
    },
  ]

  const rowBox: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderRadius: 8,
    border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', gap: 12, flexWrap: 'wrap',
  }

  return (
    <div style={{ maxWidth: 720 }}>
      {/* Where the chat's own notification choices live — said first, so nobody hunts for them here. */}
      <Link to="/settings/chat" style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', marginBottom: 18, borderRadius: 10,
        border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', textDecoration: 'none',
        color: 'var(--text-secondary)', fontSize: 12.5, lineHeight: 1.5,
      }}>
        <span style={{ flex: 1 }}>
          {pt
            ? 'Notificações do chat ficam em Ajustes → Chat: como o cartão aparece, o som da Nay e das outras sessões, e quanto tempo ele fica.'
            : 'Chat notifications live in Settings → Chat: how the card appears, the Nay and other-session sounds, and how long it stays.'}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--anthropic-orange)', fontWeight: 600, whiteSpace: 'nowrap' }}>
          {pt ? 'Abrir' : 'Open'}<ArrowUpRight size={13} />
        </span>
      </Link>

      <SectionHeader label={pt ? 'O que notifica' : 'What notifies'} />
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 14, lineHeight: 1.6 }}>
        {pt
          ? 'Tudo aparece dentro do app: o cartão do botão Nay, o som e o sino no topo. Desligue o que não quer receber.'
          : 'Everything shows inside the app: the Nay button’s card, the sound and the bell at the top. Turn off what you do not want.'}
      </div>

      <PrefRow
        label={pt ? 'Sessões' : 'Sessions'}
        sub={pt ? 'Avisos das suas sessões. Escolha abaixo quais tipos, e o som de cada um.' : 'Notices about your sessions. Choose the kinds below, and the sound of each.'}
      >
        <Toggle on={settings.enabled} onToggle={() => update({ enabled: !settings.enabled })} />
      </PrefRow>

      {settings.enabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
          {EVENT_CONFIGS.map(evt => {
            const enabled = settings.events[evt.key] ?? true
            const currentSound = settings.eventSounds[evt.key] ?? 'chime'
            return (
              <div key={evt.key} style={rowBox}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: evt.color, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {evt.icon}<span>{pt ? evt.titlePt : evt.titleEn}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>{pt ? evt.descPt : evt.descEn}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
                  {settings.soundEnabled && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <div style={{ minWidth: 150, opacity: enabled ? 1 : 0.6 }}>
                        <Select value={currentSound} onChange={v => updateEventSound(evt.key, v as SoundPreset)} disabled={!enabled}
                          options={SOUND_PRESET_OPTIONS.map(p => ({ value: p.key, label: pt ? p.labelPt : p.labelEn }))} />
                      </div>
                      <button type="button" onClick={() => playNotificationSound(currentSound, settings.soundVolume)} disabled={!enabled}
                        aria-label={pt ? `Ouvir o som de "${evt.titlePt}"` : `Play the "${evt.titleEn}" sound`}
                        title={pt ? 'Ouvir' : 'Play'}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 7,
                          border: '1px solid var(--border-subtle)', background: 'var(--bg-surface)', padding: 0,
                          color: enabled ? 'var(--anthropic-orange)' : 'var(--text-tertiary)', cursor: enabled ? 'pointer' : 'not-allowed',
                        }}>
                        <Volume2 size={13} />
                      </button>
                    </div>
                  )}
                  {evt.key === 'stale' && (
                    <div style={{ minWidth: 110, opacity: enabled ? 1 : 0.6 }} title={pt ? 'Depois de quanto tempo sem abrir' : 'After how long unopened'}>
                      <Select value={String(settings.staleAfterMin)} onChange={v => update({ staleAfterMin: Number(v) })} disabled={!enabled}
                        options={STALE_OPTIONS_MIN.map(m => ({ value: String(m), label: m === 0 ? (pt ? 'nunca' : 'never') : formatSpan(m * 60_000) }))} />
                    </div>
                  )}
                  <Toggle on={enabled} onToggle={() => updateEvent(evt.key, !enabled)} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
        {NOTIFICATION_CATEGORIES.map(c => (
          <div key={c.id} style={rowBox}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{pt ? c.pt : c.en}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>{pt ? c.hintPt : c.hintEn}</div>
            </div>
            <Toggle on={!muted.has(c.id)} onToggle={() => setCategory(c.id, muted.has(c.id))} />
          </div>
        ))}
      </div>

      <PrefRow
        label={pt ? 'Não perturbe' : 'Do not disturb'}
        sub={pt ? 'Sem cartão e sem som. Tudo continua registrado no sino.' : 'No card and no sound. Everything is still recorded in the bell.'}
      >
        <Toggle on={settings.doNotDisturb} onToggle={() => update({ doNotDisturb: !settings.doNotDisturb })} />
      </PrefRow>

      <Divider />

      <SectionHeader label={pt ? 'Som' : 'Sound'} />
      <PrefRow
        label={pt ? 'Tocar som nas notificações' : 'Play a sound on notifications'}
        sub={pt
          ? 'A chave e o volume GERAIS: também valem para o som de resposta do chat, que só pode ser silenciado a partir daqui.'
          : 'The GLOBAL switch and volume: they also govern the chat reply sound, which can only be silenced from here.'}
      >
        <Toggle on={settings.soundEnabled} onToggle={() => update({ soundEnabled: !settings.soundEnabled })} />
      </PrefRow>

      {settings.soundEnabled && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              {settings.soundVolume > 0 ? <Volume2 size={14} /> : <VolumeX size={14} />}
              <span>{pt ? 'Volume' : 'Volume'}</span>
            </div>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)' }}>{Math.round(settings.soundVolume * 100)}%</span>
          </div>
          <input type="range" min="0" max="1" step="0.05" value={settings.soundVolume}
            aria-label={pt ? 'Volume' : 'Volume'}
            onChange={e => update({ soundVolume: parseFloat(e.target.value) })}
            style={{ width: '100%', accentColor: 'var(--anthropic-orange)', cursor: 'pointer' }} />
        </div>
      )}

      <Divider />

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', paddingTop: 6 }}>
        <button type="button" onClick={() => previewNayNotification(pt ? 'pt' : 'en')}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', borderRadius: 8,
            border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange)', color: '#fff',
            fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
          }}>
          <Sparkles size={14} />
          <span>{pt ? 'Testar uma notificação' : 'Test a notification'}</span>
        </button>
        <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          {pt ? 'Mostra o cartão de exemplo com o som de "Precisa de você".' : 'Shows the example card with the "Needs you" sound.'}
        </span>
      </div>
    </div>
  )
}
