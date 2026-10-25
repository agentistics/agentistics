import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivityIcon, activityMcpLogo } from './ActivityIcon'
import { activityIconKind, activityMcpServer, stepsOfTurn, type ActivityKind } from '../../lib/toolActivity'

const steps = (...names: string[]) => stepsOfTurn({ role: 'assistant', text: '', tools: names.map(name => ({ name })) })

test.each([
  ['Read', 'read', 'book-open'], ['Edit', 'edit', 'file-pen'], ['Write', 'write', 'file-plus'],
  ['Bash', 'run', 'square-terminal'], ['Grep', 'search', 'search'], ['WebFetch', 'web', 'globe'],
  ['save_memory', 'memory', 'brain'], ['Agent', 'delegate', 'bot'], ['TodoWrite', 'plan', 'clipboard-list'],
  ['Skill', 'skill', 'sparkles'], ['mcp__unknown__tool', 'mcp', 'plug'], ['unknown', 'other', 'wrench'],
] as const)('%s has a contextual %s icon', (name, kind, glyph) => {
  const group = steps(name)
  expect(activityIconKind(group)).toBe(kind as ActivityKind)
  expect(renderToStaticMarkup(<ActivityIcon steps={group} />)).toContain(`lucide-${glyph}`)
})

test('mixed runs use the most frequent kind, ties keep first appearance', () => {
  expect(activityIconKind(steps('Bash', 'mcp__agentistics__tasks', 'Bash'))).toBe('run')
  expect(activityIconKind(steps('Read', 'Bash', 'Bash'))).toBe('run')
  expect(activityIconKind(steps('Read', 'Bash'))).toBe('read')
  expect(activityIconKind(steps('Bash', 'Read'))).toBe('run')
  expect(activityIconKind([])).toBe('other')
})

test('MCP logo uses the dominant server, ties keep first appearance in both name formats', () => {
  const group = steps('mcp__unknown__a', 'mcp_agentistics_tasks', 'mcp__agentistics__list')
  expect(activityMcpServer(group)).toBe('agentistics')
  expect(renderToStaticMarkup(<ActivityIcon steps={group} />)).toContain('/minimalistLogo.png')
  expect(activityMcpServer(group.slice(0, 2))).toBe('unknown')
  expect(activityMcpLogo('unknown')).toBeUndefined()
  expect(activityMcpLogo(undefined)).toBeUndefined()
  expect(activityMcpServer(steps('Bash'))).toBeUndefined()
  expect(renderToStaticMarkup(<ActivityIcon steps={group.slice(0, 2)} />)).toContain('lucide-plug')
})

test('unfinished activity keeps its context', () => {
  const group = steps('Bash')
  group[0]!.status = 'unfinished'
  expect(activityIconKind(group)).toBe('run')
})
