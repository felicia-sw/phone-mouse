// Touch gesture recognition (PLAN.md §4.5). A pure state machine: it is fed the list of
// touches currently on the screen after each touch event and returns the actions to send.
// It never touches the DOM, so it can be unit-tested.

import { accelerate } from './accel.js';

/** A tap must lift within this many milliseconds of landing. */
export const TAP_MAX_DURATION_MS = 200;
/** Finger travel up to this many pixels still counts as a tap. */
export const TAP_SLOP_PX = 10;
/** Touching again this soon after a tap, then moving, starts a drag. */
export const DRAG_WINDOW_MS = 300;

/** @typedef {{id: number, x: number, y: number}} TouchPoint */

/**
 * @typedef {{type: 'move', dx: number, dy: number}
 *   | {type: 'scroll', dx: number, dy: number}
 *   | {type: 'click', button: 'left' | 'right'}
 *   | {type: 'button', action: 'down' | 'up'}} Action
 */

/** @typedef {{sensitivity: number, naturalScroll: boolean}} GestureOptions */

/**
 * idle: no fingers. pending: one finger, could still be a tap. moving: one finger moving
 * the cursor. dragPending: second touch soon after a tap. dragging: holding the button.
 * twoPending: two fingers, could still be a right-click tap. scrolling: two fingers moving.
 * lifting: the gesture is over; ignore every finger until all have lifted.
 * @typedef {'idle' | 'pending' | 'moving' | 'dragPending' | 'dragging' | 'twoPending'
 *   | 'scrolling' | 'lifting'} Mode
 */

export class GestureRecognizer {
  /** @type {GestureOptions} */
  #options;
  /** @type {Mode} */
  #mode = 'idle';
  #lastTapEnd = -Infinity;
  #gestureStart = 0;
  #lastTime = 0;
  #tapAllowed = true;
  /** @type {number | null} */
  #primaryId = null;
  /** @type {Map<number, {x: number, y: number}>} */
  #origin = new Map();
  /** @type {Map<number, {x: number, y: number}>} */
  #last = new Map();

  /** @param {Partial<GestureOptions>} [options] */
  constructor(options = {}) {
    this.#options = { sensitivity: 1, naturalScroll: true, ...options };
  }

  /** @param {Partial<GestureOptions>} options */
  setOptions(options) {
    this.#options = { ...this.#options, ...options };
  }

  /** The current mode; exposed for tests and debugging. */
  get mode() {
    return this.#mode;
  }

  /**
   * @param {number} time event time in ms
   * @param {TouchPoint[]} touches every touch now on the screen, including the new one
   * @returns {Action[]}
   */
  touchStart(time, touches) {
    const count = touches.length;
    switch (this.#mode) {
      case 'idle':
        if (count === 1) {
          const quickRepeat = time - this.#lastTapEnd <= DRAG_WINDOW_MS;
          this.#begin(quickRepeat ? 'dragPending' : 'pending', time, touches);
        } else if (count === 2) {
          this.#beginTwoFinger(time, touches, true);
        } else {
          this.#mode = 'lifting';
        }
        break;
      case 'pending':
      case 'dragPending':
      case 'moving':
        if (count === 2) {
          this.#beginTwoFinger(time, touches, this.#mode !== 'moving');
        } else {
          this.#mode = 'lifting';
        }
        break;
      case 'twoPending':
      case 'scrolling':
        this.#mode = 'lifting';
        break;
      case 'dragging':
      case 'lifting':
        break; // extra fingers do not change a drag; lifting waits for all fingers
    }
    return [];
  }

  /**
   * @param {number} time
   * @param {TouchPoint[]} touches every touch now on the screen
   * @returns {Action[]}
   */
  touchMove(time, touches) {
    switch (this.#mode) {
      case 'pending':
      case 'dragPending':
      case 'moving':
      case 'dragging':
        return this.#moveOneFinger(time, touches);
      case 'twoPending':
      case 'scrolling':
        return this.#moveTwoFingers(time, touches);
      default:
        return [];
    }
  }

