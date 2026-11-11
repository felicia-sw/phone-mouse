import { describe, expect, it } from 'vitest';
import {
  ALIVE_CHECK_TIMEOUT_MS,
  Connection,
  TOKEN_STORAGE_KEY,
  backoffDelay,
  closeDecision,
  takeToken,
} from '../../src/phone_mouse/static/js/connection.js';

/** @typedef {import('../../src/phone_mouse/static/js/connection.js').Status} Status */

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

/** @param {string} hash */
function fakeLocation(hash) {
  return { hash, pathname: '/', search: '' };
}

function fakeHistory() {
  /** @type {string[]} */
  const urls = [];
  return {
    urls,
    /** @param {unknown} _state @param {string} _title @param {string} url */
    replaceState(_state, _title, url) {
      urls.push(url);
    },
  };
}

describe('takeToken', () => {
  it('reads the token from the fragment, stores it and strips it from the address bar', () => {
    const storage = new MemoryStorage();
    const history = fakeHistory();
    expect(takeToken(fakeLocation('#abc-123_XYZ'), history, storage)).toBe('abc-123_XYZ');
    expect(storage.getItem(TOKEN_STORAGE_KEY)).toBe('abc-123_XYZ');
    expect(history.urls).toEqual(['/']);
  });

  it('falls back to the stored token after a reload without a fragment', () => {
    const storage = new MemoryStorage();
    storage.setItem(TOKEN_STORAGE_KEY, 'saved');
    const history = fakeHistory();
    expect(takeToken(fakeLocation(''), history, storage)).toBe('saved');
    expect(history.urls).toEqual([]);
  });

  it('prefers a new fragment over a stored token', () => {
    const storage = new MemoryStorage();
    storage.setItem(TOKEN_STORAGE_KEY, 'old');
    expect(takeToken(fakeLocation('#new'), fakeHistory(), storage)).toBe('new');
    expect(storage.getItem(TOKEN_STORAGE_KEY)).toBe('new');
  });

  it('returns null when there is no token anywhere', () => {
    expect(takeToken(fakeLocation('#'), fakeHistory(), new MemoryStorage())).toBeNull();
    expect(takeToken(fakeLocation(''), fakeHistory(), null)).toBeNull();
  });

  it('still works when storage throws', () => {
    const broken = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    expect(takeToken(fakeLocation('#tok'), fakeHistory(), broken)).toBe('tok');
    expect(takeToken(fakeLocation(''), fakeHistory(), broken)).toBeNull();
  });
});

describe('closeDecision', () => {
  it.each([
    [4001, false, 'replaced'],
    [4003, false, 'unauthorized'],
    [4008, true, 'retrying'],
    [4400, true, 'retrying'],
    [1006, true, 'retrying'],
    [1001, true, 'retrying'],
    [1000, true, 'retrying'],
  ])('close code %i → reconnect %s, status %s', (code, reconnect, status) => {
    expect(closeDecision(code)).toEqual({ reconnect, status });
  });
});

describe('backoffDelay', () => {
  it('starts at 0.5 s and doubles up to 5 s', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(backoffDelay)).toEqual([
      500, 1000, 2000, 4000, 5000, 5000, 5000,
    ]);
  });
});

class FakeSocket {
  /** @type {string[]} */
  sent = [];
  readyState = 0;
  /** @type {number | null} */
  closedWith = null;
  /** @type {((event: any) => void) | null} */
  onopen = null;
  /** @type {((event: {data: any}) => void) | null} */
  onmessage = null;
  /** @type {((event: {code: number}) => void) | null} */
  onclose = null;

  /** @param {string} data */
  send(data) {
    this.sent.push(data);
  }
  /** @param {number} [code] */
  close(code) {
    this.closedWith = code ?? 1000;
  }

  // Test helpers: what the server or network does.
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  /** @param {object} message */
  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  /** @param {number} code */
  drop(code) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function harness() {
  /** @type {FakeSocket[]} */
  const sockets = [];
  /** @type {Status[]} */
  const statuses = [];
  /** @type {{callback: () => void, ms: number, cancelled: boolean}[]} */
  const timers = [];
  const connection = new Connection({
    url: 'ws://mac.local:8765/ws',
    token: 'tok',
    onStatus: (status) => statuses.push(status),
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      if (handle) /** @type {{cancelled: boolean}} */ (handle).cancelled = true;
    },
  });
  const runTimers = () => {
    const due = timers.splice(0).filter((t) => !t.cancelled);
    for (const timer of due) timer.callback();
    return due.map((t) => t.ms);
  };
  /** @param {number} index */
  const socket = (index) => {
    const found = sockets[index];
    if (!found) throw new Error(`no socket ${index}`);
    return found;
  };
  return { connection, sockets, socket, statuses, timers, runTimers };
}

