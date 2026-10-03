/**
 * useDictation — the browser's own speech recognition, appended to a draft (the native chat's
 * microphone, UI.3). The decisions are `lib/dictation.ts`'s (pure, tested, shared with the fleet
 * chat's composer): which results an event contributed, where they land, what an error says. No
 * audio leaves the browser; nothing is sent until the person sends.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { appendDictation, dictationError, dictationLocale, dictationSupport, splitDictation } from '../lib/dictation'

type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean
  start: () => void; stop: () => void; abort?: () => void
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error?: string }) => void) | null
}

export function useDictation(lang: 'pt' | 'en', editDraft: (f: (d: string) => string) => void, onError: (sentence: string) => void) {
  const support = useMemo(() => dictationSupport(typeof window === 'undefined' ? undefined : (window as never), lang), [lang])
  const [listening, setListening] = useState(false)
  const rec = useRef<Recognition | null>(null)

  const toggle = useCallback(() => {
    if (listening) { rec.current?.stop(); return }
    const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!Ctor) return
    try {
      const r = new Ctor()
      r.lang = dictationLocale(lang)
      r.continuous = true
      r.interimResults = true
      r.onresult = e => {
        const { final } = splitDictation(e as never)
        if (final !== '') editDraft(d => appendDictation(d, final))
      }
      r.onend = () => { setListening(false); rec.current = null }
      r.onerror = e => {
        setListening(false)
        rec.current = null
        const why = dictationError(e?.error ?? 'unknown', lang)
        if (why) onError(why)
      }
      r.start()
      rec.current = r
      setListening(true)
    } catch {
      setListening(false)
    }
  }, [listening, lang, editDraft, onError])

  /** Sending ends the dictation (see the fleet composer): detach, then discard what was not settled. */
  const end = useCallback(() => {
    const r = rec.current
    if (!r) return
    r.onresult = null
    rec.current = null
    ;(r.abort ?? r.stop).call(r)
    setListening(false)
  }, [])

  return { ready: support.state === 'ready', listening, toggle, end }
}
