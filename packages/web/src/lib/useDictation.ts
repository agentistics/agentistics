/**
 * useDictation — the session composer's microphone, as a hook a second composer can use.
 *
 * The rules are the chat's own and live in the PURE `dictation.ts` (support probe, locale, which
 * results an event contributed, where they land in the draft, the error sentences); this hook is
 * only the recogniser's lifecycle around them. No audio leaves the browser — the recognition is the
 * browser's. `onText` receives each SETTLED phrase; the interim guess is `heard` and is never
 * written anywhere.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { dictationError, dictationLocale, dictationSupport, splitDictation } from './dictation'

type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean
  start: () => void; stop: () => void; abort?: () => void
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error?: string }) => void) | null
}

export function useDictation(lang: 'en' | 'pt', onText: (settled: string) => void) {
  const support = useMemo(
    () => dictationSupport(typeof window === 'undefined' ? undefined : (window as never), lang),
    [lang],
  )
  const [listening, setListening] = useState(false)
  const [heard, setHeard] = useState('')
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<Recognition | null>(null)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const stop = useCallback(() => {
    const rec = ref.current
    if (!rec) return
    rec.onresult = null
    ref.current = null
    try { (rec.abort ?? rec.stop).call(rec) } catch { /* already ended */ }
    setListening(false); setHeard('')
  }, [])

  const toggle = useCallback(() => {
    if (ref.current) { ref.current.stop(); return }
    const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!Ctor) return
    try {
      const rec = new Ctor()
      rec.lang = dictationLocale(lang)
      rec.continuous = true
      rec.interimResults = true
      rec.onresult = e => {
        const { final, interim } = splitDictation(e)
        if (final !== '') onTextRef.current(final)
        setHeard(interim)
      }
      const done = () => { setListening(false); setHeard(''); ref.current = null }
      rec.onend = done
      rec.onerror = e => { done(); const why = dictationError(e?.error ?? 'unknown', lang); if (why) setError(why) }
      setError(null)
      rec.start()
      ref.current = rec
      setListening(true)
    } catch {
      setListening(false)
    }
  }, [lang])

  useEffect(() => stop, [stop])
  return { support, listening, heard, error, toggle, stop }
}
