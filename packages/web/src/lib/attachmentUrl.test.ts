import { afterEach, describe, expect, it } from 'bun:test'
import { attachmentNameUrl, attachmentUrl, galleryFileUrl, sessionMediaUrl, setAttachmentsDir } from './attachmentUrl'

describe('galleryFileUrl', () => {
  const sessionId = 's1'

  it('a sent file (or one with no origin — every group written before "viewed" existed) is read by NAME', () => {
    const f = { path: '/home/u/.agentistics/attachments/abcd-shot.png', name: 'abcd-shot.png', origin: 'sent' as const }
    expect(galleryFileUrl(f, sessionId)).toBe(attachmentNameUrl('abcd-shot.png'))
    expect(galleryFileUrl({ path: f.path, name: f.name }, sessionId)).toBe(attachmentNameUrl('abcd-shot.png'))
  })

  it('a produced file is read through the SESSION media route, by path', () => {
    const f = { path: '/repo/out/report.png', name: 'report.png', origin: 'produced' as const }
    expect(galleryFileUrl(f, sessionId)).toBe(sessionMediaUrl(sessionId, f.path))
  })

  it('a VIEWED file re-read from the attachments directory goes through the attachment route, by PATH', () => {
    // It was never sent BY THIS message, so it cannot be read by name (the gallery's sent side
    // addresses only what it grouped) — but it is still inside the attachments directory, and the
    // path-based route's containment check does not care which message put it there.
    const f = { path: '/home/u/.agentistics/attachments/abcd-shot.png', name: 'abcd-shot.png', origin: 'viewed' as const }
    expect(galleryFileUrl(f, sessionId)).toBe(attachmentUrl(f.path))
  })

  it('a VIEWED file anywhere else falls to the session media route — never widened, never guessed', () => {
    const f = { path: '/repo/some/screenshot.png', name: 'screenshot.png', origin: 'viewed' as const }
    expect(galleryFileUrl(f, sessionId)).toBe(sessionMediaUrl(sessionId, f.path))
  })

  describe('a RELOCATED AGENTISTICS_DIR — the default guess no longer matches the real path', () => {
    afterEach(() => setAttachmentsDir(null))

    it('a viewed file under the real (relocated) attachments dir goes through the attachment route', () => {
      setAttachmentsDir('/srv/agentop-data/attachments')
      const f = { path: '/srv/agentop-data/attachments/abcd-shot.png', name: 'abcd-shot.png', origin: 'viewed' as const }
      expect(galleryFileUrl(f, sessionId)).toBe(attachmentUrl(f.path))
    })

    it('the default-layout guess no longer applies once the real dir is known, so it is never used to ROUTE IN', () => {
      // Before the fix this substring-matched and was served as an attachment; once the server has
      // said where its attachments really live, a path that only LOOKS like the default layout must
      // not borrow that route.
      setAttachmentsDir('/srv/agentop-data/attachments')
      const f = { path: '/home/u/.agentistics/attachments/abcd-shot.png', name: 'abcd-shot.png', origin: 'viewed' as const }
      expect(galleryFileUrl(f, sessionId)).toBe(sessionMediaUrl(sessionId, f.path))
    })

    it('a file merely sharing the real dir as a PREFIX string, not a path segment, is not swept in', () => {
      setAttachmentsDir('/srv/agentop-data/attachments')
      const f = { path: '/srv/agentop-data/attachments-evil/file.png', name: 'file.png', origin: 'viewed' as const }
      expect(galleryFileUrl(f, sessionId)).toBe(sessionMediaUrl(sessionId, f.path))
    })

    it('resetting to null goes back to the default-layout guess', () => {
      setAttachmentsDir('/srv/agentop-data/attachments')
      setAttachmentsDir(null)
      const f = { path: '/home/u/.agentistics/attachments/abcd-shot.png', name: 'abcd-shot.png', origin: 'viewed' as const }
      expect(galleryFileUrl(f, sessionId)).toBe(attachmentUrl(f.path))
    })
  })
})
