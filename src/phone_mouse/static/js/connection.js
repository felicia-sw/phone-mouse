// The WebSocket connection to the Mac: hello handshake, status, and reconnecting with backoff.

import { CLOSE_CODES, hello, ping } from './protocol.js';

export const BACKOFF_START_MS = 500;
export const BACKOFF_MAX_MS = 5000;
export const ALIVE_CHECK_TIMEOUT_MS = 2000;
export const TOKEN_STORAGE_KEY = 'phone-mouse.token';

/**
 * connecting: first attempt. connected: the Mac said ready. retrying: the connection dropped or
 * could not be made. replaced / unauthorized: the Mac closed us for good (see PLAN.md §3).
 * @typedef {'connecting' | 'connected' | 'retrying' | 'replaced' | 'unauthorized'} Status
 */

/** @type {Readonly<Record<Status, string>>} */
export const STATUS_TEXT = Object.freeze({
  connecting: 'Connecting…',
  connected: 'Connected',
  retrying: 'Can’t reach the Mac. Retrying…',
  replaced: 'Connected elsewhere. Tap to take over.',
  unauthorized: 'Scan the QR code again',
});

/**
 * Delay before reconnect attempt number `attempt` (0-based): 0.5 s doubling to 5 s.
 * @param {number} attempt
 * @returns {number}
 */
