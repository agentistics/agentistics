import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { ATTACHMENT_DIR } from './attachment-web'
import { parseImageCompanion, resolveCompanionImages } from './attachment-companion'

const a = join(ATTACHMENT_DIR, '7f06ed4a-image.png')
const b = join(ATTACHMENT_DIR, '005d6e1c-image.png')

describe('parseImageCompanion', () => {
  it('reads the paths off a real companion’s content array, in order', () => {
    const content = [
      { type: 'text', text: `[Image: source: ${a}]` },
      { type: 'text', text: `[Image: source: ${b}]` },
    ]
    expect(parseImageCompanion(content)).toEqual([a, b])
  })

  it('reads a single-string content the same way', () => {
    expect(parseImageCompanion(`[Image: source: ${a}]`)).toEqual([a])
  })

  it('refuses a companion that is not EXCLUSIVELY image lines — a skill load, say', () => {
    expect(parseImageCompanion([
      { type: 'text', text: 'Base directory for this skill: /home/me/.claude/skills/foo' },
    ])).toBeNull()
  })

  it('refuses a companion mixing one image line with something else — half a link is not a link', () => {
    expect(parseImageCompanion([
      { type: 'text', text: `[Image: source: ${a}]` },
      { type: 'text', text: 'and also this' },
    ])).toBeNull()
  })

  it('refuses empty or unrecognised shapes rather than guessing', () => {
    expect(parseImageCompanion([])).toBeNull()
    expect(parseImageCompanion(null)).toBeNull()
    expect(parseImageCompanion(42)).toBeNull()
    expect(parseImageCompanion([{ type: 'tool_result' }])).toBeNull()
  })
})

describe('resolveCompanionImages', () => {
  it('resolves when the companion’s count matches BOTH of the turn’s own counts', () => {
    expect(resolveCompanionImages([a, b], 2, 2)).toEqual([a, b])
  })

  it('refuses when the companion disagrees with the marker count', () => {
    expect(resolveCompanionImages([a, b], 3, 2)).toBeNull()
  })

  it('refuses when the companion disagrees with imagePasteIds’ own count', () => {
    expect(resolveCompanionImages([a, b], 2, 3)).toBeNull()
  })

  it('refuses a path outside the attachments directory — the whole turn does not resolve', () => {
    expect(resolveCompanionImages([a, '/etc/passwd'], 2, 2)).toBeNull()
  })

  it('refuses an empty companion', () => {
    expect(resolveCompanionImages([], 0, 0)).toBeNull()
  })
})
