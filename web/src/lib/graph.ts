// The geometry of a small line graph: where its points go, where the
// line breaks because checks are missing, and which point a pointer is at.

export type Point = [time: number, value: number]

export interface Shape {
  /** SVG path data in a 0..100 by 0..100 box, y down. */
  path: string
  min: number
  max: number
  /** The values at the bottom and the top edge of the box. */
  low: number
  high: number
  from: number
  to: number
}

/** A number as a label: three significant digits, no trailing zeros. */
export function short(value: number): string {
  if (value === 0) return '0'
  const abs = Math.abs(value)
  if (abs >= 1e6 || abs < 1e-3) return value.toExponential(1)
  return String(Number(value.toPrecision(3)))
}

/** The usual time between two points; a gap of over three of them breaks the line. */
function usualStep(points: Point[]): number {
  const steps = points.slice(1).map((p, n) => p[0] - (points[n]?.[0] ?? 0)).sort((a, b) => a - b)
  return steps[Math.floor(steps.length / 2)] ?? 0
}

export function shape(points: Point[], from: number, to: number): Shape {
  const values = points.map((p) => p[1])
  let min = Math.min(...values)
  let max = Math.max(...values)
  // A flat line sits in the middle rather than on an edge.
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1
    min -= pad
    max += pad
  }
  const x = (t: number) => (to === from ? 50 : ((t - from) / (to - from)) * 100)
  const y = (v: number) => 100 - ((v - min) / (max - min)) * 100
  const step = usualStep(points)
  let path = ''
  points.forEach(([t, v], n) => {
    const gap = n === 0 || (step > 0 && t - (points[n - 1]?.[0] ?? t) > step * 3.5)
    path += `${gap ? 'M' : 'L'}${x(t).toFixed(2)} ${y(v).toFixed(2)}`
    // A point alone between two gaps would not show as a line.
    const alone = gap && (n === points.length - 1 || (step > 0 && (points[n + 1]?.[0] ?? t) - t > step * 3.5))
    if (alone) path += `h0.01`
  })
  return { path, min: Math.min(...values), max: Math.max(...values), low: min, high: max, from, to }
}

/** The point nearest to a place along the graph, 0 to 1 from left to right. */
export function nearest(points: Point[], from: number, to: number, along: number): Point | undefined {
  const time = from + along * (to - from)
  let best: Point | undefined
  for (const point of points) if (best === undefined || Math.abs(point[0] - time) < Math.abs(best[0] - time)) best = point
  return best
}
