import { test, expect } from 'bun:test'
import { visibleSettingsSections, SETTINGS_SECTIONS } from './settingsSections'

const ids = (v: Parameters<typeof visibleSettingsSections>[0]) => visibleSettingsSections(v).map(s => s.id)

test('default viewer: the personal sections, no providers/memory until the native runtime is known', () => {
  expect(ids({})).toEqual(['preferences', 'accessibility', 'notifications', 'sessions', 'data-sources', 'backup', 'harnesses', 'pricing', 'install', 'whatsnew', 'chat'])
})

test('every section is personal', () => {
  for (const section of SETTINGS_SECTIONS) expect(section.group).toBe('personal')
})

test('there is no Billing section: plans live on each account in Usage → Accounts (CONTAS.MAC.NOVO)', () => {
  expect(SETTINGS_SECTIONS.map(s => s.id as string)).not.toContain('billing')
  expect(ids({})).not.toContain('billing')
})

// Two gates, not one — `localChat` (the exposure profile) gates the SECTION; `chatEnabled` (the
// user's own switch, not modeled here) gates the sound/model rows drawn inside it.
test('chat is offered when the profile allows it, and while it is not yet known', () => {
  expect(ids({ localChat: true })).toContain('chat')
  // The section holds the enable switch: hiding it when chat is merely OFF would make it unreachable.
  expect(ids({ localChat: undefined })).toContain('chat')
})

test('chat is absent when the exposure profile denies localChat — there is nothing to switch', () => {
  expect(ids({ localChat: false })).not.toContain('chat')
})

test('providers and memory are hidden on a community build and while unknown — UI.2', () => {
  expect(ids({ nativeRuntime: false })).not.toContain('providers')
  expect(ids({ nativeRuntime: false })).not.toContain('memory')
  expect(ids({})).not.toContain('providers')
  expect(ids({ nativeRuntime: true })).toContain('providers')
  expect(ids({ nativeRuntime: true })).toContain('memory')
})

test('the other sections are unaffected by chat being denied', () => {
  expect(ids({ localChat: false })).toContain('preferences')
  expect(ids({ localChat: false })).toContain('notifications')
})

test('experimental is not a settings section', () => {
  expect(SETTINGS_SECTIONS.some(s => String(s.id) === 'experimental')).toBe(false)
})
