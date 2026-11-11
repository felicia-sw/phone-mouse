import { describe, expect, it } from 'vitest';
import * as protocol from '../../src/phone_mouse/static/js/protocol.js';

describe('message builders', () => {
  it('build the exact shapes the server accepts', () => {
    expect(protocol.hello('tok')).toEqual({ t: 'hello', v: 1, token: 'tok' });
    expect(protocol.move(1.5, -2)).toEqual({ t: 'move', dx: 1.5, dy: -2 });
    expect(protocol.click('right')).toEqual({ t: 'click', b: 'right' });
    expect(protocol.button('down')).toEqual({ t: 'button', b: 'left', a: 'down' });
    expect(protocol.scroll(0, 12)).toEqual({ t: 'scroll', dx: 0, dy: 12 });
    expect(protocol.text('hi')).toEqual({ t: 'text', s: 'hi' });
    expect(protocol.key('enter')).toEqual({ t: 'key', k: 'enter', mods: [] });
    expect(protocol.media('mute')).toEqual({ t: 'media', k: 'mute' });
    expect(protocol.ping(7)).toEqual({ t: 'ping', id: 7 });
  });

  it('clamp deltas to ±500 because the server rejects anything larger', () => {
    expect(protocol.move(900, -900)).toEqual({ t: 'move', dx: 500, dy: -500 });
    expect(protocol.scroll(-501, 501)).toEqual({ t: 'scroll', dx: -500, dy: 500 });
  });

  it('turn non-finite deltas into 0', () => {
    expect(protocol.move(NaN, Infinity)).toEqual({ t: 'move', dx: 0, dy: 0 });
  });

  it('remove duplicate modifiers', () => {
    expect(protocol.key('left', ['cmd', 'cmd', 'shift']).mods).toEqual(['cmd', 'shift']);
  });

  it('use the close codes from PLAN.md §3', () => {
    expect(protocol.CLOSE_CODES).toEqual({
      REPLACED: 4001,
      UNAUTHORIZED: 4003,
      RATE_LIMITED: 4008,
      INVALID: 4400,
    });
  });
});
