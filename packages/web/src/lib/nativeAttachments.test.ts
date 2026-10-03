import { describe, expect, test } from 'bun:test'
import { acceptOf, attachmentUrl, mediaTypeOf, refuseFile, type NativeAttachmentCapability } from './nativeAttachments'

const MB = 1024 * 1024
const cap: NativeAttachmentCapability = { images: ['image/png', 'image/jpeg'], pdf: false, maxImageBytes: 5 * MB, maxPdfBytes: 0, maxCount: 2, maxTotalBytes: 8 * MB }
const f = (name: string, size = MB, type = '') => ({ name, size, type })

describe('nativeAttachments (UI follow-up 3)', () => {
  test('media type: the browser\'s when ours, else the extension', () => {
    expect(mediaTypeOf(f('a.bin', 1, 'image/png'))).toBe('image/png')
    expect(mediaTypeOf(f('Shot.JPG'))).toBe('image/jpeg')
    expect(mediaTypeOf(f('x.svg', 1, 'image/svg+xml'))).toBeNull()
  })
  test('accept', () => {
    expect(acceptOf(cap)).toBe('image/png,image/jpeg')
    expect(acceptOf({ ...cap, pdf: true })).toBe('image/png,image/jpeg,application/pdf')
  })
  test('refused before an upload, in words', () => {
    expect(refuseFile(cap, f('a.png'), [], 'Ollama', 'en')).toBeNull()
    expect(refuseFile(null, f('a.png'), [], 'DeepSeek', 'en')).toBe('DeepSeek does not take attachments in this session.')
    expect(refuseFile(cap, f('d.pdf'), [], 'Ollama', 'pt')).toBe('Ollama não recebe PDF.')
    expect(refuseFile(cap, f('a.gif'), [], 'Ollama', 'en')).toBe('Ollama does not take image/gif.')
    expect(refuseFile(cap, f('big.png', 6 * MB), [], 'X', 'en')).toBe('"big.png" is 6 MB; the limit is 5 MB.')
    expect(refuseFile(cap, f('c.png'), [f('a.png'), f('b.png')], 'X', 'en')).toBe('At most 2 attachments per message.')
    expect(refuseFile(cap, f('b.png', 4 * MB), [f('a.png', 4.5 * MB)], 'X', 'en')).toBe('The attachments total 8.5 MB; one message takes up to 8 MB.')
    expect(refuseFile(cap, f('notes.txt'), [], 'X', 'en')).toBe('"notes.txt" is not an image (PNG, JPEG, GIF, WebP) or a PDF.')
  })
  test('the engine URL of a session attachment', () => {
    expect(attachmentUrl('ses_1', 'ab')).toBe('/api/runtime/sessions/ses_1/attachments/ab')
  })
})
