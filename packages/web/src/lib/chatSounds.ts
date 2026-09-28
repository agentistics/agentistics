// Chat notification sounds
// All sounds are synthesized via Web Audio API — no audio files needed.
//
// VOLUME: every preset ran its individual tones straight into `ctx.destination` at a hardcoded
// peak gain, so there was nowhere for a volume preference to apply — the one volume slider in the
// app (Settings -> Notifications -> Sound Effects) never touched this file. Each preset now builds
// a single master `GainNode`, scaled by the caller's `volume` (via `clampVolume`), that every tone
// routes through before reaching the destination — the same gain-staging `sessionNotifications.ts`'s
// `playNotificationSound` already used. Gain nodes chained this way MULTIPLY, so the relative
// balance between a preset's own tones/overtones is preserved and only the overall loudness scales.

import { clampVolume } from './soundVolume'

export interface ChatSound {
  id: string
  label: { en: string; pt: string }
  play(ctx: AudioContext, volume: number): void
}

export const CHAT_SOUNDS: ChatSound[] = [
  {
    id: 'ping',
    label: { en: 'Ping', pt: 'Ping' },
    play(ctx, volume) {
      // Short high sine wave — the original default
      ctx.resume().then(() => {
        const now = ctx.currentTime
        const masterGain = ctx.createGain()
        masterGain.gain.setValueAtTime(clampVolume(volume, 1), now)
        masterGain.connect(ctx.destination)
        const playTone = (freq: number, start: number, dur: number) => {
          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          osc.connect(gain)
          gain.connect(masterGain)
          osc.type = 'sine'
          osc.frequency.value = freq
          gain.gain.setValueAtTime(0, start)
          gain.gain.linearRampToValueAtTime(0.18, start + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.001, start + dur)
          osc.start(start)
          osc.stop(start + dur)
        }
        playTone(880,  now,        0.25)
        playTone(1100, now + 0.12, 0.25)
      }).catch(() => { /* ignore */ })
    },
  },
  {
    id: 'chime',
    label: { en: 'Chime', pt: 'Chime' },
    play(ctx, volume) {
      // Two-tone ascending ding
      ctx.resume().then(() => {
        const now = ctx.currentTime
        const masterGain = ctx.createGain()
        masterGain.gain.setValueAtTime(clampVolume(volume, 1), now)
        masterGain.connect(ctx.destination)
        const playTone = (freq: number, start: number, dur: number, vol = 0.2) => {
          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          osc.connect(gain)
          gain.connect(masterGain)
          osc.type = 'sine'
          osc.frequency.value = freq
          gain.gain.setValueAtTime(0, start)
          gain.gain.linearRampToValueAtTime(vol, start + 0.01)
          gain.gain.exponentialRampToValueAtTime(0.001, start + dur)
          osc.start(start)
          osc.stop(start + dur)
        }
        // Ascending: C5 → E5 → G5
        playTone(523.25, now,        0.3,  0.15)
        playTone(659.25, now + 0.14, 0.3,  0.18)
        playTone(783.99, now + 0.28, 0.45, 0.22)
      }).catch(() => { /* ignore */ })
    },
  },
  {
    id: 'soft',
    label: { en: 'Soft', pt: 'Suave' },
    play(ctx, volume) {
      // Gentle low-frequency warm tone
      ctx.resume().then(() => {
        const now = ctx.currentTime
        const masterGain = ctx.createGain()
        masterGain.gain.setValueAtTime(clampVolume(volume, 1), now)
        masterGain.connect(ctx.destination)
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain)
        gain.connect(masterGain)
        osc.type = 'sine'
        osc.frequency.value = 330
        gain.gain.setValueAtTime(0, now)
        gain.gain.linearRampToValueAtTime(0.15, now + 0.05)
        gain.gain.linearRampToValueAtTime(0.12, now + 0.2)
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.7)
        osc.start(now)
        osc.stop(now + 0.7)
      }).catch(() => { /* ignore */ })
    },
  },
  {
    id: 'bell',
    label: { en: 'Bell', pt: 'Sino' },
    play(ctx, volume) {
      // Decaying bell-like tone using two oscillators (fundamental + overtone)
      ctx.resume().then(() => {
        const now = ctx.currentTime
        const masterGain = ctx.createGain()
        masterGain.gain.setValueAtTime(clampVolume(volume, 1), now)
        masterGain.connect(ctx.destination)
        const playPartial = (freq: number, vol: number, decay: number) => {
          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          osc.connect(gain)
          gain.connect(masterGain)
          osc.type = 'sine'
          osc.frequency.value = freq
          gain.gain.setValueAtTime(vol, now)
          gain.gain.exponentialRampToValueAtTime(0.001, now + decay)
          osc.start(now)
          osc.stop(now + decay)
        }
        playPartial(660,  0.22, 1.2)   // fundamental
        playPartial(1320, 0.10, 0.6)   // octave overtone
        playPartial(1980, 0.05, 0.3)   // second overtone
      }).catch(() => { /* ignore */ })
    },
  },
  {
    id: 'pop',
    label: { en: 'Pop', pt: 'Pop' },
    play(ctx, volume) {
      // Short click/pop sound via noise burst
      ctx.resume().then(() => {
        const now = ctx.currentTime
        const masterGain = ctx.createGain()
        masterGain.gain.setValueAtTime(clampVolume(volume, 1), now)
        masterGain.connect(ctx.destination)
        const bufSize = ctx.sampleRate * 0.05
        const buffer = ctx.createBuffer(1, bufSize, ctx.sampleRate)
        const data = buffer.getChannelData(0)
        for (let i = 0; i < bufSize; i++) {
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufSize, 6)
        }
        const source = ctx.createBufferSource()
        source.buffer = buffer
        const gain = ctx.createGain()
        source.connect(gain)
        gain.connect(masterGain)
        gain.gain.setValueAtTime(0.35, now)
        source.start(now)
      }).catch(() => { /* ignore */ })
    },
  },
]

export const DEFAULT_CHAT_SOUND_ID = 'ping'

export function findChatSound(id: string): ChatSound {
  return CHAT_SOUNDS.find(s => s.id === id) ?? CHAT_SOUNDS[0]!
}
