import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { Filters } from '@agentistics/core'
import type { ExtraDimension, ExtraFilters } from '../lib/extraFilters'

const filters: Filters = { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] }
let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Bar: typeof import('./FiltersBar').FiltersBar

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  Bar = (await import('./FiltersBar')).FiltersBar
})
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
afterAll(async () => GlobalRegistrator.unregister())

const dims = (sel: { version: string[]; group: string[] }, log: string[]): ExtraFilters => {
  const version: ExtraDimension = {
    id: 'version', label: 'Version', mode: 'multi', selected: sel.version, onChange: v => log.push(`version=${v.join(',')}`),
    options: [{ value: '2.201.0', label: '2.201.0' }, { value: '2.200.0', label: '2.200.0' }],
  }
  const group: ExtraDimension = {
    id: 'group', label: 'Group by', mode: 'single', selected: sel.group, neutral: 'day', onChange: v => log.push(`group=${v.join(',')}`),
    options: [{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }],
  }
  return { dims: [version, group], clear: () => log.push('clear') }
}

const mount = async (extra: ExtraFilters | undefined) => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => {
    root!.render(createElement(Bar, { filters, onChange: () => {}, projects: [], sessionCountByProject: {}, models: [], users: [], lang: 'en', only: ['harnesses'], ...(extra ? { extra } : {}) }))
  })
}
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click() }) }
const addFilter = () => document.querySelector('button[title="Add filter"]')
const menuLabels = () => Array.from(document.querySelectorAll('[role="menu"] button')).map(b => b.textContent?.trim())

test('without `extra` the + Filter menu is exactly what the page always had', async () => {
  await mount(undefined)
  await click(addFilter())
  expect(menuLabels()).not.toContain('Version')
  expect(menuLabels()).not.toContain('Group by')
})

test('with `extra` the menu offers the page-only dimensions, and picking a value reports it', async () => {
  const log: string[] = []
  await mount(dims({ version: [], group: ['day'] }, log))
  await click(addFilter())
  expect(menuLabels()).toEqual(['Version', 'Group by'])
  await click(Array.from(document.querySelectorAll('[role="menu"] button')).find(b => b.textContent?.includes('Version')))
  const rows = Array.from(document.querySelectorAll('button')).filter(b => b.textContent === '2.201.0' || b.textContent === '2.200.0')
  expect(rows.map(b => b.textContent)).toEqual(['2.201.0', '2.200.0'])
  await click(rows[0])
  expect(log).toEqual(['version=2.201.0'])
})

test('a single-choice dimension at its neutral value is not a filter: no badge, no chip row', async () => {
  await mount(dims({ version: [], group: ['day'] }, []))
  expect(addFilter()!.textContent).not.toMatch(/\d/)
  expect(document.querySelector('span[title="Day"]')).toBeNull() // the neutral value draws no chip
})

test('an active extra dimension counts in the badge, draws its own chip row, and "clear" reaches the page', async () => {
  const log: string[] = []
  await mount(dims({ version: ['2.201.0'], group: ['week'] }, log))
  expect(addFilter()!.textContent).toContain('2')
  expect(document.body.textContent).toContain('Version')
  expect(document.body.textContent).toContain('2.201.0')
  expect(document.body.textContent).toContain('Week')
  await click(Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Clear filters')))
  expect(log).toContain('clear')
})

test('removing a chip returns a single-choice dimension to its neutral value', async () => {
  const log: string[] = []
  await mount(dims({ version: [], group: ['week'] }, log))
  await click(document.querySelector('span[title="Week"] button'))
  expect(log).toEqual(['group=day'])
})
