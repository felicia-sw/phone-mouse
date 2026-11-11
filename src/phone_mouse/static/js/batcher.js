// Per-frame batching (PLAN.md §4.5): sum gesture deltas and send at most one move and one
// scroll per animation frame, carrying the fractional remainder to the next frame.

import { clampDelta, move, scroll } from './protocol.js';

export class MotionBatcher {
  #move = { dx: 0, dy: 0 };
  #scroll = { dx: 0, dy: 0 };

  /** @param {number} dx @param {number} dy */
  addMove(dx, dy) {
    this.#move.dx += dx;
    this.#move.dy += dy;
  }

  /** @param {number} dx @param {number} dy */
  addScroll(dx, dy) {
    this.#scroll.dx += dx;
    this.#scroll.dy += dy;
  }

  /** True when the next flush would send something. */
  get hasWork() {
    return [this.#move, this.#scroll].some((a) => Math.abs(a.dx) >= 1 || Math.abs(a.dy) >= 1);
  }

  /**
   * Whole pixels go out now; fractions, and anything beyond the ±500 protocol limit, wait for
   * the next frame.
   * @returns {import('./protocol.js').ClientMessage[]}
   */
  flush() {
    /** @type {import('./protocol.js').ClientMessage[]} */
    const messages = [];
    const moveDelta = take(this.#move);
    if (moveDelta) messages.push(move(moveDelta.dx, moveDelta.dy));
    const scrollDelta = take(this.#scroll);
    if (scrollDelta) messages.push(scroll(scrollDelta.dx, scrollDelta.dy));
    return messages;
  }

  /** Drop everything, for example when the connection is lost. */
  clear() {
    this.#move = { dx: 0, dy: 0 };
    this.#scroll = { dx: 0, dy: 0 };
  }
}

/**
 * @param {{dx: number, dy: number}} accumulated
 * @returns {{dx: number, dy: number} | null}
 */
function take(accumulated) {
  // `|| 0` turns -0 (from truncating small negative values) into 0.
  const dx = clampDelta(Math.trunc(accumulated.dx)) || 0;
  const dy = clampDelta(Math.trunc(accumulated.dy)) || 0;
  if (dx === 0 && dy === 0) return null;
  accumulated.dx -= dx;
  accumulated.dy -= dy;
  return { dx, dy };
}