export function backoffDelay(attempt) {
  return Math.min(BACKOFF_START_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

/**
 * What to do when the Mac closes the socket with `code`.
 * @param {number} code
 * @returns {{reconnect: boolean, status: Status}}
 */
export function closeDecision(code) {
  switch (code) {
    case CLOSE_CODES.REPLACED:
      return { reconnect: false, status: 'replaced' };
    case CLOSE_CODES.UNAUTHORIZED:
      return { reconnect: false, status: 'unauthorized' };
    default:
      // 4008 (rate limit), 4400 (invalid message) and network drops.
      return { reconnect: true, status: 'retrying' };
  }
}

/**
 * Read the pairing token. A token in the URL fragment wins: it is saved for this tab and then
 * removed from the address bar, so it does not linger in history or screenshots.
 * @param {Pick<Location, 'hash' | 'pathname' | 'search'>} location
 * @param {Pick<History, 'replaceState'>} history
 * @param {Pick<Storage, 'getItem' | 'setItem'> | null} storage
 * @returns {string | null}
 */
export function takeToken(location, history, storage) {
  const fromHash = decodeFragment(location.hash);
  if (fromHash) {
    try {
      storage?.setItem(TOKEN_STORAGE_KEY, fromHash);
    } catch {
      // Storage can be unavailable (private mode); the token still works for this page load.
    }
    history.replaceState(null, '', location.pathname + location.search);
    return fromHash;
  }
  try {
    return storage?.getItem(TOKEN_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

/** @param {string} hash @returns {string} */
function decodeFragment(hash) {
  if (!hash.startsWith('#') || hash.length < 2) return '';
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return '';
  }
}

/**
 * @typedef {Pick<WebSocket, 'send' | 'close' | 'readyState'> & {
 *   onopen: ((event: any) => void) | null,
 *   onmessage: ((event: {data: any}) => void) | null,
 *   onclose: ((event: {code: number}) => void) | null,
 * }} SocketLike
 */

/**
 * @typedef {object} ConnectionOptions
 * @property {string} url
 * @property {string} token
 * @property {(status: Status) => void} onStatus
 * @property {(url: string) => SocketLike} [createSocket]
 * @property {(callback: () => void, ms: number) => unknown} [setTimer]
 * @property {(handle: unknown) => void} [clearTimer]
 */

/**
 * A real WebSocket. Its handler types are richer than SocketLike's, which only names the
 * parts this module uses, so the cast is safe.
 * @param {string} url
 * @returns {SocketLike}
 */
function defaultSocket(url) {
  return /** @type {SocketLike} */ (/** @type {unknown} */ (new WebSocket(url)));
}

export class Connection {
  #url;
  #token;
  #onStatus;
  #createSocket;
  #setTimer;
  #clearTimer;
  /** @type {SocketLike | null} */
  #socket = null;
  #ready = false;
  #attempt = 0;
  #stopped = true;
  /** @type {unknown} */
  #retryTimer = null;
  /** @type {unknown} */
  #aliveTimer = null;
  #nextPingId = 1;
  /** @type {number | null} */
  #awaitedPong = null;

  /** @param {ConnectionOptions} options */
  constructor(options) {
    this.#url = options.url;
    this.#token = options.token;
    this.#onStatus = options.onStatus;
    this.#createSocket = options.createSocket ?? defaultSocket;
    this.#setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.#clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(/** @type {number} */ (handle)));
  }

  get ready() {
    return this.#ready;
  }

  start() {
    this.#stopped = false;
    this.#attempt = 0;
    this.#open('connecting');
  }

  /**
   * Send a message if the Mac is ready. Returns false (and drops it) otherwise:
   * stale gestures must not be replayed later.
   * @param {import('./protocol.js').ClientMessage} message
   * @returns {boolean}
   */
  send(message) {
    if (!this.#ready || !this.#socket) return false;
    this.#socket.send(JSON.stringify(message));
    return true;
  }

  /**
   * Called when the page becomes visible again. iOS freezes pages in the background, which can
   * leave a socket that looks open but is dead, so prove it is alive or replace it.
   */
  refresh() {
    if (this.#stopped) return;
    if (!this.#ready) {
      this.#attempt = 0;
      this.#open('connecting');
      return;
    }
    const id = this.#nextPingId++;
    this.#awaitedPong = id;
    this.send(ping(id));
    this.#clearTimer(this.#aliveTimer);
    this.#aliveTimer = this.#setTimer(() => {
      if (this.#awaitedPong === id) this.#open('connecting');
    }, ALIVE_CHECK_TIMEOUT_MS);
  }

  /** Connect again after the Mac closed us for good, for example to take over from another phone. */
  takeOver() {
    this.start();
  }

  stop() {
    this.#stopped = true;
    this.#discardSocket();
  }

  /** @param {Status} status */
  #open(status) {
    this.#discardSocket();
    this.#onStatus(status);
    const socket = this.#createSocket(this.#url);
    this.#socket = socket;
    socket.onopen = () => socket.send(JSON.stringify(hello(this.#token)));
    socket.onmessage = (event) => this.#handleMessage(event.data);
    socket.onclose = (event) => this.#handleClose(socket, event.code);
  }

  /** @param {unknown} data */
  #handleMessage(data) {
    /** @type {unknown} */
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const { t } = /** @type {{t?: unknown, id?: unknown}} */ (message);
    if (t === 'ready') {
      this.#ready = true;
      this.#attempt = 0;
      this.#onStatus('connected');
    } else if (t === 'pong' && /** @type {{id?: unknown}} */ (message).id === this.#awaitedPong) {
      this.#awaitedPong = null;
      this.#clearTimer(this.#aliveTimer);
    }
  }

  /** @param {SocketLike} socket @param {number} code */
  #handleClose(socket, code) {
    if (socket !== this.#socket) return; // a socket we already replaced
    this.#socket = null;
    this.#ready = false;
    if (this.#stopped) return;
    const decision = closeDecision(code);
    this.#onStatus(decision.status);
    if (!decision.reconnect) {
      this.#stopped = true;
      return;
    }
    const delay = backoffDelay(this.#attempt);
    this.#attempt += 1;
    this.#retryTimer = this.#setTimer(() => this.#open('retrying'), delay);
  }

  #discardSocket() {
    this.#clearTimer(this.#retryTimer);
    this.#clearTimer(this.#aliveTimer);
    this.#retryTimer = null;
    this.#aliveTimer = null;
    this.#awaitedPong = null;
    this.#ready = false;
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      try {
        socket.close(1000);
      } catch {
        // Already closed.
      }
    }
  }
}
