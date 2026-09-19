import { describe, expect, it } from 'bun:test'
import { resolveViewedImagePath, VIEWED_IMAGE_RE } from './viewed-image'

function line(obj: unknown): string {
  return JSON.stringify(obj)
}

const readUse = (uuid: string, parentUuid: string, id: string, filePath: string, name = 'Read') => line({
  type: 'assistant', uuid, parentUuid,
  message: { content: [{ type: 'tool_use', id, name, input: { file_path: filePath } }] },
})

const imageResult = (uuid: string, parentUuid: string, toolUseId: string) => line({
  type: 'user', uuid, parentUuid,
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'image', source: {} }] }] },
})

const companion = (uuid: string, parentUuid: string) => line({
  type: 'user', uuid, parentUuid, isMeta: true, turnCompanion: true,
  message: { content: '[Image: original 2223x888, displayed at 2000x799. Multiply coordinates by 1.11 to map to original image.]' },
})

describe('VIEWED_IMAGE_RE', () => {
  it('recognises the shape, regardless of the trailing sentence', () => {
    expect(VIEWED_IMAGE_RE.test('[Image: original 897x149, displayed at 897x149.]')).toBe(true)
  })

  it('does not match the attachment shape — a different note entirely', () => {
    expect(VIEWED_IMAGE_RE.test('[Image: source: /home/u/.agentistics/attachments/x.png]')).toBe(false)
  })
})

describe('resolveViewedImagePath', () => {
  it('resolves the exact chain: tool_use -> its own tool_result -> the companion', () => {
    const lines = [
      readUse('u1', 'p0', 'toolu_1', '/repo/shot.png'),
      imageResult('r1', 'u1', 'toolu_1'),
      companion('c1', 'r1'),
    ]
    expect(resolveViewedImagePath(lines, 2)).toBe('/repo/shot.png')
  })

  it('THE MEASURED CASE: three Read calls in one turn, only the LAST gets a companion — pairs with the THIRD, never the first by position or count', () => {
    const lines = [
      readUse('u1', 'p0', 'toolu_1', '/repo/small-a.png'),
      imageResult('r1', 'u1', 'toolu_1'),
      readUse('u2', 'r1', 'toolu_2', '/repo/small-b.png'),
      imageResult('r2', 'u2', 'toolu_2'),
      readUse('u3', 'r2', 'toolu_3', '/repo/big-resized.png'),
      imageResult('r3', 'u3', 'toolu_3'),
      companion('c1', 'r3'),
    ]
    // A naive "order" or "count" pairing (1 companion, 3 candidate reads) could only guess; the
    // exact parentUuid chain says which one without guessing.
    expect(resolveViewedImagePath(lines, 6)).toBe('/repo/big-resized.png')
  })

  it('refuses when the companion carries no parentUuid at all', () => {
    const lines = [line({
      type: 'user', uuid: 'c1', isMeta: true, turnCompanion: true,
      message: { content: '[Image: original 100x100, displayed at 100x100.]' },
    })]
    expect(resolveViewedImagePath(lines, 0)).toBeNull()
  })

  it('refuses when the parent cannot be found within the bound', () => {
    const lines = [companion('c1', 'nowhere-in-this-file')]
    expect(resolveViewedImagePath(lines, 0)).toBeNull()
  })

  it('refuses when the tool_result names more than one image — ambiguous', () => {
    const lines = [
      readUse('u1', 'p0', 'toolu_1', '/repo/shot.png'),
      line({
        type: 'user', uuid: 'r1', parentUuid: 'u1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'image' }, { type: 'image' }] }] },
      }),
      companion('c1', 'r1'),
    ]
    expect(resolveViewedImagePath(lines, 2)).toBeNull()
  })

  it('refuses when the tool_use is not a Read call', () => {
    const lines = [
      readUse('u1', 'p0', 'toolu_1', '/repo/shot.png', 'Bash'),
      imageResult('r1', 'u1', 'toolu_1'),
      companion('c1', 'r1'),
    ]
    expect(resolveViewedImagePath(lines, 2)).toBeNull()
  })

  it('refuses when the tool_result is not itself a single tool_result block', () => {
    const lines = [
      readUse('u1', 'p0', 'toolu_1', '/repo/shot.png'),
      line({
        type: 'user', uuid: 'r1', parentUuid: 'u1',
        message: { content: [{ type: 'text', text: 'not a tool result' }] },
      }),
      companion('c1', 'r1'),
    ]
    expect(resolveViewedImagePath(lines, 2)).toBeNull()
  })

  it('refuses when the chain runs past the bound', () => {
    // A hundred unrelated lines between the tool_use and its result — far past CHAIN_BOUND.
    const filler = Array.from({ length: 30 }, (_, i) => line({ type: 'assistant', uuid: `f${i}`, parentUuid: `f${i - 1}` }))
    const lines = [
      readUse('u1', 'p0', 'toolu_1', '/repo/shot.png'),
      ...filler,
      imageResult('r1', 'f29', 'toolu_1'),
      companion('c1', 'r1'),
    ]
    expect(resolveViewedImagePath(lines, lines.length - 1)).toBeNull()
  })
})
