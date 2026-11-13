// Gestures of a touch screen: what a drag across a row means, and when a
// pull down from the top of the page asks for the newest.

/** A drag's direction once it is clearly one: 'left', 'right', or neither yet. */
export function swipeOf(dx: number, dy: number, far = 72): 'left' | 'right' | null {
  // More sideways than down, by a clear margin: a scroll is not a swipe.
  if (Math.abs(dx) < far || Math.abs(dx) < Math.abs(dy) * 2) return null
  return dx < 0 ? 'left' : 'right'
}

/** Whether a drag is sideways enough to move the row along with the finger. */
export function sideways(dx: number, dy: number): boolean {
  return Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5
}

/** How far a pull from the top has come, 0 to 1; at 1 letting go refreshes. */
export function pulled(dy: number, enough = 80): number {
  // Slower than the finger, as something being stretched.
  return Math.min(1, Math.max(0, dy * 0.6) / enough)
}
