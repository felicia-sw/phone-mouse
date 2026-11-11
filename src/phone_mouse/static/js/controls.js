// Keyboard and media controls (PLAN.md T5): pure helpers that turn button presses and typed
// text into protocol messages. main.js wires them to the page.

import { KEYS, MAX_TEXT_LENGTH, MEDIA_KEYS, MODS, key, media, text } from './protocol.js';

/** @typedef {import('./protocol.js').Key} Key */
/** @typedef {import('./protocol.js').Mod} Mod */
/** @typedef {import('./protocol.js').MediaKey} MediaKey */

/**
 * Split text into chunks the server accepts. The server counts characters as Unicode code
 * points, so split on code points, never inside a surrogate pair.
 * @param {string} value
 * @param {number} [max]
 * @returns {string[]}
 */
export function splitText(value, max = MAX_TEXT_LENGTH) {
  const codePoints = Array.from(value);
  /** @type {string[]} */
  const chunks = [];
  for (let start = 0; start < codePoints.length; start += max) {
    chunks.push(codePoints.slice(start, start + max).join(''));
  }
  return chunks;
}

/**
 * @param {string} value
 * @returns {import('./protocol.js').TextMessage[]}
 */
export function textMessages(value) {
  return splitText(value).map(text);
}

/** @param {string | undefined} value @returns {value is Key} */
export const isKey = (value) => KEYS.some((k) => k === value);
/** @param {string | undefined} value @returns {value is Mod} */
export const isMod = (value) => MODS.some((m) => m === value);
/** @param {string | undefined} value @returns {value is MediaKey} */
export const isMediaKey = (value) => MEDIA_KEYS.some((m) => m === value);

/** @param {MediaKey} mediaKey */
export const mediaMessage = (mediaKey) => media(mediaKey);

/**
 * Sticky modifiers: tap ⌘, then ← sends Cmd+Left. Modifiers clear after one key.
 */
export class Modifiers {
  /** @type {Set<Mod>} */
  #active = new Set();

  /**
   * @param {Mod} mod
   * @returns {boolean} whether the modifier is now on
   */
  toggle(mod) {
    if (this.#active.has(mod)) {
      this.#active.delete(mod);
      return false;
    }
    this.#active.add(mod);
    return true;
  }

  /** @param {Mod} mod */
  isActive(mod) {
    return this.#active.has(mod);
  }

  /**
   * The message for pressing `pressed` with the active modifiers, which are then cleared.
   * @param {Key} pressed
   */
  press(pressed) {
    const message = key(
      pressed,
      MODS.filter((m) => this.#active.has(m)),
    );
    this.#active.clear();
    return message;
  }
}
