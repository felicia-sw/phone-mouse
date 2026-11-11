import { describe, expect, it } from 'vitest';
import {
  DRAG_WINDOW_MS,
  GestureRecognizer,
  TAP_MAX_DURATION_MS,
  TAP_SLOP_PX,
} from '../../src/phone_mouse/static/js/gestures.js';

/** @typedef {import('../../src/phone_mouse/static/js/gestures.js').Action} Action */
/** @typedef {import('../../src/phone_mouse/static/js/gestures.js').TouchPoint} TouchPoint */

/**
 * @param {number} id
 * @param {number} x
 * @param {number} y
 * @returns {TouchPoint}
 */
const at = (id, x, y) => ({ id, x, y });

/**
 * Drives a recognizer like a browser would and records every action.
 * Sensitivity 1 and slow movement (gain close to 1) keep expected values readable.
 */
class Finger {
  constructor(options = {}) {
    this.recognizer = new GestureRecognizer({ sensitivity: 1, ...options });
    /** @type {Action[]} */
    this.actions = [];
  }

  /** @param {number} time @param {TouchPoint[]} touches */
  start(time, touches) {
    this.actions.push(...this.recognizer.touchStart(time, touches));
    return this;
  }

  /** @param {number} time @param {TouchPoint[]} touches */
  move(time, touches) {
    this.actions.push(...this.recognizer.touchMove(time, touches));
    return this;
  }

  /** @param {number} time @param {TouchPoint[]} remaining */
  end(time, remaining = []) {
    this.actions.push(...this.recognizer.touchEnd(time, remaining));
    return this;
  }

  cancel() {
    this.actions.push(...this.recognizer.touchCancel());
    return this;
  }

  types() {
    return this.actions.map((a) =>
      a.type === 'click'
        ? `click:${a.button}`
        : a.type === 'button'
          ? `button:${a.action}`
          : a.type,
    );
  }
}

describe('one finger', () => {
  it('moving sends move actions with the finger delta, accelerated', () => {
    const f = new Finger()
      .start(0, [at(1, 100, 100)])
      .move(100, [at(1, 120, 100)])
      .move(200, [at(1, 125, 103)]);
    expect(f.types()).toEqual(['move', 'move']);
    const [first, second] = f.actions;
    if (first?.type !== 'move' || second?.type !== 'move') throw new Error('expected moves');
    expect(first.dx).toBeGreaterThanOrEqual(20); // whole delta since touch-down, gain ≥ 1
    expect(first.dy).toBe(0);
    expect(second.dx).toBeCloseTo(5 * (1 + 0.6 * (Math.hypot(5, 3) / 100)));
    expect(second.dy).toBeCloseTo(3 * (1 + 0.6 * (Math.hypot(5, 3) / 100)));
  });

  it('a quick tap sends one left click', () => {
    const f = new Finger().start(0, [at(1, 50, 50)]).end(TAP_MAX_DURATION_MS - 1);
    expect(f.types()).toEqual(['click:left']);
  });

  it('jitter within the tap slop is still a tap and sends no move', () => {
    const f = new Finger()
      .start(0, [at(1, 50, 50)])
      .move(50, [at(1, 50 + TAP_SLOP_PX - 1, 50)])
      .end(100);
    expect(f.types()).toEqual(['click:left']);
  });

  it('a slow move over 10 px is a move, not a tap', () => {
    const f = new Finger()
      .start(0, [at(1, 50, 50)])
      .move(150, [at(1, 50 + TAP_SLOP_PX + 1, 50)])
      .end(190);
    expect(f.types()).toEqual(['move']);
  });

  it('a long press is not a tap', () => {
    const f = new Finger().start(0, [at(1, 50, 50)]).end(TAP_MAX_DURATION_MS);
    expect(f.types()).toEqual([]);
  });

  it('two quick taps send two left clicks (the server turns them into a double click)', () => {
    const f = new Finger()
      .start(0, [at(1, 50, 50)])
      .end(80)
      .start(150, [at(2, 52, 50)])
      .end(230);
    expect(f.types()).toEqual(['click:left', 'click:left']);
  });
});

