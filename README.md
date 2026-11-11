# phone-mouse

Use your iPhone as a trackpad and keyboard for your Mac.

A small program runs on the Mac and shows a QR code. Scan it with the iPhone camera, and Safari
opens a full-screen trackpad page. Your finger moves the Mac's cursor over your home Wi-Fi.
Nothing to install on the phone, no App Store, no account.

**Requirements:** a Mac with macOS 10.15 (Catalina) or later, and an iPhone on the **same Wi-Fi
network**.

## Install and start

1. Install [uv](https://docs.astral.sh/uv/), the tool that runs this project and fetches the
   right Python for it. In Terminal:

   ```sh
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```

   (Or, with Homebrew: `brew install uv`.) Close and reopen Terminal afterwards.

2. Download phone-mouse and start it:

   ```sh
   git clone https://github.com/felicia-sw/phone-mouse
   cd phone-mouse
   uv run phone-mouse
   ```

   The first start takes a few seconds while uv sets things up. Later starts are instant: just
   `cd phone-mouse` and `uv run phone-mouse`.

Leave the Terminal window open while you use it. Press **Ctrl+C** in it to stop.

### First start only: two macOS prompts

- **Accessibility permission** (needed to move the cursor). macOS shows a prompt, and
  phone-mouse prints the same steps:
  1. Open **System Settings › Privacy & Security › Accessibility**.
  2. Turn on the app you started phone-mouse from (for example **Terminal** or **iTerm**).
  3. Press Ctrl+C in Terminal and run `uv run phone-mouse` again.
- **Firewall** (only if the macOS firewall is on): "Do you want the application to accept
  incoming network connections?" Click **Allow**. If you clicked Deny by mistake, open
  **System Settings › Network › Firewall › Options…** and set the Python entry to
  **Allow incoming connections**.

## Pair your iPhone

1. Start phone-mouse. Terminal shows a QR code and an address like
   `http://192.168.1.20:8765/#…`.
2. Open the iPhone **Camera**, point it at the QR code and tap the link that appears.
3. Safari opens the trackpad. The pill at the top says **Connected**.

Every start of phone-mouse makes a new QR code, and old links stop working. That is on
purpose: a link only works while that run of phone-mouse is open.

### Add to Home Screen

In Safari tap **Share › Add to Home Screen**. The icon opens the trackpad full screen. Because
each run has a new code, scan the QR code again after restarting phone-mouse.

## Using it

| Gesture | What it does |
| --- | --- |
| Move one finger | Move the pointer (faster swipes go further) |
| Tap | Left click (tap twice quickly to double-click) |
| Tap with two fingers | Right click |
| Move two fingers | Scroll |
| Tap, then touch again and move | Drag (hold the button down) |

The bar at the bottom has:

- **Left** and **Right**: click buttons.
- **⌨**: type text (it is sent when you tap **Send**), plus keys for esc, tab, backspace, enter,
  space, the arrows, and ⌘ ⇧ ⌥ ⌃. Tap a modifier, then a key: ⌘ then ← jumps to the start of a line.
- **♫**: play/pause, next, previous, volume and mute.
- **Settings**: pointer speed and natural scrolling. They are remembered on the phone.

If the pill says **Connected elsewhere**, another phone or tab took over. Tap the pill to take
it back.

## Troubleshooting

**The phone cannot open the page or stays on "Can't reach the Mac"**

- Make sure the phone and the Mac are on the **same Wi-Fi network**, and the phone is not on
  mobile data.
- **Guest or hotel Wi-Fi** often blocks devices from talking to each other ("client isolation").
  That cannot be fixed from the Mac. Use your home network, or turn on the iPhone's Personal
  Hotspot and connect the Mac to it.
- A **VPN** on the Mac can make phone-mouse show the wrong address. Turn the VPN off, or start
  with the Mac's Wi-Fi address (shown in **System Settings › Wi-Fi › Details…**), for example
  `uv run phone-mouse --host 192.168.1.20` with your own address in place of `192.168.1.20`.
- Check the firewall step above.

**The page says "Scan the QR code again"**

phone-mouse was restarted, so the old link no longer works. Scan the new QR code.

**The page is connected but the cursor does not move**

The Accessibility permission is missing. Follow the steps under
[First start only](#first-start-only-two-macos-prompts), then restart phone-mouse. If you start
phone-mouse from a different app (for example VS Code's terminal), that app needs the permission.

**Port already in use**

Another copy is running. Stop it, or pick another port: `uv run phone-mouse --port 8766`.

**Trying it without moving the cursor**

`uv run phone-mouse --dry-run` logs every gesture instead of performing it. This works on any
computer, including Linux and Windows.

## Security

phone-mouse lets a phone control your computer, so it is careful about who that phone is:

- **A secret code in the QR code.** Each start makes a new random code. A phone without it is
  refused. The code sits after the `#` in the link, a part that browsers never send over the
  network in requests, so it never appears in logs.
- **Your local network only.** phone-mouse listens on the Mac's Wi-Fi address, not on the
  internet.
- **Only this page.** Other websites open on the phone cannot connect to it.
- **One phone at a time,** with a limit on how many actions per second it accepts, and only the
  fixed set of actions listed above: pointer, clicks, scrolling, typing, a few keys and media
  keys. There is no file access.
- **But a paired phone is as powerful as someone at your keyboard.** It can type and press
  shortcuts such as ⌘ Space, so only pair phones you trust and do not share the QR code.
- **Stops when you stop it.** Closing Terminal or pressing Ctrl+C ends everything.

**One limit to know:** the connection is not encrypted. Someone on the same Wi-Fi who records the
network traffic could see what you type, and could copy the code and use it to control your Mac
while phone-mouse is running. Use it on networks you trust, such as your home Wi-Fi, never on
public Wi-Fi.

## Development

You need [uv](https://docs.astral.sh/uv/) and Node.js 22 (Node is only for checking the web page,
never for running the app).

```sh
uv sync         # Python dependencies
npm ci          # web page checking tools
```

The full check, which must pass before every commit:

```sh
uv run ruff format --check . && uv run ruff check . && uv run mypy && uv run pytest
npm run check   # type check, unit tests and formatting for the web page
```

End-to-end test (a real server and the real page in Chromium):

```sh
npx playwright install chromium   # once
npm run e2e
```

### Layout

```
src/phone_mouse/
  cli.py          command line, startup banner
  app.py          web routes: the page, /healthz and the /ws WebSocket
  session.py      security rules: code check, one phone at a time, rate limit
  protocol.py     the messages the phone may send (frozen; see PLAN.md §3)
  pairing.py      the secret code, link and QR code
  net.py          finding the Mac's Wi-Fi address
  input/          InputDriver interface, a fake for tests and --dry-run, the macOS driver
  static/         the phone page: index.html, styles.css, js/
tests/            Python tests; tests/client/ for the page (vitest) and tests/client/e2e/
PLAN.md           architecture, protocol and task history
CLAUDE.md         rules for contributors (people and AI agents)
```

### Adding a gesture

1. Gestures are recognised in `src/phone_mouse/static/js/gestures.js`, a state machine with no
   page code in it. Thresholds are named constants at the top.
2. Add a mode or a transition, returning the existing actions (`move`, `scroll`, `click`,
   `button`).
3. Add tests to `tests/client/gestures.test.js` that feed touches in and check the actions out.
4. Run the full check.

A gesture that needs a **new kind of message** is a protocol change. The protocol is frozen, so
change `PLAN.md` §3 first and update `protocol.py`, `protocol.js` and the driver together.
