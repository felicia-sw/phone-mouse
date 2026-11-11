import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  saveSettings,
} from '../../src/phone_mouse/static/js/settings.js';

class MemoryStorage {
  /** @type {Map<string, string>} */
  items = new Map();
  /** @param {string} key */
  getItem(key) {
    return this.items.get(key) ?? null;
  }
  /** @param {string} key @param {string} value */
  setItem(key, value) {
    this.items.set(key, value);
  }
}

describe('settings', () => {
  it('persist across loads', () => {
    const storage = new MemoryStorage();
    saveSettings(storage, { sensitivity: 2.3, naturalScroll: false });
    expect(loadSettings(storage)).toEqual({ sensitivity: 2.3, naturalScroll: false });
  });

  it('default when nothing is saved or storage is missing', () => {
    expect(loadSettings(new MemoryStorage())).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it.each([
    ['not json', DEFAULT_SETTINGS],
    ['42', DEFAULT_SETTINGS],
    ['{"sensitivity": 99, "naturalScroll": "yes"}', DEFAULT_SETTINGS],
    ['{"sensitivity": 0.1}', DEFAULT_SETTINGS],
    ['{"naturalScroll": false}', { ...DEFAULT_SETTINGS, naturalScroll: false }],
  ])('ignore bad saved value %s', (saved, expected) => {
    const storage = new MemoryStorage();
    storage.setItem(SETTINGS_STORAGE_KEY, saved);
    expect(loadSettings(storage)).toEqual(expected);
  });

  it('survive storage that throws', () => {
    const broken = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('full');
      },
    };
    expect(() => saveSettings(broken, DEFAULT_SETTINGS)).not.toThrow();
    expect(loadSettings(broken)).toEqual(DEFAULT_SETTINGS);
  });

  it('return a fresh object each time, never the frozen defaults', () => {
    const settings = loadSettings(null);
    settings.sensitivity = 3;
    expect(DEFAULT_SETTINGS.sensitivity).toBe(1.5);
  });
});
