import { describe, expect, it } from 'vitest'
import { type Box, clamp, compact, move, place } from './layout'

const overlapping = (boxes: Box[]) =>
  boxes.some((a, i) => boxes.some((b, j) => i < j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h))

describe('the dashboard grid', () => {
  it('keeps boxes inside it', () => {
    expect(clamp({ x: 11, y: -2, w: 4, h: 0 })).toEqual({ x: 8, y: 0, w: 4, h: 1 })
  })

  it('lets boxes rise', () => {
    expect(compact([{ x: 0, y: 5, w: 6, h: 2 }, { x: 6, y: 9, w: 6, h: 2 }])).toEqual([{ x: 0, y: 0, w: 6, h: 2 }, { x: 6, y: 0, w: 6, h: 2 }])
  })

  it('pushes what is in the way down, and never overlaps', () => {
    const boxes: Box[] = [
      { x: 0, y: 0, w: 6, h: 2 },
      { x: 6, y: 0, w: 6, h: 2 },
      { x: 0, y: 2, w: 12, h: 3 },
    ]
    const moved = move(boxes, 2, { x: 0, y: 0, w: 12, h: 3 })
    expect(moved[2]).toEqual({ x: 0, y: 0, w: 12, h: 3 })
    expect(moved[0]!.y).toBe(3)
    expect(moved[1]!.y).toBe(3)
    expect(overlapping(moved)).toBe(false)
    // A box made wider takes the room of the one beside it.
    const wider = move(boxes, 0, { x: 0, y: 0, w: 9, h: 2 })
    expect(overlapping(wider)).toBe(false)
    expect(wider[1]!.y).toBeGreaterThanOrEqual(2)
  })

  it('finds a place for a new box', () => {
    expect(place([{ x: 0, y: 0, w: 6, h: 2 }], 6, 2)).toEqual({ x: 6, y: 0, w: 6, h: 2 })
    expect(place([{ x: 0, y: 0, w: 12, h: 2 }], 4, 2)).toEqual({ x: 0, y: 2, w: 4, h: 2 })
  })
})
