import { describe, expect, test } from 'bun:test'
import { parseAnthropicPricing } from './rates'

const row = (name: string, cells: string[]) =>
  `<tr><td><strong>${name}</strong><span>tagline</span></td>${cells.map(c => `<td>${c} / MTok</td>`).join('')}</tr>`

// The layout platform.claude.com shipped by 2026-09-25: Output moved to the second column.
const CURRENT = `<table>
<thead><tr><th>Model</th><th colspan="2">Base tokens</th><th colspan="3">Prompt caching</th></tr>
<tr><th>Name</th><th>Input</th><th>Output</th><th>5m writes</th><th>1h writes</th><th>Hits and refreshes</th></tr></thead>
<tbody>
${row('Claude Opus 5.5For long-running agentic coding', ['$4', '$20', '$5', '$8', '$0.20'])}
${row('Claude Sonnet 5The best combination', ['$2', '$10', '$2.50', '$4', '$0.20'])}
${row('Claude Haiku 4.5The fastest model', ['$1', '$5', '$1.25', '$2', '$0.10'])}
${row('Claude Opus 5', ['$5', '$25', '$6.25', '$10', '$0.50'])}
</tbody></table>`

// The layout the parser was written against.
const LEGACY = `<table>
<tr><th>Model</th><th>Base Input Tokens</th><th>5m Cache Writes</th><th>1h Cache Writes</th><th>Cache Hits &amp; Refreshes</th><th>Output Tokens</th></tr>
${row('Claude Sonnet 5', ['$2', '$2.50', '$4', '$0.20', '$10'])}
${row('Claude Haiku 4.5', ['$1', '$1.25', '$2', '$0.10', '$5'])}
${row('Claude Opus 5', ['$5', '$6.25', '$10', '$0.50', '$25'])}
</table>`

describe('parseAnthropicPricing', () => {
  test('reads the columns by their HEADER, not their position (current layout)', () => {
    const p = parseAnthropicPricing(CURRENT)!
    expect(p['claude-opus-5']).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
    expect(p['claude-sonnet-5']).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 })
  })

  test('still reads the legacy layout', () => {
    const p = parseAnthropicPricing(LEGACY)!
    expect(p['claude-opus-5']).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
  })

  test('"Opus 5.5" is its own model, never "Opus 5"', () => {
    const p = parseAnthropicPricing(CURRENT)!
    expect(p['claude-opus-5-5']).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })
    expect(p['claude-opus-5']!.input).toBe(5)
  })

  test('a table whose header cannot be read yields nothing, never a guess', () => {
    const headless = CURRENT.replace(/<thead>[\s\S]*<\/thead>/, '')
    expect(parseAnthropicPricing(headless)).toBeNull()
  })

  test('a parse that does not reproduce the anchor model is refused whole', () => {
    // Two columns swapped under unchanged headers — the anchor catches what the header cannot.
    const lying = CURRENT.replace(row('Claude Sonnet 5The best combination', ['$2', '$10', '$2.50', '$4', '$0.20']),
      row('Claude Sonnet 5The best combination', ['$2', '$10', '$2.50', '$0.20', '$4']))
    expect(parseAnthropicPricing(lying)).toBeNull()
  })
})

describe('parseAnthropicPricing — localized page', () => {
  test('reads the Portuguese headers the page serves to a pt browser', () => {
    const pt = CURRENT
      .replace('<th>Input</th>', '<th>Entrada</th>').replace('<th>Output</th>', '<th>Saída</th>')
      .replace('<th>5m writes</th>', '<th>Gravações de 5 min</th>').replace('<th>1h writes</th>', '<th>Gravações de 1h</th>')
      .replace('<th>Hits and refreshes</th>', '<th>Hits e atualizações</th>')
    expect(parseAnthropicPricing(pt)!['claude-opus-5']).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
  })
})
