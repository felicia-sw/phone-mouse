// Wire protocol v1 (PLAN.md §3): message types and builders for the phone side.
// The server rejects out-of-range values, so the builders clamp before sending.

export const PROTOCOL_VERSION = 1;
export const MAX_DELTA = 500;
export const MAX_TEXT_LENGTH = 256;

export const CLOSE_CODES = Object.freeze({
  REPLACED: 4001,
  UNAUTHORIZED: 4003,
  RATE_LIMITED: 4008,
  INVALID: 4400,
});

/** @typedef {'left' | 'right'} Button */
/** @typedef {'enter' | 'backspace' | 'tab' | 'escape' | 'space' | 'up' | 'down' | 'left' | 'right'} Key */
/** @typedef {'cmd' | 'shift' | 'alt' | 'ctrl'} Mod */
/** @typedef {'playpause' | 'next' | 'prev' | 'volup' | 'voldown' | 'mute'} MediaKey */

/** @type {readonly Key[]} */
export const KEYS = ['enter', 'backspace', 'tab', 'escape', 'space', 'up', 'down', 'left', 'right'];
/** @type {readonly Mod[]} */
export const MODS = ['cmd', 'shift', 'alt', 'ctrl'];
/** @type {readonly MediaKey[]} */
export const MEDIA_KEYS = ['playpause', 'next', 'prev', 'volup', 'voldown', 'mute'];

/**
 * @typedef {{t: 'hello', v: number, token: string}} HelloMessage
 * @typedef {{t: 'move', dx: number, dy: number}} MoveMessage
 * @typedef {{t: 'click', b: Button}} ClickMessage
 * @typedef {{t: 'button', b: 'left', a: 'down' | 'up'}} ButtonMessage
 * @typedef {{t: 'scroll', dx: number, dy: number}} ScrollMessage
 * @typedef {{t: 'text', s: string}} TextMessage
 * @typedef {{t: 'key', k: Key, mods: Mod[]}} KeyMessage
 * @typedef {{t: 'media', k: MediaKey}} MediaMessage
 * @typedef {{t: 'ping', id: number}} PingMessage
 * @typedef {HelloMessage | MoveMessage | ClickMessage | ButtonMessage | ScrollMessage |
 *   TextMessage | KeyMessage | MediaMessage | PingMessage} ClientMessage
 * @typedef {{t: 'ready', v: number} | {t: 'pong', id: number}} ServerMessage
 */

/**
 * Clamp to ±MAX_DELTA; anything that is not a finite number becomes 0.
 * @param {number} value
 * @returns {number}
 */
export function clampDelta(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, -MAX_DELTA), MAX_DELTA);
}

/** @param {string} token @returns {HelloMessage} */
export const hello = (token) => ({ t: 'hello', v: PROTOCOL_VERSION, token });

/** @param {number} dx @param {number} dy @returns {MoveMessage} */
export const move = (dx, dy) => ({ t: 'move', dx: clampDelta(dx), dy: clampDelta(dy) });

/** @param {Button} button @returns {ClickMessage} */
export const click = (button) => ({ t: 'click', b: button });

/** @param {'down' | 'up'} action @returns {ButtonMessage} */
export const button = (action) => ({ t: 'button', b: 'left', a: action });

/** @param {number} dx @param {number} dy @returns {ScrollMessage} */
export const scroll = (dx, dy) => ({ t: 'scroll', dx: clampDelta(dx), dy: clampDelta(dy) });

/** @param {string} text @returns {TextMessage} */
export const text = (text) => ({ t: 'text', s: text });

/** @param {Key} key @param {Mod[]} [mods] @returns {KeyMessage} */
export const key = (key, mods = []) => ({ t: 'key', k: key, mods: [...new Set(mods)] });

/** @param {MediaKey} mediaKey @returns {MediaMessage} */
export const media = (mediaKey) => ({ t: 'media', k: mediaKey });

/** @param {number} id @returns {PingMessage} */
export const ping = (id) => ({ t: 'ping', id });
