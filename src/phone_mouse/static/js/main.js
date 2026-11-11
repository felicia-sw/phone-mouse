// Wires the page together: touch events → gestures → batched messages → connection.

import { MotionBatcher } from './batcher.js';
import { Connection, STATUS_TEXT, takeToken } from './connection.js';
import { GestureRecognizer } from './gestures.js';
import { button, click } from './protocol.js';
import { SENSITIVITY_MAX, SENSITIVITY_MIN, loadSettings, saveSettings } from './settings.js';

/** @typedef {import('./gestures.js').Action} Action */
/** @typedef {import('./connection.js').Status} Status */

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new () => T} type
 * @returns {T}
 */
function element(id, type) {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`missing #${id}`);
  return found;
}

const storage = safeStorage(() => window.localStorage);
const sessionStore = safeStorage(() => window.sessionStorage);
const settings = loadSettings(storage);
const gestures = new GestureRecognizer(settings);
const batcher = new MotionBatcher();

const statusButton = element('status', HTMLButtonElement);
const statusText = element('status-text', HTMLSpanElement);
const trackpad = element('trackpad', HTMLElement);
const settingsSheet = element('settings', HTMLDialogElement);
const sensitivityInput = element('sensitivity', HTMLInputElement);
const sensitivityValue = element('sensitivity-value', HTMLOutputElement);
const naturalScrollInput = element('natural-scroll', HTMLInputElement);

/** @type {Status} */
let currentStatus = 'connecting';
const token = takeToken(window.location, window.history, sessionStore);
const connection = token
  ? new Connection({
      url: `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`,
      token,
      onStatus: showStatus,
    })
  : null;

/** @param {Status} status */
function showStatus(status) {
  currentStatus = status;
  statusButton.dataset['state'] = status;
  statusText.textContent = STATUS_TEXT[status];
  if (status !== 'connected') {
    batcher.clear();
    gestures.reset(); // the Mac releases held buttons itself when the socket drops
  }
}

// Gestures

let frameRequested = false;

function scheduleFlush() {
  if (frameRequested || !batcher.hasWork) return;
  frameRequested = true;
  window.requestAnimationFrame(() => {
    frameRequested = false;
    flushMotion();
    scheduleFlush();
  });
}

function flushMotion() {
  for (const message of batcher.flush()) connection?.send(message);
}

/** @param {Action[]} actions */
function perform(actions) {
  for (const action of actions) {
    switch (action.type) {
      case 'move':
        batcher.addMove(action.dx, action.dy);
        break;
      case 'scroll':
        batcher.addScroll(action.dx, action.dy);
        break;
      case 'click':
        flushMotion(); // the click must land where the cursor was moved to
        connection?.send(click(action.button));
        break;
      case 'button':
        flushMotion();
        connection?.send(button(action.action));
        break;
    }
  }
  scheduleFlush();
}

/** @param {TouchList} list */
function points(list) {
  return Array.from(list, (touch) => ({
    id: touch.identifier,
    x: touch.clientX,
    y: touch.clientY,
  }));
}

/**
 * @param {string} type
 * @param {(event: TouchEvent) => Action[]} handler
 */
function onTouch(type, handler) {
  trackpad.addEventListener(
    type,
    (event) => {
      const touchEvent = /** @type {TouchEvent} */ (event);
      touchEvent.preventDefault(); // no page scroll, zoom or bounce
      perform(handler(touchEvent));
    },
    { passive: false },
  );
}

onTouch('touchstart', (e) => gestures.touchStart(e.timeStamp, points(e.touches)));
onTouch('touchmove', (e) => gestures.touchMove(e.timeStamp, points(e.touches)));
onTouch('touchend', (e) => gestures.touchEnd(e.timeStamp, points(e.touches)));
onTouch('touchcancel', () => gestures.touchCancel());

// Buttons

element('left-button', HTMLButtonElement).addEventListener('click', () =>
  perform([{ type: 'click', button: 'left' }]),
);
element('right-button', HTMLButtonElement).addEventListener('click', () =>
  perform([{ type: 'click', button: 'right' }]),
);

statusButton.addEventListener('click', () => {
  if (currentStatus === 'replaced') connection?.takeOver();
});

// Settings

sensitivityInput.min = String(SENSITIVITY_MIN);
sensitivityInput.max = String(SENSITIVITY_MAX);
sensitivityInput.value = String(settings.sensitivity);
sensitivityValue.value = `${settings.sensitivity.toFixed(1)}×`;
naturalScrollInput.checked = settings.naturalScroll;

function applySettings() {
  settings.sensitivity = Number(sensitivityInput.value);
  settings.naturalScroll = naturalScrollInput.checked;
  sensitivityValue.value = `${settings.sensitivity.toFixed(1)}×`;
  gestures.setOptions(settings);
  saveSettings(storage, settings);
}

sensitivityInput.addEventListener('input', applySettings);
naturalScrollInput.addEventListener('change', applySettings);
element('settings-button', HTMLButtonElement).addEventListener('click', () =>
  settingsSheet.showModal(),
);
element('settings-done', HTMLButtonElement).addEventListener('click', () => settingsSheet.close());

// Lifecycle

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    perform(gestures.reset()); // never leave the button held while the page is away
  } else {
    connection?.refresh();
  }
});

if (connection) {
  connection.start();
} else {
  showStatus('unauthorized');
}

/**
 * Storage access itself can throw (for example with cookies blocked).
 * @param {() => Storage} get
 * @returns {Storage | null}
 */
function safeStorage(get) {
  try {
    return get();
  } catch {
    return null;
  }
}
