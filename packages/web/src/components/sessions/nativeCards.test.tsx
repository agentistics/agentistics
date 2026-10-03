import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NativeApprovalCard } from './NativeApprovalCard'
import { ToolCallCard } from './ToolCallCard'

describe('ToolCallCard', () => {
  test('name, detail, status, facts; the output folded', () => {
    const html = renderToStaticMarkup(<ToolCallCard lang="en" card={{ key: 'k', name: 'shell.start', detail: 'bun test', status: 'completed', exitCode: 0, durationMs: 1200, result: 'ok 1' }} />)
    expect(html).toContain('shell.start')
    expect(html).toContain('bun test')
    expect(html).toContain('done · exit 0 · 1.2 s')
    expect(html).toContain('<details>')
    expect(html).toContain('ok 1')
  })
  test('PT, awaiting approval, no output yet', () => {
    const html = renderToStaticMarkup(<ToolCallCard lang="pt" card={{ key: 'k', name: 'file.write', status: 'awaiting' }} />)
    expect(html).toContain('aguardando aprovação')
    expect(html).not.toContain('<details>')
  })
})

describe('NativeApprovalCard', () => {
  test('the question, what it would run, the options in the person’s language', () => {
    const html = renderToStaticMarkup(<NativeApprovalCard lang="pt" onAnswer={() => {}} ask={{
      questionId: 'tx_1:permission', kind: 'permission', text: 'Allow this command to run?', subjects: ['rm -rf build'],
      options: [{ label: 'Allow once' }, { label: 'Deny' }],
    }} />)
    expect(html).toContain('Aprovação necessária')
    expect(html).toContain('rm -rf build')
    expect(html).toContain('Permitir uma vez')
    expect(html).toContain('Negar')
    expect(html).not.toContain('Responder')
  })
  test('a question with free text', () => {
    const html = renderToStaticMarkup(<NativeApprovalCard lang="en" onAnswer={() => {}} ask={{
      questionId: 'tx_2:q', kind: 'question', text: 'Which branch?', subjects: [], options: [{ label: 'main' }], allowFreeText: true,
    }} />)
    expect(html).toContain('The assistant asks')
    expect(html).toContain('Or answer in your own words')
  })
})
