// User settings, remembered on this phone in localStorage.

export const SETTINGS_STORAGE_KEY = 'phone-mouse.settings.v1';
export const SENSITIVITY_MIN = 0.5;
export const SENSITIVITY_MAX = 4;

/** @typedef {{sensitivity: number, naturalScroll: boolean}} Settings */

/** @type {Readonly<Settings>} */
export const DEFAULT_SETTINGS = Object.freeze({ sensitivity: 1.5, naturalScroll: true });

/**
 * Load saved settings. Missing, corrupt or out-of-range values fall back to the defaults.
 * @param {Pick<Storage, 'getItem'> | null} storage
 * @returns {Settings}
 */
export function loadSettings(storage) {
  /** @type {unknown} */
  let saved;
  try {
    saved = JSON.parse(storage?.getItem(SETTINGS_STORAGE_KEY) ?? 'null');
  } catch {
    saved = null;
  }
  const settings = { ...DEFAULT_SETTINGS };
  if (typeof saved !== 'object' || saved === null) return settings;
  const { sensitivity, naturalScroll } = /** @type {Record<string, unknown>} */ (saved);
  if (
    typeof sensitivity === 'number' &&
    sensitivity >= SENSITIVITY_MIN &&
    sensitivity <= SENSITIVITY_MAX
  ) {
    settings.sensitivity = sensitivity;
  }
  if (typeof naturalScroll === 'boolean') settings.naturalScroll = naturalScroll;
  return settings;
}

/**
 * @param {Pick<Storage, 'setItem'> | null} storage
 * @param {Settings} settings
 */
export function saveSettings(storage, settings) {
  try {
    storage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be full or disabled; the settings still apply until the page reloads.
  }
}
