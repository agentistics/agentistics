import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApprovalCard } from './ApprovalCard'

describe('ApprovalCard', () => {
  test('renders a pre-conversation trust dialog with actionable choices', () => {
    const html = renderToStaticMarkup(<ApprovalCard
      lang="en"
      row={{
        id: 'agy-1', title: 'Antigravity', state: 'waiting-approval',
        approvalLines: ['Do you trust this folder?'],
        dialogOptions: [
          { number: 1, label: 'Yes, I trust this folder', selected: true },
          { number: 2, label: 'No, exit', selected: false },
        ],
        verbs: [{ action: 'approve', label: 'Answer', enabled: true }],
      } as never}
      act={async () => ({ ok: true, message: 'answered' })}
    />)
    expect(html).toContain('This session is asking')
    expect(html).toContain('Do you trust this folder?')
    expect(html).toContain('Yes, I trust this folder')
    expect(html).toContain('No, exit')
  })
})
