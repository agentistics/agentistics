/**
 * soundPresetOptions.ts — every sound a notification can use, with its name and a one-line
 * description in both languages. ONE list, read by Settings → Notifications and by the Nay settings
 * (`NaySettingsPanel`), so the two screens can never offer different sounds for one setting.
 */

import { NAY_SOUNDS } from './notificationSounds'
import type { SoundPreset } from './sessionNotifications'

export interface SoundPresetOption { key: SoundPreset; labelPt: string; labelEn: string; descPt: string; descEn: string }

export const SOUND_PRESET_OPTIONS: readonly SoundPresetOption[] = [
  // Described by what they SOUND like, read off `playNotificationSound`: the old lines named a chord
  // that is really an arpeggio and a "low-frequency" pulse that sits at A4–C#5.
  { key: 'chime', labelPt: 'Chime Melódico', labelEn: 'Melodic Chime', descPt: 'Três notas suaves subindo, dó–mi–sol', descEn: 'Three soft notes rising, C–E–G' },
  { key: 'soft', labelPt: 'Suave / Discreto', labelEn: 'Soft / Subtle', descPt: 'Duas notas curtas e suaves, a segunda um pouco mais alta', descEn: 'Two short soft notes, the second a little higher' },
  { key: 'alert', labelPt: 'Alerta / Destaque', labelEn: 'Alert Tone', descPt: 'Três notas rápidas e brilhantes subindo', descEn: 'Three quick bright notes rising' },
  { key: 'ping', labelPt: 'Ping de Cristal', labelEn: 'Crystal Ping', descPt: 'Um plim agudo que sobe e some rápido', descEn: 'A high ping that rises and fades fast' },
  // The thirteen synthesized for the Nay button's cards (`notificationSounds.ts`).
  ...NAY_SOUNDS.map(n => ({ key: n.id as SoundPreset, labelPt: n.label.pt, labelEn: n.label.en, descPt: n.about.pt, descEn: n.about.en })),
]