  /**
   * @param {number} time
   * @param {TouchPoint[]} touches the touches still on the screen after the lift
   * @returns {Action[]}
   */
  touchEnd(time, touches) {
    /** @type {Action[]} */
    const actions = [];
    const remaining = touches.length;
    switch (this.#mode) {
      case 'pending':
      case 'dragPending':
        if (time - this.#gestureStart < TAP_MAX_DURATION_MS) {
          actions.push({ type: 'click', button: 'left' });
          this.#lastTapEnd = time;
        }
        break;
      case 'twoPending':
        if (this.#tapAllowed && time - this.#gestureStart < TAP_MAX_DURATION_MS) {
          actions.push({ type: 'click', button: 'right' });
        }
        break;
      case 'dragging':
        if (touches.some((touch) => touch.id === this.#primaryId)) {
          return []; // another finger lifted; the drag continues
        }
        actions.push({ type: 'button', action: 'up' });
        break;
      default:
        break;
    }
    this.#mode = remaining === 0 ? 'idle' : 'lifting';
    return actions;
  }

  /**
   * The system cancelled the touches (for example a notification or app switch).
   * @returns {Action[]}
   */
  touchCancel() {
    return this.reset();
  }

  /**
   * Forget the current gesture. Releases the button if a drag was in progress.
   * @returns {Action[]}
   */
  reset() {
    /** @type {Action[]} */
    const actions = this.#mode === 'dragging' ? [{ type: 'button', action: 'up' }] : [];
    this.#mode = 'idle';
    this.#lastTapEnd = -Infinity;
    this.#origin.clear();
    this.#last.clear();
    this.#primaryId = null;
    return actions;
  }

  /**
   * @param {Mode} mode
   * @param {number} time
   * @param {TouchPoint[]} touches
   */
  #begin(mode, time, touches) {
    this.#mode = mode;
    this.#gestureStart = time;
    this.#lastTime = time;
    this.#origin.clear();
    this.#last.clear();
    for (const touch of touches) {
      this.#origin.set(touch.id, { x: touch.x, y: touch.y });
      this.#last.set(touch.id, { x: touch.x, y: touch.y });
    }
    this.#primaryId = touches[0]?.id ?? null;
  }

  /**
   * @param {number} time
   * @param {TouchPoint[]} touches
   * @param {boolean} tapAllowed false when the first finger was already moving the cursor
   */
  #beginTwoFinger(time, touches, tapAllowed) {
    this.#begin('twoPending', time, touches);
    this.#tapAllowed = tapAllowed;
    this.#lastTapEnd = -Infinity;
  }

  /**
   * @param {number} time
   * @param {TouchPoint[]} touches
   * @returns {Action[]}
   */
  #moveOneFinger(time, touches) {
    const touch = touches.find((t) => t.id === this.#primaryId);
    const last = touch && this.#last.get(touch.id);
    const origin = touch && this.#origin.get(touch.id);
    if (!touch || !last || !origin) return [];

    /** @type {Action[]} */
    const actions = [];
    if (this.#mode === 'pending' || this.#mode === 'dragPending') {
      if (Math.hypot(touch.x - origin.x, touch.y - origin.y) <= TAP_SLOP_PX) return [];
      if (this.#mode === 'dragPending') {
        actions.push({ type: 'button', action: 'down' });
        this.#mode = 'dragging';
      } else {
        this.#mode = 'moving';
      }
      this.#lastTapEnd = -Infinity;
    }

    const delta = accelerate(
      touch.x - last.x,
      touch.y - last.y,
      time - this.#lastTime,
      this.#options.sensitivity,
    );
    actions.push({ type: 'move', dx: delta.dx, dy: delta.dy });
    this.#last.set(touch.id, { x: touch.x, y: touch.y });
    this.#lastTime = time;
    return actions;
  }

  /**
   * @param {number} time
   * @param {TouchPoint[]} touches
   * @returns {Action[]}
   */
  #moveTwoFingers(time, touches) {
    const tracked = touches.filter((t) => this.#last.has(t.id));
    if (tracked.length !== 2) return [];

    if (this.#mode === 'twoPending') {
      const travelled = tracked.some((t) => {
        const origin = this.#origin.get(t.id);
        return origin !== undefined && Math.hypot(t.x - origin.x, t.y - origin.y) > TAP_SLOP_PX;
      });
      if (!travelled) return [];
      this.#mode = 'scrolling';
    }

    let dx = 0;
    let dy = 0;
    for (const touch of tracked) {
      const last = this.#last.get(touch.id);
      if (last) {
        dx += (touch.x - last.x) / tracked.length;
        dy += (touch.y - last.y) / tracked.length;
      }
      this.#last.set(touch.id, { x: touch.x, y: touch.y });
    }
    this.#lastTime = time;
    const direction = this.#options.naturalScroll ? 1 : -1;
    return [{ type: 'scroll', dx: dx * direction, dy: dy * direction }];
  }
}
