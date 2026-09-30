/**
 * notificationSounds.ts — the thirteen session-notification sounds, SYNTHESIZED.
 *
 * No audio file ships with any of them, so none needs a licence: each one is a few oscillators, an
 * FM pair or a burst of filtered noise, built at the moment it plays. That is the rule
 * `chatSounds.ts` already follows for the chat, applied to the sounds a SESSION makes.
 *
 * Every sound takes the context and the node to play INTO, and a start time. It never creates its
 * own destination and never reads the clock, which is what lets the settings screen render one into
 * an `OfflineAudioContext` to draw its waveform — the picture is the sound itself, not a drawing of
 * what it is meant to be.
 *
 * `fit` is the event each sound was designed for and is only ever a SUGGESTION on the settings
 * screen; the defaults per event live in `sessionNotifications.ts`, beside the rest of the settings.
 */

export type NaySoundId =
  | 'kalimba' | 'marimba' | 'triad' | 'question' | 'nay' | 'deskbell' | 'glass'
  | 'drop' | 'bubble' | 'sonar' | 'harp' | 'tap' | 'breeze'

export type NaySoundFit = 'turn' | 'approval' | 'stale'

export interface NaySound {
  id: NaySoundId
  label: { pt: string; en: string }
  about: { pt: string; en: string }
  /** Seconds, rounded — the length the waveform is rendered over. */
  length: number
  fit: NaySoundFit
  play: (ctx: BaseAudioContext, out: AudioNode, t: number) => void
}

interface ToneOpts {
  f: number
  /** Glide target. */
  f2?: number
  glide?: number
  type?: OscillatorType
  t: number
  atk?: number
  dec?: number
  peak?: number
}

function envelope(g: GainNode, t: number, peak: number, atk: number, dec: number): void {
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(peak, t + atk)
  g.gain.exponentialRampToValueAtTime(0.0001, t + atk + dec)
}

function tone(ctx: BaseAudioContext, out: AudioNode, o: ToneOpts): OscillatorNode {
  const atk = o.atk ?? 0.005, dec = o.dec ?? 0.4
  const osc = ctx.createOscillator(), g = ctx.createGain()
  osc.type = o.type ?? 'sine'
  osc.frequency.setValueAtTime(o.f, o.t)
  if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, o.t + (o.glide ?? dec))
  envelope(g, o.t, o.peak ?? 0.3, atk, dec)
  osc.connect(g); g.connect(out)
  osc.start(o.t); osc.stop(o.t + atk + dec + 0.05)
  return osc
}

function noise(ctx: BaseAudioContext, out: AudioNode, o: { t: number; dur: number; f: number; q: number; peak: number; atk?: number }): void {
  const len = Math.ceil(ctx.sampleRate * (o.dur + 0.05))
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  const src = ctx.createBufferSource(), flt = ctx.createBiquadFilter(), g = ctx.createGain()
  src.buffer = buf
  flt.type = 'bandpass'; flt.frequency.value = o.f; flt.Q.value = o.q
  envelope(g, o.t, o.peak, o.atk ?? 0.003, o.dur)
  src.connect(flt); flt.connect(g); g.connect(out)
  src.start(o.t); src.stop(o.t + o.dur + 0.05)
}

/** A bell: a carrier whose frequency is swung by a modulator, the swing decaying with the note. */
function fm(ctx: BaseAudioContext, out: AudioNode, o: { f: number; ratio: number; index: number; t: number; dec: number; peak: number }): void {
  const car = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain(), g = ctx.createGain()
  car.frequency.value = o.f
  mod.frequency.value = o.f * o.ratio
  mg.gain.setValueAtTime(o.f * o.index, o.t)
  mg.gain.exponentialRampToValueAtTime(1, o.t + o.dec)
  mod.connect(mg); mg.connect(car.frequency)
  envelope(g, o.t, o.peak, 0.003, o.dec)
  car.connect(g); g.connect(out)
  for (const x of [car, mod]) { x.start(o.t); x.stop(o.t + o.dec + 0.05) }
}

