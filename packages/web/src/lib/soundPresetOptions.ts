/**
 * soundPresetOptions.ts — every sound a notification can use, with its name and a one-line
 * description in both languages. ONE list, read by Settings → Notifications and by the Nay settings
 * (`NaySettingsPanel`), so the two screens can never offer different sounds for one setting.
 */

import { NAY_SOUNDS } from './notificationSounds'
import type { SoundPreset } from './sessionNotifications'

export interface SoundPresetOption { key: SoundPreset; labelPt: string; labelEn: string; descPt: string; descEn: string }

export const SOUND_PRESET_OPTIONS: readonly SoundPresetOption[] = [
  { key: 'chime', labelPt: 'Chime Melódico', labelEn: 'Melodic Chime', descPt: 'Acorde suave triplo em C5', descEn: 'Soft triple chord in C5' },
  { key: 'soft', labelPt: 'Suave / Discreto', labelEn: 'Soft / Subtle', descPt: 'Pulso duplo de baixa frequência', descEn: 'Double low-frequency pulse' },
  { key: 'alert', labelPt: 'Alerta / Destaque', labelEn: 'Alert Tone', descPt: 'Tom triplo de atenção em E5', descEn: 'Triple attention tone in E5' },
  { key: 'ping', labelPt: 'Ping de Cristal', labelEn: 'Crystal Ping', descPt: 'Sino agudo de alta clareza', descEn: 'High clarity bell' },
  // The thirteen synthesized for the Nay button's cards (`notificationSounds.ts`).
  ...NAY_SOUNDS.map(n => ({ key: n.id as SoundPreset, labelPt: n.label.pt, labelEn: n.label.en, descPt: n.about.pt, descEn: n.about.en })),
]
