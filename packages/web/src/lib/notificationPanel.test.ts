import { describe, expect, it } from 'bun:test'
import { notificationPanelPlacement } from './notificationPanel'

describe('notificationPanelPlacement', () => {
  it('keeps a normal mobile sheet inside the viewport', () => {
    expect(notificationPanelPlacement(390)).toEqual({ left: 35, width: 320 })
  })

  it('shrinks a narrow viewport instead of overflowing either edge', () => {
    expect(notificationPanelPlacement(300)).toEqual({ left: 10, width: 280 })
  })
})
