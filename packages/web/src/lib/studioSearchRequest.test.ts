import { beforeEach, describe, expect, test } from 'bun:test'
import {
  getStudioSearchRequest, requestStudioSearch, resetStudioSearchRequest, runStudioShortcut,
  subscribeStudioSearchRequest,
} from './studioSearchRequest'
import {
  answerUnsaved, getUnsaved, reportUnsaved, resetUnsaved,
} from './unsavedBuffers'
import { getPanelLayout, isPanelShown, resetPanelSlots } from './panelSlots'

describe('requestStudioSearch — the signal, and its subscribers', () => {
  beforeEach(resetStudioSearchRequest)

  test('starts at zero — "no request has ever been made"', () => {
    expect(getStudioSearchRequest()).toBe(0)
  })

  test('every request is a new, strictly increasing stamp', () => {
    requestStudioSearch()
    const first = getStudioSearchRequest()
    expect(first).toBeGreaterThan(0)
    requestStudioSearch()
    expect(getStudioSearchRequest()).toBeGreaterThan(first)
  })

  test('notifies every subscriber', () => {
    let notified = 0
    const unsub = subscribeStudioSearchRequest(() => { notified += 1 })
    requestStudioSearch()
    expect(notified).toBe(1)
    unsub()
  })
})

describe('runStudioShortcut', () => {
  beforeEach(() => { resetPanelSlots(); resetUnsaved(); resetStudioSearchRequest() })

  test('toggle: closed anywhere opens it, in its last slot', () => {
    runStudioShortcut('toggle')
    expect(isPanelShown(getPanelLayout(), 'studio')).toBe(true)
  })

  test('toggle: open anywhere closes it', () => {
    runStudioShortcut('toggle')
    runStudioShortcut('toggle')
    expect(isPanelShown(getPanelLayout(), 'studio')).toBe(false)
  })

  test('toggle asks first when a buffer is dirty — the same hold every other close goes through', () => {
    runStudioShortcut('toggle') // open it
    reportUnsaved('studio', ['README.md'])
    runStudioShortcut('toggle') // close it
    expect(isPanelShown(getPanelLayout(), 'studio')).toBe(true) // held
    expect(getUnsaved().question).toEqual({ cause: 'close' })
    answerUnsaved(true)
    expect(isPanelShown(getPanelLayout(), 'studio')).toBe(false)
  })

  test('search: opens the Studio if it was not already shown', () => {
    expect(isPanelShown(getPanelLayout(), 'studio')).toBe(false)
    runStudioShortcut('search')
    expect(isPanelShown(getPanelLayout(), 'studio')).toBe(true)
  })

  test('search: fires the request every time, whether or not the Studio had to open', () => {
    runStudioShortcut('search')
    const first = getStudioSearchRequest()
    runStudioShortcut('search') // already open — still a fresh request
    expect(getStudioSearchRequest()).toBeGreaterThan(first)
  })

  test('search never asks about unsaved buffers — nothing is displaced or closed by it', () => {
    runStudioShortcut('toggle')
    reportUnsaved('studio', ['README.md'])
    runStudioShortcut('search')
    expect(getUnsaved().question).toBeNull()
    expect(isPanelShown(getPanelLayout(), 'studio')).toBe(true)
  })
})
