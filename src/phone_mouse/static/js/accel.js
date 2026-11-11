// Pointer acceleration (PLAN.md §4.5): faster finger movement moves the cursor further.

export const SPEED_FACTOR = 0.6;
export const MAX_GAIN = 4;

/**
 * Cursor gain for a finger moving at `speed` px/ms.
 * Always between `sensitivity × 1` and `sensitivity × MAX_GAIN`.
 * @param {number} speed
 * @param {number} sensitivity
 * @returns {number}
 */
export function gain(speed, sensitivity) {
  const safeSpeed = Number.isNaN(speed) || speed < 0 ? 0 : speed;
  return sensitivity * Math.min(Math.max(1 + SPEED_FACTOR * safeSpeed, 1), MAX_GAIN);
}

/**
 * Scale a finger delta into a cursor delta.
 * @param {number} dx
 * @param {number} dy
 * @param {number} elapsedMs time since the previous sample
 * @param {number} sensitivity
 * @returns {{dx: number, dy: number}}
 */
export function accelerate(dx, dy, elapsedMs, sensitivity) {
  const speed = Math.hypot(dx, dy) / Math.max(elapsedMs, 1);
  const g = gain(speed, sensitivity);
  return { dx: dx * g, dy: dy * g };
}
