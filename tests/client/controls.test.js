import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  Modifiers,
  isKey,
  isMediaKey,
  isMod,
  mediaMessage,
  splitText,
  textMessages,
} from '../../src/phone_mouse/static/js/controls.js';
import { KEYS, MEDIA_KEYS, MODS } from '../../src/phone_mouse/static/js/protocol.js';

const page = readFileSync(new URL('../../src/phone_mouse/static/index.html', import.meta.url), {
  encoding: 'utf8',
});

/** @param {string} attribute */
const attributeValues = (attribute) =>
  [...page.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'g'))].map((match) => match[1] ?? '');

describe('text', () => {
  it('sends short text as one message', () => {
    expect(textMessages('héllo 😀')).toEqual([{ t: 'text', s: 'héllo 😀' }]);
  });

  it('splits text longer than 256 characters into several messages', () => {
    const long = 'a'.repeat(600);
    const messages = textMessages(long);
    expect(messages.map((m) => Array.from(m.s).length)).toEqual([256, 256, 88]);
    expect(messages.map((m) => m.s).join('')).toBe(long);
  });

  it('counts emoji as one character, like the server, and never splits them', () => {
    const text = 'x'.repeat(255) + '😀' + 'y';
    const chunks = splitText(text);
    expect(chunks).toEqual(['x'.repeat(255) + '😀', 'y']);
  });

  it('sends nothing for empty text', () => {
    expect(textMessages('')).toEqual([]);
  });
});

describe('keys and modifiers', () => {
  it('every key button on the page is a protocol key, and every key has a button', () => {
    const buttons = attributeValues('data-key');
    expect(buttons.every(isKey)).toBe(true);
    expect([...buttons].sort()).toEqual([...KEYS].sort());
  });

  it('every modifier has exactly one button', () => {
    const buttons = attributeValues('data-mod');
    expect(buttons.every(isMod)).toBe(true);
    expect([...buttons].sort()).toEqual([...MODS].sort());
  });

  it.each(KEYS)('pressing %s sends a key message without modifiers', (pressed) => {
    expect(new Modifiers().press(pressed)).toEqual({ t: 'key', k: pressed, mods: [] });
  });

  it('sticky modifiers apply to the next key only', () => {
    const modifiers = new Modifiers();
    expect(modifiers.toggle('cmd')).toBe(true);
    expect(modifiers.toggle('shift')).toBe(true);
    expect(modifiers.press('left')).toEqual({ t: 'key', k: 'left', mods: ['cmd', 'shift'] });
    expect(modifiers.press('left')).toEqual({ t: 'key', k: 'left', mods: [] });
  });

  it('tapping a modifier twice turns it off', () => {
    const modifiers = new Modifiers();
    modifiers.toggle('alt');
    expect(modifiers.toggle('alt')).toBe(false);
    expect(modifiers.isActive('alt')).toBe(false);
    expect(modifiers.press('enter').mods).toEqual([]);
  });

  it('rejects values that are not keys or modifiers', () => {
    expect(isKey('f1')).toBe(false);
    expect(isKey(undefined)).toBe(false);
    expect(isMod('hyper')).toBe(false);
  });
});

describe('media', () => {
  it('every media key has exactly one button on the page', () => {
    const buttons = attributeValues('data-media');
    expect(buttons.every(isMediaKey)).toBe(true);
    expect([...buttons].sort()).toEqual([...MEDIA_KEYS].sort());
  });

  it.each(MEDIA_KEYS)('%s sends a media message', (mediaKey) => {
    expect(mediaMessage(mediaKey)).toEqual({ t: 'media', k: mediaKey });
  });

  it('rejects unknown media keys', () => {
    expect(isMediaKey('eject')).toBe(false);
  });
});
