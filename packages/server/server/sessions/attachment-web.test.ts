import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import {
  ATTACHMENT_DIR, attachmentImageType, attachmentMediaType, attachmentMessageOf, attachmentPathByName,
  parseAttachmentLog, resolveAttachmentRead, resolveAttachmentReadReal,
} from './attachment-web'

describe('attachmentMessageOf — what one delivered message carried', () => {
  const a = join(ATTACHMENT_DIR, '5990e2ad-image.png')
  const b = join(ATTACHMENT_DIR, '950e5db0-shot.jpg')

  it('records the stored image paths the message named, in order', () => {
    // The shape `composeReply` builds: the paths on their own lines, then what was typed.
    expect(attachmentMessageOf('conv', 7, `${a}\n${b}\n\nolha isso`))
      .toEqual({ conversationId: 'conv', atMs: 7, paths: [a, b], images: 2 })
  })

  it('counts an image path it cannot serve, so the record is visibly short', () => {
    expect(attachmentMessageOf('conv', 7, `${a}\n/home/me/Desktop/typed.png\nhi`))
      .toEqual({ conversationId: 'conv', atMs: 7, paths: [a], images: 2 })
  })

  it('writes no record for a message with no image, or with no conversation to key it by', () => {
    expect(attachmentMessageOf('conv', 7, 'just words, see diagram.png in the repo')).toBeNull()
    expect(attachmentMessageOf('conv', 7, `${join(ATTACHMENT_DIR, 'c0847d8c-pasted.txt')}\nhere`)).toBeNull()
    expect(attachmentMessageOf('', 7, `${a}\nhi`)).toBeNull()
  })
})

describe('parseAttachmentLog', () => {
  const log = [
    // Uploads, keyed by the managed SESSION the upload route knew — as every line on disk today is.
    JSON.stringify({ sessionId: 'ab407b77de', atMs: 1, path: '/s/old.png' }),
    JSON.stringify({ sessionId: '196c9da3ef', atMs: 2, path: '/s/new.png' }),
    // Messages, keyed by the CONVERSATION: one written before a reopen and one after share it.
    JSON.stringify({ conversationId: 'b5e1c0eb', atMs: 3, paths: ['/s/m1.png'], images: 1 }),
    JSON.stringify({ conversationId: 'b5e1c0eb', atMs: 4, paths: ['/s/m2.png', 7], images: 2 }),
    JSON.stringify({ conversationId: 'other', atMs: 5, paths: ['/s/x.png'], images: 1 }),
    '{ not json',
    JSON.stringify({ conversationId: 'b5e1c0eb', paths: ['/s/no-time.png'], images: 1 }),
  ].join('\n')

  it('keys uploads by session and messages by conversation, so a reopen splits neither', () => {
    const out = parseAttachmentLog(log, { sessionId: '196c9da3ef', conversationId: 'b5e1c0eb' })
    expect(out.sends).toEqual([{ sessionId: '196c9da3ef', atMs: 2, path: '/s/new.png' }])
    expect(out.messages.map(m => m.atMs)).toEqual([3, 4])
    // A non-string entry is dropped and `images` is kept, so that message now reads as SHORT.
    expect(out.messages[1]).toEqual({ conversationId: 'b5e1c0eb', atMs: 4, paths: ['/s/m2.png'], images: 2 })
  })

  it('an upload-only log (every file written before this change) yields no messages', () => {
    const uploadsOnly = log.split('\n').slice(0, 2).join('\n')
    expect(parseAttachmentLog(uploadsOnly, { sessionId: 'ab407b77de', conversationId: 'b5e1c0eb' }))
      .toEqual({ sends: [{ sessionId: 'ab407b77de', atMs: 1, path: '/s/old.png' }], messages: [] })
  })

  it('an empty key matches nothing', () => {
    expect(parseAttachmentLog(log, { sessionId: '', conversationId: '' })).toEqual({ sends: [], messages: [] })
  })
})

describe('resolveAttachmentRead', () => {
  it('resolves a plain path inside the attachment directory', () => {
    const p = join(ATTACHMENT_DIR, 'abcd1234-screenshot.png')
    expect(resolveAttachmentRead(p)).toBe(p)
  })

  it('refuses a path outside the attachment directory', () => {
    expect(resolveAttachmentRead('/etc/passwd')).toBeNull()
  })

  it('refuses a traversal that only LOOKS like it starts inside the directory', () => {
    // The raw string starts with ATTACHMENT_DIR; only resolving it first reveals it does not.
    expect(resolveAttachmentRead(join(ATTACHMENT_DIR, '..', '..', '.ssh', 'id_rsa'))).toBeNull()
  })

  it('refuses a sibling directory whose name happens to share the prefix', () => {
    // A bare string prefix check would let "ATTACHMENT_DIR-evil" through; the trailing separator
    // in the base guards exactly this.
    expect(resolveAttachmentRead(`${ATTACHMENT_DIR}-evil/file.png`)).toBeNull()
  })

  it('refuses an empty path', () => {
    expect(resolveAttachmentRead('')).toBeNull()
  })
})

