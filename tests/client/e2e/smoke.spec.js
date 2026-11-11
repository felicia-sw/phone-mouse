// End-to-end smoke test: a real `phone-mouse --dry-run` server and the real page in Chromium
// with a phone-sized touch screen. Run with `npm run e2e` (needs `uv` and a Chromium for
// Playwright). Gestures are checked through the dry-run driver's log lines.

import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

/** @typedef {import('node:child_process').ChildProcessWithoutNullStreams} Server */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/** @type {Server | null} */
let server = null;
let pairingUrl = '';
let serverLog = '';

test.beforeAll(async () => {
  const port = await freePort();
  server = spawn(
    'uv',
    ['run', 'phone-mouse', '--dry-run', '--host', '127.0.0.1', '--port', String(port)],
    { env: { ...process.env, PYTHONUNBUFFERED: '1' } },
  );
  server.stderr.on('data', (chunk) => {
    serverLog += String(chunk);
  });
  pairingUrl = await waitForPairingUrl(server, port);
  await waitForHealthz(port);
});

test.afterAll(() => {
  server?.kill();
});

test('connects, strips the token and shows "Connected"', async ({ page }) => {
  await page.goto(pairingUrl);
  await expect(page.locator('#status-text')).toHaveText('Connected');
  expect(new URL(page.url()).hash).toBe('');
});

test('a one-finger drag and a tap reach the dry-run driver', async ({ page }) => {
  await page.goto(pairingUrl);
  await expect(page.locator('#status-text')).toHaveText('Connected');
  const before = serverLog.length;

  await page.evaluate(async () => {
    const pad = /** @type {HTMLElement} */ (document.getElementById('trackpad'));
    /** @param {number} x @param {number} y */
    const touch = (x, y) => new Touch({ identifier: 1, target: pad, clientX: x, clientY: y });
    /** @param {string} type @param {Touch[]} touches @param {Touch[]} changed */
    const fire = (type, touches, changed) =>
      pad.dispatchEvent(
        new TouchEvent(type, {
          touches,
          targetTouches: touches,
          changedTouches: changed,
          bubbles: true,
          cancelable: true,
        }),
      );
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    // Drag: move the pointer 60 px right in steps.
    fire('touchstart', [touch(100, 300)], [touch(100, 300)]);
    for (let x = 115; x <= 160; x += 15) {
      fire('touchmove', [touch(x, 300)], [touch(x, 300)]);
      await frame();
    }
    fire('touchend', [], [touch(160, 300)]);
    await frame();

    // Wait out the drag window, then tap.
    await new Promise((resolve) => setTimeout(resolve, 400));
    fire('touchstart', [touch(200, 400)], [touch(200, 400)]);
    fire('touchend', [], [touch(200, 400)]);
  });

  await expect.poll(() => serverLog.slice(before)).toMatch(/dry-run: move\(\d/);
  await expect.poll(() => serverLog.slice(before)).toContain("dry-run: click('left', 1)");
});

test('every keyboard and media control reaches the dry-run driver', async ({ page }) => {
  await page.goto(pairingUrl);
  await expect(page.locator('#status-text')).toHaveText('Connected');
  const before = serverLog.length;
  const log = () => serverLog.slice(before);

  await page.click('#keyboard-toggle');
  await expect(page.locator('#keyboard-panel')).toBeVisible();
  await page.fill('#text-input', 'héllo 😀');
  await page.click('#text-form button[type=submit]');
  await expect(page.locator('#text-input')).toHaveValue('');
  await expect.poll(log).toContain('dry-run: type_text (7 characters)');

  await page.fill('#text-input', 'a'.repeat(300));
  await page.press('#text-input', 'Enter');
  await expect.poll(log).toContain('dry-run: type_text (256 characters)');
  await expect.poll(log).toContain('dry-run: type_text (44 characters)');

  await page.click('[data-mod=cmd]');
  await expect(page.locator('[data-mod=cmd]')).toHaveAttribute('aria-pressed', 'true');
  await page.click('[data-key=left]');
  await expect(page.locator('[data-mod=cmd]')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(log).toContain("dry-run: key('left', frozenset({'cmd'}))");

  for (const name of ['enter', 'backspace', 'tab', 'escape', 'space', 'up', 'down', 'right']) {
    await page.click(`[data-key=${name}]`);
    await expect.poll(log).toContain(`dry-run: key('${name}', frozenset())`);
  }

  await page.click('#media-toggle');
  await expect(page.locator('#keyboard-panel')).toBeHidden();
  for (const name of ['playpause', 'next', 'prev', 'volup', 'voldown', 'mute']) {
    await page.click(`[data-media=${name}]`);
    await expect.poll(log).toContain(`dry-run: media('${name}',)`);
  }
});

test('a wrong token shows "Scan the QR code again"', async ({ page }) => {
  await page.goto(pairingUrl.replace(/#.*/, '#wrong-token'));
  await expect(page.locator('#status-text')).toHaveText('Scan the QR code again');
});

test('the page cannot be scrolled or zoomed by touch', async ({ page }) => {
  await page.goto(pairingUrl);
  const styles = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    return { touchAction: body.touchAction, userSelect: body.userSelect };
  });
  expect(styles).toEqual({ touchAction: 'none', userSelect: 'none' });
  await expect(page.locator('meta[name=viewport]')).toHaveAttribute('content', /user-scalable=no/);
});

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error()),
      );
    });
  });
}

/**
 * @param {Server} process
 * @param {number} port
 * @returns {Promise<string>}
 */
function waitForPairingUrl(process, port) {
  const pattern = new RegExp(`http://127\\.0\\.0\\.1:${port}/#[A-Za-z0-9_-]+`);
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`no pairing URL in: ${output}`)), 20_000);
    process.stdout.on('data', (chunk) => {
      output += String(chunk);
      const match = output.match(pattern);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
  });
}

/** @param {number} port */
async function waitForHealthz(port) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not become healthy');
}
