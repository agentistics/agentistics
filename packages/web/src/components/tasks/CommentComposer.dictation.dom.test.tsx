/**
 * Pressing Send while dictating sends what was said — once — and nothing arriving later touches
 * the field (owner, 2026-11-27). The recogniser is a fake that, like Chrome, settles the audio it
 * holds only AFTER `stop()`; an `abort()` discards it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement, useState } from 'react'
import type { Root } from 'react-dom/client'

type Ev = { resultIndex: number; results: unknown }
class FakeRec {
  static last: FakeRec | null = null
  static settleOnStop = true
  lang = ''; continuous = false; interimResults = false
  onresult: ((e: Ev) => void) | null = null
  onend: (() => void) | null = null
  onerror: ((e: { error?: string }) => void) | null = null
  interim = ''
  constructor() { FakeRec.last = this }
  start() {}
  emit(text: string, isFinal: boolean) {
    if (!isFinal) this.interim = text
    this.onresult?.({ resultIndex: 0, results: Object.assign([Object.assign([{ transcript: text }], { isFinal })], { length: 1 }) })
  }
  stop() {
    if (!FakeRec.settleOnStop) return
    // Chrome finalises the pending audio a moment after stop, then ends.
    setTimeout(() => { this.emit(this.interim + ' end', true); this.onend?.() }, 10)
  }
  abort() { this.onerror?.({ error: 'aborted' }); this.onend?.() }
}

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Composer: typeof import('./CommentComposer').CommentComposer

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRec
  createRoot = (await import('react-dom/client')).createRoot
  Composer = (await import('./CommentComposer')).CommentComposer
})
beforeEach(() => { FakeRec.last = null; FakeRec.settleOnStop = true })
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
afterAll(async () => GlobalRegistrator.unregister())

let current = ''
async function mount(sent: string[], fail = false) {
  current = ''
  function Host() {
    const [value, setValue] = useState('')
    current = value
    return createElement(Composer, {
      lang: 'en', value, onChange: v => { setValue(v) }, attachments: [], onAttachments: () => {},
      ariaLabel: 'Comment', placeholder: '', submitLabel: 'Send', busy: false,
      // A failed send leaves the text where it is; a successful one clears it, like the real callers.
      onSubmit: () => { sent.push(value); if (!fail) setValue('') },
    })
  }
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(createElement(Host)))
}
const btn = (label: string) => document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

async function speak(text: string) {
  await act(async () => btn('Dictate').click())
  await act(async () => FakeRec.last!.emit(text, false))
}

test('(1) interim only + Send button → sent once with the full text', async () => {
  const sent: string[] = []
  await mount(sent)
  await speak('hello world')
  expect(btn('Send').disabled).toBe(false)
  await act(async () => { btn('Send').click(); await wait(60) })
  expect(sent).toEqual(['hello world end'])
  expect(current).toBe('')
})

test('(2) a result arriving after the send is not re-inserted', async () => {
  const sent: string[] = []
  await mount(sent)
  await speak('first message')
  const rec = FakeRec.last!
  await act(async () => { btn('Send').click(); await wait(60) })
  await act(async () => { rec.emit('ghost', true); rec.onend?.() })
  expect(sent).toEqual(['first message end'])
  expect(current).toBe('')
})

test('(3) Enter sends the same way', async () => {
  const sent: string[] = []
  await mount(sent)
  await speak('by keyboard')
  const ta = document.querySelector('textarea')!
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await wait(60)
  })
  expect(sent).toEqual(['by keyboard end'])
})

test('(4) a failed send keeps the dictated text in the field', async () => {
  const sent: string[] = []
  await mount(sent, true)
  await speak('keep me')
  await act(async () => { btn('Send').click(); await wait(60) })
  expect(sent).toEqual(['keep me end'])
  expect(current).toBe('keep me end')
})

test('a recogniser that never settles still sends the interim after the bounded wait', async () => {
  FakeRec.settleOnStop = false
  const sent: string[] = []
  await mount(sent)
  await speak('stuck recogniser')
  await act(async () => { btn('Send').click(); await wait(1700) })
  expect(sent).toEqual(['stuck recogniser'])
})

async function type(text: string) {
  const ta = document.querySelector('textarea')!
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value')!.set!
  await act(async () => { setter.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true })) })
}

test('typed text, then dictation, then a FAILED send → the field keeps typed text + tail', async () => {
  const sent: string[] = []
  await mount(sent, true)
  await type('typed ')
  expect(current).toBe('typed ')
  await speak('tail')
  await act(async () => { btn('Send').click(); await wait(60) })
  expect(sent).toEqual(['typed tail end'])
  expect(current).toBe('typed tail end')
})

test('a second press arriving WHILE the first awaits the tail sends exactly once, with the tail', async () => {
  // The recogniser settles only when the test says so — after the second press.
  FakeRec.settleOnStop = false
  const sent: string[] = []
  await mount(sent)
  await type('typed ')
  await speak('tail')
  const rec = FakeRec.last!
  await act(async () => { btn('Send').click(); await wait(5) })
  // First press is waiting on the recogniser; the re-render has already happened.
  await act(async () => { btn('Send').click(); await wait(5) })
  await act(async () => { rec.emit('tail settled', true); rec.onend?.(); await wait(20) })
  expect(sent).toEqual(['typed tail settled'])
})

test('a second press while finishing does not send twice', async () => {
  const sent: string[] = []
  await mount(sent)
  await speak('once')
  await act(async () => { btn('Send').click(); btn('Send').click(); await wait(60) })
  expect(sent).toEqual(['once end'])
})
