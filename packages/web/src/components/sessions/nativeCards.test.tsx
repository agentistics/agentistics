import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NativeApprovalCard } from './NativeApprovalCard'

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
