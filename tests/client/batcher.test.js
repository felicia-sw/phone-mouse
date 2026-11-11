import { describe, expect, it } from 'vitest';
import { MotionBatcher } from '../../src/phone_mouse/static/js/batcher.js';

describe('MotionBatcher', () => {
  it('sends at most one move and one scroll per flush, summing the deltas', () => {
    const batcher = new MotionBatcher();
    batcher.addMove(3, 1);
    batcher.addMove(4, -2);
    batcher.addScroll(0, 10);
    batcher.addScroll(0, 5);
    expect(batcher.flush()).toEqual([
      { t: 'move', dx: 7, dy: -1 },
      { t: 'scroll', dx: 0, dy: 15 },
    ]);
    expect(batcher.flush()).toEqual([]);
  });

  it('keeps the fractional remainder for the next frame', () => {
    const batcher = new MotionBatcher();
    batcher.addMove(1.6, -0.7);
    expect(batcher.flush()).toEqual([{ t: 'move', dx: 1, dy: 0 }]);
    batcher.addMove(0.5, -0.4);
    expect(batcher.flush()).toEqual([{ t: 'move', dx: 1, dy: -1 }]);
    expect(batcher.hasWork).toBe(false);
  });

  it('sends nothing for sub-pixel motion until it adds up', () => {
    const batcher = new MotionBatcher();
    batcher.addScroll(0.3, 0);
    expect(batcher.hasWork).toBe(false);
    expect(batcher.flush()).toEqual([]);
    batcher.addScroll(0.8, 0);
    expect(batcher.flush()).toEqual([{ t: 'scroll', dx: 1, dy: 0 }]);
  });

  it('splits motion beyond the ±500 limit across frames instead of dropping it', () => {
    const batcher = new MotionBatcher();
    batcher.addMove(1200, 0);
    expect(batcher.flush()).toEqual([{ t: 'move', dx: 500, dy: 0 }]);
    expect(batcher.flush()).toEqual([{ t: 'move', dx: 500, dy: 0 }]);
    expect(batcher.flush()).toEqual([{ t: 'move', dx: 200, dy: 0 }]);
  });

  it('clear drops pending motion', () => {
    const batcher = new MotionBatcher();
    batcher.addMove(50, 50);
    batcher.clear();
    expect(batcher.flush()).toEqual([]);
  });
});
