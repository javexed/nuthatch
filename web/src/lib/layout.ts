import type { PanelSettings, Widget } from '@nuthatch/api'

// Where the panels of a dashboard go: a grid of 12 columns and rows of
// one height. A panel moved or resized pushes those in its way down; then
// every panel rises as far as it can.

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export const COLUMNS = 12

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Keeps a box inside the grid. */
export function clamp(box: Box): Box {
  const w = Math.min(COLUMNS, Math.max(1, Math.round(box.w)))
  const h = Math.min(20, Math.max(1, Math.round(box.h)))
  return { w, h, x: Math.min(COLUMNS - w, Math.max(0, Math.round(box.x))), y: Math.max(0, Math.round(box.y)) }
}

/** Every box rises as far as it can, top ones first. */
export function compact(boxes: Box[], fixed?: number): Box[] {
  const out = boxes.map((b) => ({ ...b }))
  const order = out.map((_, n) => n).sort((a, b) => (out[a]!.y - out[b]!.y) || (out[a]!.x - out[b]!.x))
  const placed: number[] = []
  for (const n of order) {
    const box = out[n]!
    if (n !== fixed) {
      while (box.y > 0 && !placed.some((p) => overlap({ ...box, y: box.y - 1 }, out[p]!))) box.y--
    }
    placed.push(n)
  }
  return out
}

/** Box `n` is at `to`; the others make room below it, and all rise again. */
export function move(boxes: Box[], n: number, to: Box): Box[] {
  const out = boxes.map((b) => ({ ...b }))
  out[n] = clamp(to)
  // Push down whatever is in the way, until nothing overlaps.
  for (let changed = true, guard = 0; changed && guard < 500; guard++) {
    changed = false
    const order = out.map((_, i) => i).sort((a, b) => (a === n ? -1 : b === n ? 1 : out[a]!.y - out[b]!.y))
    for (const a of order) {
      for (const b of order) {
        if (a === b || b === n) continue
        if (overlap(out[a]!, out[b]!) && (a === n || out[a]!.y <= out[b]!.y)) {
          out[b]!.y = out[a]!.y + out[a]!.h
          changed = true
        }
      }
    }
  }
  return compact(out, n)
}

/** A place for a new box of this size: the first row where it fits. */
export function place(boxes: Box[], w: number, h: number): Box {
  for (let y = 0; ; y++) {
    for (let x = 0; x + w <= COLUMNS; x++) {
      const box = { x, y, w, h }
      if (!boxes.some((b) => overlap(b, box))) return box
    }
  }
}

/** A new panel's size, by its type. */
export const SIZES: Record<Widget['type'], [number, number]> = { totals: [12, 3], problems: [6, 4], object: [4, 3], log: [6, 4], stat: [3, 2], graph: [6, 3] }

/** The panels with one more, in the first free place. */
export function withPanel(widgets: Widget[], panel: PanelSettings): Widget[] {
  const [w, h] = SIZES[panel.type]
  return [...widgets, { ...panel, layout: place(widgets.map((x) => x.layout), w, h) }]
}