describe('Connection', () => {
  it('sends hello on open and becomes connected on ready', () => {
    const h = harness();
    h.connection.start();
    h.socket(0).open();
    expect(h.socket(0).sent).toEqual([JSON.stringify({ t: 'hello', v: 1, token: 'tok' })]);
    expect(h.connection.ready).toBe(false);
    h.socket(0).receive({ t: 'ready', v: 1 });
    expect(h.connection.ready).toBe(true);
    expect(h.statuses).toEqual(['connecting', 'connected']);
  });

  it('only sends messages once the Mac is ready', () => {
    const h = harness();
    h.connection.start();
    h.socket(0).open();
    expect(h.connection.send({ t: 'click', b: 'left' })).toBe(false);
    h.socket(0).receive({ t: 'ready', v: 1 });
    expect(h.connection.send({ t: 'click', b: 'left' })).toBe(true);
    expect(h.socket(0).sent.at(-1)).toBe(JSON.stringify({ t: 'click', b: 'left' }));
  });

  it.each([4008, 4400, 1006])('reconnects with growing backoff after close %i', (code) => {
    const h = harness();
    h.connection.start();
    h.socket(0).drop(code);
    expect(h.runTimers()).toEqual([500]);
    h.socket(1).drop(code);
    expect(h.runTimers()).toEqual([1000]);
    h.socket(2).drop(code);
    expect(h.runTimers()).toEqual([2000]);
    expect(h.sockets).toHaveLength(4);
    expect(h.statuses).toEqual([
      'connecting',
      'retrying',
      'retrying',
      'retrying',
      'retrying',
      'retrying',
      'retrying',
    ]);
  });

  it('resets the backoff after a successful connection', () => {
    const h = harness();
    h.connection.start();
    h.socket(0).drop(1006);
    h.runTimers();
    h.socket(1).open();
    h.socket(1).receive({ t: 'ready', v: 1 });
    h.socket(1).drop(1006);
    expect(h.runTimers()).toEqual([500]);
  });

  it.each([
    [4001, 'replaced'],
    [4003, 'unauthorized'],
  ])('stops for good after close %i', (code, status) => {
    const h = harness();
    h.connection.start();
    h.socket(0).open();
    h.socket(0).drop(code);
    expect(h.statuses.at(-1)).toBe(status);
    expect(h.runTimers()).toEqual([]);
    h.connection.refresh();
    expect(h.sockets).toHaveLength(1);
  });

  it('takeOver reconnects after being replaced', () => {
    const h = harness();
    h.connection.start();
    h.socket(0).drop(4001);
    h.connection.takeOver();
    expect(h.sockets).toHaveLength(2);
    expect(h.statuses.at(-1)).toBe('connecting');
  });

  it('refresh reconnects at once when not connected', () => {
    const h = harness();
    h.connection.start();
    h.socket(0).drop(1006); // a retry is scheduled
    h.connection.refresh();
    expect(h.sockets).toHaveLength(2);
    expect(h.runTimers()).toEqual([]); // the scheduled retry was cancelled
  });

  it('refresh keeps a live connection that answers the ping', () => {
    const h = harness();
    h.connection.start();
    h.socket(0).open();
    h.socket(0).receive({ t: 'ready', v: 1 });
    h.connection.refresh();
    const sentPing = JSON.parse(h.socket(0).sent.at(-1) ?? '{}');
    expect(sentPing.t).toBe('ping');
    h.socket(0).receive({ t: 'pong', id: sentPing.id });
    h.runTimers();
    expect(h.sockets).toHaveLength(1);
  });

  it('refresh replaces a connection that does not answer in time', () => {
    const h = harness();
    h.connection.start();
    h.socket(0).open();
    h.socket(0).receive({ t: 'ready', v: 1 });
    h.connection.refresh();
    expect(h.runTimers()).toEqual([ALIVE_CHECK_TIMEOUT_MS]);
    expect(h.sockets).toHaveLength(2);
    expect(h.socket(0).closedWith).toBe(1000);
  });

  it('ignores close events from a socket it already replaced', () => {
    const h = harness();
    h.connection.start();
    h.socket(0).open();
    h.socket(0).receive({ t: 'ready', v: 1 });
    h.connection.refresh();
    h.runTimers(); // socket 0 replaced by socket 1
    const statusesBefore = h.statuses.length;
    h.socket(0).drop(4001);
    expect(h.statuses).toHaveLength(statusesBefore);
  });

  it('ignores malformed server messages', () => {
    const h = harness();
    h.connection.start();
    h.socket(0).open();
    h.socket(0).onmessage?.({ data: 'not json' });
    h.socket(0).onmessage?.({ data: 'null' });
    expect(h.connection.ready).toBe(false);
  });

  it('stop closes the socket and never reconnects', () => {
    const h = harness();
    h.connection.start();
    h.connection.stop();
    expect(h.socket(0).closedWith).toBe(1000);
    expect(h.runTimers()).toEqual([]);
  });
});
