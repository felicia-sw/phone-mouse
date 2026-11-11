import { describe, expect, it } from 'vitest';
import { MAX_GAIN, accelerate, gain } from '../../src/phone_mouse/static/js/accel.js';

describe('gain', () => {
  it('is sensitivity × 1 at speed 0', () => {
    expect(gain(0, 1)).toBe(1);
    expect(gain(0, 2.5)).toBe(2.5);
  });

  it('grows with speed', () => {
    expect(gain(1, 1)).toBeCloseTo(1.6);
    expect(gain(2, 1)).toBeGreaterThan(gain(1, 1));
  });

  it('never exceeds sensitivity × 4, even for absurd input', () => {
    for (const sensitivity of [0.5, 1, 3]) {
      for (const speed of [0, 0.1, 1, 5, 100, 1e9, Infinity, -5, NaN]) {
        const g = gain(speed, sensitivity);
        expect(g).toBeGreaterThanOrEqual(sensitivity);
        expect(g).toBeLessThanOrEqual(sensitivity * MAX_GAIN);
      }
    }
  });
});

describe('accelerate', () => {
  it('scales both axes by the same gain', () => {
    const slow = accelerate(3, 4, 1000, 2);
    expect(slow.dx).toBeCloseTo(3 * gain(5 / 1000, 2));
    expect(slow.dy).toBeCloseTo(4 * gain(5 / 1000, 2));
  });

  it('treats zero elapsed time as 1 ms instead of dividing by zero', () => {
    const fast = accelerate(10, 0, 0, 1);
    expect(fast.dx).toBe(10 * MAX_GAIN);
  });
});