export const NAY_SOUNDS: readonly NaySound[] = [
  {
    id: 'kalimba', fit: 'turn', length: 1.1,
    label: { pt: 'Kalimba', en: 'Kalimba' },
    about: { pt: 'Duas lâminas beliscadas, subindo uma quinta.', en: 'Two plucked tines, rising a fifth.' },
    play(c, o, t) {
      for (const [f, d] of [[880, 0], [1318.5, 0.12]] as const) {
        tone(c, o, { f, t: t + d, dec: 0.7, peak: 0.32 })
        tone(c, o, { f: f * 2.76, t: t + d, dec: 0.18, peak: 0.07 })
      }
    },
  },
  {
    id: 'marimba', fit: 'turn', length: 0.8,
    label: { pt: 'Marimba', en: 'Marimba' },
    about: { pt: 'Madeira quente, duas notas curtas.', en: 'Warm wood, two short notes.' },
    play(c, o, t) {
      for (const [f, d] of [[523.25, 0], [783.99, 0.11]] as const) {
        tone(c, o, { f, t: t + d, dec: 0.38, peak: 0.34 })
        tone(c, o, { f: f * 4, t: t + d, dec: 0.06, peak: 0.08 })
      }
    },
  },
  {
    id: 'triad', fit: 'turn', length: 1.1,
    label: { pt: 'Tríade', en: 'Triad' },
    about: { pt: 'Arpejo maior subindo. Sensação de concluído.', en: 'A rising major arpeggio. Sounds finished.' },
    play(c, o, t) {
      ;[523.25, 659.25, 783.99].forEach((f, i) => tone(c, o, { f, type: 'triangle', t: t + i * 0.09, dec: 0.55, peak: 0.2 }))
    },
  },
  {
    id: 'question', fit: 'approval', length: 0.9,
    label: { pt: 'Pergunta', en: 'Question' },
    about: { pt: 'Duas notas com a entonação subindo no fim, como quem pergunta.', en: 'Two notes rising at the end, like a question.' },
    play(c, o, t) {
      tone(c, o, { f: 659.25, t, dec: 0.22, peak: 0.26 })
      tone(c, o, { f: 880, f2: 990, glide: 0.25, t: t + 0.17, dec: 0.45, peak: 0.28 })
    },
  },
  {
    id: 'nay', fit: 'approval', length: 1,
    label: { pt: 'Nay chama', en: 'Nay calls' },
    about: { pt: 'Um “ê-ei” de duas alturas com leve vibrato.', en: 'A two-pitch “hey” with a light vibrato.' },
    play(c, o, t) {
      tone(c, o, { f: 587.33, f2: 600, t, dec: 0.2, peak: 0.22 })
      const b = tone(c, o, { f: 740, f2: 880, glide: 0.12, t: t + 0.16, dec: 0.55, peak: 0.26 })
      const lfo = c.createOscillator(), lg = c.createGain()
      lfo.frequency.value = 6; lg.gain.value = 9
      lfo.connect(lg); lg.connect(b.frequency)
      lfo.start(t + 0.16); lfo.stop(t + 0.8)
    },
  },
  {
    id: 'deskbell', fit: 'approval', length: 1.4,
    label: { pt: 'Campainha', en: 'Desk bell' },
    about: { pt: 'Sino de balcão metálico. O mais insistente.', en: 'A metal counter bell. The most insistent.' },
    play(c, o, t) {
      fm(c, o, { f: 2093, ratio: 1.41, index: 3, t, dec: 1.2, peak: 0.18 })
      fm(c, o, { f: 2093, ratio: 1.41, index: 2, t: t + 0.16, dec: 1, peak: 0.1 })
    },
  },
  {
    id: 'glass', fit: 'turn', length: 1.6,
    label: { pt: 'Vidro', en: 'Glass' },
    about: { pt: 'Taça tocada de leve, com cauda longa.', en: 'A glass tapped lightly, with a long tail.' },
    play(c, o, t) {
      tone(c, o, { f: 1567.98, t, dec: 1.4, peak: 0.2 })
      tone(c, o, { f: 1567.98 * 2.32, t, dec: 0.7, peak: 0.05 })
      tone(c, o, { f: 1567.98 * 4.25, t, dec: 0.3, peak: 0.03 })
    },
  },
  {
    id: 'drop', fit: 'turn', length: 0.5,
    label: { pt: 'Gota', en: 'Drop' },
    about: { pt: 'Uma gota caindo e uma menor atrás.', en: 'A drop, and a smaller one after it.' },
    play(c, o, t) {
      tone(c, o, { f: 1300, f2: 420, glide: 0.11, t, dec: 0.16, peak: 0.3 })
      tone(c, o, { f: 1600, f2: 700, glide: 0.08, t: t + 0.1, dec: 0.12, peak: 0.14 })
    },
  },
  {
    id: 'bubble', fit: 'turn', length: 0.5,
    label: { pt: 'Bolha', en: 'Bubble' },
    about: { pt: 'Duas bolhas subindo rápido.', en: 'Two bubbles rising fast.' },
    play(c, o, t) {
      tone(c, o, { f: 320, f2: 980, glide: 0.08, t, dec: 0.12, peak: 0.26 })
      tone(c, o, { f: 420, f2: 1250, glide: 0.07, t: t + 0.1, dec: 0.12, peak: 0.2 })
    },
  },
  {
    id: 'sonar', fit: 'stale', length: 1.3,
    label: { pt: 'Sonar', en: 'Sonar' },
    about: { pt: 'Um ping com dois ecos se afastando. Discreto.', en: 'A ping with two fading echoes. Discreet.' },
    play(c, o, t) {
      for (const [p, d] of [[0.3, 0], [0.12, 0.24], [0.045, 0.48]] as const) tone(c, o, { f: 1046.5, t: t + d, dec: 0.45, peak: p })
    },
  },
  {
    id: 'harp', fit: 'turn', length: 1.2,
    label: { pt: 'Harpa', en: 'Harp' },
    about: { pt: 'Glissando pentatônico de cinco cordas.', en: 'A five-string pentatonic glissando.' },
    play(c, o, t) {
      ;[587.33, 659.25, 783.99, 880, 1046.5].forEach((f, i) => tone(c, o, { f, type: 'triangle', t: t + i * 0.045, dec: 0.7, peak: 0.14 }))
    },
  },
  {
    id: 'tap', fit: 'stale', length: 0.4,
    label: { pt: 'Toque duplo', en: 'Double tap' },
    about: { pt: 'Dois toques secos, sem melodia.', en: 'Two dry knocks, no melody.' },
    play(c, o, t) {
      for (const d of [0, 0.13]) {
        noise(c, o, { t: t + d, dur: 0.04, f: 2200, q: 2, peak: 0.5 })
        tone(c, o, { f: 1800, t: t + d, dec: 0.05, peak: 0.12 })
      }
    },
  },
  {
    id: 'breeze', fit: 'stale', length: 1,
    label: { pt: 'Brisa', en: 'Breeze' },
    about: { pt: 'Um sopro de ar com uma nota suave por baixo. O menos intrusivo.', en: 'A breath of air over a soft note. The least intrusive.' },
    play(c, o, t) {
      noise(c, o, { t, dur: 0.6, f: 1400, q: 0.7, peak: 0.12, atk: 0.25 })
      tone(c, o, { f: 783.99, t: t + 0.1, atk: 0.15, dec: 0.55, peak: 0.1 })
    },
  },
]

const BY_ID = new Map<string, NaySound>(NAY_SOUNDS.map(s => [s.id, s]))

export function isNaySoundId(v: unknown): v is NaySoundId {
  return typeof v === 'string' && BY_ID.has(v)
}

export function findNaySound(id: string): NaySound | undefined {
  return BY_ID.get(id)
}