describe('two fingers', () => {
  it('a two-finger tap sends one right click', () => {
    const f = new Finger()
      .start(0, [at(1, 50, 50)])
      .start(20, [at(1, 50, 50), at(2, 90, 50)])
      .end(120, [at(2, 90, 50)])
      .end(130);
    expect(f.types()).toEqual(['click:right']);
  });

  it('two fingers landing together and tapping also right-click', () => {
    const f = new Finger().start(0, [at(1, 50, 50), at(2, 90, 50)]).end(100);
    expect(f.types()).toEqual(['click:right']);
  });

  it('a slow two-finger touch is not a right click', () => {
    const f = new Finger()
      .start(0, [at(1, 50, 50), at(2, 90, 50)])
      .end(TAP_MAX_DURATION_MS, [at(2, 90, 50)])
      .end(TAP_MAX_DURATION_MS + 10);
    expect(f.types()).toEqual([]);
  });

  it('moving two fingers scrolls by the average finger delta', () => {
    const f = new Finger()
      .start(0, [at(1, 50, 50), at(2, 90, 50)])
      .move(50, [at(1, 50, 70), at(2, 90, 70)])
      .move(100, [at(1, 50, 80), at(2, 90, 84)]);
    expect(f.actions).toEqual([
      { type: 'scroll', dx: 0, dy: 20 },
      { type: 'scroll', dx: 0, dy: 12 },
    ]);
  });

  it('the scroll direction flips when natural scrolling is off', () => {
    const f = new Finger({ naturalScroll: false })
      .start(0, [at(1, 50, 50), at(2, 90, 50)])
      .move(50, [at(1, 62, 70), at(2, 102, 70)]);
    expect(f.actions).toEqual([{ type: 'scroll', dx: -12, dy: -20 }]);
  });

  it('the setting can change between gestures', () => {
    const f = new Finger();
    f.recognizer.setOptions({ naturalScroll: false });
    f.start(0, [at(1, 50, 50), at(2, 90, 50)]).move(50, [at(1, 50, 70), at(2, 90, 70)]);
    expect(f.actions).toEqual([{ type: 'scroll', dx: -0, dy: -20 }]);
  });

  it('lifting one finger mid-scroll sends no click and no cursor jump', () => {
    const f = new Finger()
      .start(0, [at(1, 50, 50), at(2, 90, 50)])
      .move(30, [at(1, 50, 80), at(2, 90, 80)])
      .end(60, [at(2, 90, 80)])
      .move(80, [at(2, 300, 400)])
      .move(100, [at(2, 310, 420)])
      .end(120);
    expect(f.types()).toEqual(['scroll']);
  });

  it('a second finger added while moving scrolls but never right-clicks', () => {
    const f = new Finger()
      .start(0, [at(1, 50, 50)])
      .move(50, [at(1, 80, 50)])
      .start(60, [at(1, 80, 50), at(2, 120, 50)])
      .end(100, [at(2, 120, 50)])
      .end(110);
    expect(f.types()).toEqual(['move']);
  });

  it('three fingers do nothing', () => {
    const f = new Finger()
      .start(0, [at(1, 50, 50), at(2, 90, 50)])
      .start(10, [at(1, 50, 50), at(2, 90, 50), at(3, 130, 50)])
      .move(40, [at(1, 50, 90), at(2, 90, 90), at(3, 130, 90)])
      .end(80, []);
    expect(f.types()).toEqual([]);
  });
});

describe('tap then drag', () => {
  /** A tap, then a new touch within the drag window that moves. */
  const startDrag = () =>
    new Finger()
      .start(0, [at(1, 50, 50)])
      .end(80)
      .start(80 + DRAG_WINDOW_MS - 1, [at(2, 50, 50)])
      .move(450, [at(2, 80, 50)])
      .move(500, [at(2, 100, 60)]);

  it('sends button down, then moves, then button up on lift', () => {
    const f = startDrag().end(600);
    expect(f.types()).toEqual(['click:left', 'button:down', 'move', 'move', 'button:up']);
  });

  it('sends button up on touch cancel', () => {
    const f = startDrag().cancel();
    expect(f.types()).toEqual(['click:left', 'button:down', 'move', 'move', 'button:up']);
  });

  it('sends button down only once however long the drag', () => {
    const f = startDrag();
    for (let i = 0; i < 20; i++) f.move(600 + i * 16, [at(2, 100 + i, 60)]);
    f.end(1000);
    expect(f.types().filter((t) => t === 'button:down')).toHaveLength(1);
    expect(f.types().filter((t) => t === 'button:up')).toHaveLength(1);
  });

  it('keeps dragging when a second finger lands and lifts, and releases with the first', () => {
    const f = startDrag()
      .start(600, [at(2, 100, 60), at(3, 200, 60)])
      .end(650, [at(2, 100, 60)])
      .move(700, [at(2, 120, 60)])
      .end(750);
    expect(f.types()).toEqual(['click:left', 'button:down', 'move', 'move', 'move', 'button:up']);
  });

  it('releases the button when the dragging finger lifts first', () => {
    const f = startDrag()
      .start(600, [at(2, 100, 60), at(3, 200, 60)])
      .end(650, [at(3, 200, 60)])
      .move(700, [at(3, 260, 90)])
      .end(750);
    expect(f.types()).toEqual(['click:left', 'button:down', 'move', 'move', 'button:up']);
  });

  it('does not start a drag when the second touch comes after the window', () => {
    const f = new Finger()
      .start(0, [at(1, 50, 50)])
      .end(80)
      .start(80 + DRAG_WINDOW_MS + 1, [at(2, 50, 50)])
      .move(500, [at(2, 90, 50)])
      .end(600);
    expect(f.types()).toEqual(['click:left', 'move']);
  });

  it('reset() releases a held button so nothing stays pressed', () => {
    const f = startDrag();
    expect(f.recognizer.reset()).toEqual([{ type: 'button', action: 'up' }]);
    expect(f.recognizer.reset()).toEqual([]);
    expect(f.recognizer.mode).toBe('idle');
  });
});

describe('robustness', () => {
  it('cancel without a drag sends nothing and returns to idle', () => {
    const f = new Finger()
      .start(0, [at(1, 50, 50)])
      .cancel()
      .end(50);
    expect(f.types()).toEqual([]);
    expect(f.recognizer.mode).toBe('idle');
  });

  it('ignores moves of unknown touches', () => {
    const f = new Finger()
      .start(0, [at(1, 50, 50)])
      .move(50, [at(9, 500, 500)])
      .end(100);
    expect(f.types()).toEqual(['click:left']);
  });
});