describe('resolveAttachmentReadReal — the REAL (symlink-resolved) recheck the reading route applies', () => {
  // The full symlink-escape guarantee (a link INSIDE the attachments directory pointing OUTSIDE it
  // is refused, one pointing at another file inside it resolves to that file) is `realContained`'s
  // own logic, tested against a disposable tmpdir in `real-contained.test.ts` — this machine's REAL
  // `ATTACHMENT_DIR` already holds live attachments and must never be written to by a test (see
  // `sdd/scratch/sessions/00-shared-rules.md`). What is tested here, read-only, is the WIRING: the
  // lexical refusal short-circuits before any disk access, and a lexically-valid path that simply
  // is not there answers the same `null` the lexical check already promised.
  it('refuses a lexically-invalid path without any disk access', async () => {
    expect(await resolveAttachmentReadReal('/etc/passwd')).toBeNull()
    expect(await resolveAttachmentReadReal('')).toBeNull()
    expect(await resolveAttachmentReadReal(join(ATTACHMENT_DIR, '..', '..', '.ssh', 'id_rsa'))).toBeNull()
  })

  it('refuses a lexically-valid path that does not exist on disk', async () => {
    expect(await resolveAttachmentReadReal(join(ATTACHMENT_DIR, 'nonexistent-2f8e9a-file.png'))).toBeNull()
  })
})

describe('attachmentPathByName', () => {
  it('resolves a stored name into the attachment directory', () => {
    expect(attachmentPathByName('724e7aa8-image.png')).toBe(join(ATTACHMENT_DIR, '724e7aa8-image.png'))
  })

  it('REFUSES a traversal', () => {
    expect(attachmentPathByName('../../.ssh/id_rsa')).toBeNull()
    expect(attachmentPathByName('..')).toBeNull()
    expect(attachmentPathByName('.')).toBeNull()
    expect(attachmentPathByName('..%2F..%2Fetc%2Fpasswd')).toBeNull()
  })

  it('refuses anything carrying a separator, on either platform', () => {
    expect(attachmentPathByName('sub/file.png')).toBeNull()
    expect(attachmentPathByName('sub\\file.png')).toBeNull()
    expect(attachmentPathByName('/etc/passwd')).toBeNull()
  })

  it('refuses a NUL byte', () => {
    expect(attachmentPathByName('image.png\0.txt')).toBeNull()
  })

  it('refuses an empty name and an absurd one', () => {
    expect(attachmentPathByName('')).toBeNull()
    expect(attachmentPathByName('a'.repeat(201))).toBeNull()
  })

  it('refuses a name this machine could not have written', () => {
    expect(attachmentPathByName('imagem com espaço.png')).toBeNull()
    expect(attachmentPathByName('a$(whoami).png')).toBeNull()
  })
})

describe('attachmentImageType', () => {
  it('names the real type of every image the browser side previews', () => {
    expect(attachmentImageType('a.png')).toBe('image/png')
    expect(attachmentImageType('a.JPG')).toBe('image/jpeg')
    expect(attachmentImageType('a.jpeg')).toBe('image/jpeg')
    expect(attachmentImageType('a.gif')).toBe('image/gif')
    expect(attachmentImageType('a.webp')).toBe('image/webp')
    expect(attachmentImageType('a.avif')).toBe('image/avif')
    expect(attachmentImageType('a.bmp')).toBe('image/bmp')
    expect(attachmentImageType('a.svg')).toBe('image/svg+xml')
  })

  it('is the IMAGE half only — a video and a PDF are shown by other elements', () => {
    expect(attachmentImageType('notes.txt')).toBeNull()
    expect(attachmentImageType('id_rsa')).toBeNull()
    expect(attachmentImageType('a.pdf')).toBeNull()
    expect(attachmentImageType('a.mp4')).toBeNull()
    expect(attachmentImageType('.png')).toBeNull()
  })
})

describe('attachmentMediaType', () => {
  it('THE REPORTED CASE: an attached PDF and video are served, each as what it is', () => {
    // The route served images only, so a person who attached a PDF or a recording got a card
    // saying "no preview" beside a file agentop had itself stored, and no way to open it.
    expect(attachmentMediaType('notes.pdf')).toEqual({ mime: 'application/pdf', kind: 'pdf' })
    expect(attachmentMediaType('demo.MP4')).toEqual({ mime: 'video/mp4', kind: 'video' })
    expect(attachmentMediaType('clip.mov')).toEqual({ mime: 'video/quicktime', kind: 'video' })
    expect(attachmentMediaType('screen.webm')).toEqual({ mime: 'video/webm', kind: 'video' })
  })

  it('still refuses everything the table does not name, so this cannot become a file server', () => {
    // The point of a closed table: adding a kind is a deliberate act, never a fallthrough.
    for (const n of ['notes.txt', 'id_rsa', 'a.zip', 'a.exe', 'a.mkv', '.png', 'noext']) {
      expect(attachmentMediaType(n)).toBeNull()
    }
  })

  it('the image rows are the same ones, and `attachmentImageType` is derived from them', () => {
    for (const n of ['a.png', 'a.JPG', 'a.gif', 'a.webp', 'a.avif', 'a.bmp', 'a.svg']) {
      const t = attachmentMediaType(n)
      expect(t?.kind).toBe('image')
      expect(attachmentImageType(n)).toBe(t!.mime)
    }
  })
})
