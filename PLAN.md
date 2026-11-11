# phone-mouse — project plan

Status: planned, nothing built yet. Tick tasks in §6 as they merge.

## 1. What we are building

A Mac runs `phone-mouse`. It prints a QR code. The iPhone scans it, Safari opens a full-screen
trackpad page, and finger gestures control the Mac's cursor over the local Wi-Fi.

In scope for v1: move, left/right click, double click, drag, two-finger scroll, typing text, a few
special keys, media/volume keys, auto-reconnect, "Add to Home Screen".

Out of scope: native iOS app, Windows/Linux hosts, use over the internet, multiple phones at once,
gyroscope "air mouse".

## 2. Stack (fixed)

| Part | Choice |
| --- | --- |
| Language (server) | Python 3.12, `src/` layout, managed with `uv` |
| Web server | FastAPI + uvicorn (HTTP for the page, WebSocket for input) |
| Validation | pydantic v2 |
| Mouse/keyboard on macOS | `pyobjc-framework-Quartz` (installed only when `sys_platform == "darwin"`) |
| QR code | `qrcode` (rendered as text in the terminal) |
| Client | Plain HTML + CSS + ES-module JavaScript with JSDoc types. No build step. |
| Python quality | `ruff` (format + lint), `mypy --strict`, `pytest`, `httpx` (test client) |
| Client quality | `typescript` (`tsc --noEmit`, `checkJs`), `vitest`, `prettier`, `playwright` (one smoke test) — dev-only, via npm |
| CI | GitHub Actions: Ubuntu job (everything) + macOS job (driver import/construct tests) |

Node is needed only to run client checks, never to run the app.

## 3. Wire protocol v1 (frozen)

One WebSocket at `/ws`. Every frame is one JSON object as text. Unknown fields are rejected.

### Phone → Mac

| Message | Meaning and limits |
| --- | --- |
| `{"t":"hello","v":1,"token":"…"}` | Must be the first frame, within 3 s of connecting. |
| `{"t":"move","dx":n,"dy":n}` | Relative cursor move in screen points. Each value clamped to ±500. |
| `{"t":"click","b":"left"\|"right"}` | Press and release. The server works out double-clicks (see §4.3). |
| `{"t":"button","b":"left","a":"down"\|"up"}` | Hold/release, used for drag. Left only. |
| `{"t":"scroll","dx":n,"dy":n}` | Scroll in pixels. Each value clamped to ±500. |
| `{"t":"text","s":"…"}` | Type this text. 1–256 characters. |
| `{"t":"key","k":K,"mods":[M…]}` | `K`: `enter` `backspace` `tab` `escape` `space` `up` `down` `left` `right`. `M` (optional): `cmd` `shift` `alt` `ctrl`. |
| `{"t":"media","k":K}` | `K`: `playpause` `next` `prev` `volup` `voldown` `mute`. |
| `{"t":"ping","id":n}` | Latency check / keep-alive. |

### Mac → Phone

| Message | Meaning |
| --- | --- |
| `{"t":"ready","v":1}` | Sent once after a valid `hello`. |
| `{"t":"pong","id":n}` | Reply to `ping`. |

### Close codes

| Code | Reason | Client should |
| --- | --- | --- |
| 4001 | Replaced by a newer connection | Stop, show "connected elsewhere" |
| 4003 | Bad/missing token or bad Origin | Stop, show "scan the QR code again" |
| 4008 | Rate limit exceeded | Reconnect with backoff |
| 4400 | Invalid message | Reconnect with backoff |
| other | Network drop | Reconnect with backoff (0.5 s doubling to 5 s) |

## 4. Design

### 4.1 Layout

```
pyproject.toml  package.json  tsconfig.json  .github/workflows/ci.yml
src/phone_mouse/
  cli.py          # argument parsing, startup banner, runs uvicorn
  app.py          # create_app(settings, driver) -> FastAPI; routes: GET /, /healthz, WS /ws
  session.py      # auth, single-client rule, rate limit, dispatch message -> driver
  protocol.py     # pydantic models for §3 + parse_message(raw) -> Message
  pairing.py      # token generation, pairing URL, terminal QR code
  net.py          # find the Mac's LAN IPv4 address
  input/
    base.py       # InputDriver Protocol (interface)
    fake.py       # FakeDriver: records calls. Used by tests and --dry-run
    macos.py      # QuartzDriver + accessibility-permission check
    __init__.py   # create_driver(dry_run) factory
  static/
    index.html  styles.css  manifest.webmanifest  icons/
    js/main.js        # wires everything together
    js/connection.js  # WebSocket, hello, reconnect, ping
    js/gestures.js    # pure state machine: touch events in, actions out
    js/accel.js       # pure pointer-acceleration function
    js/settings.js    # sensitivity, natural scroll; saved in localStorage
    js/protocol.js    # JSDoc typedefs + message builders for §3
tests/            # Python tests mirror src/ ; client tests in tests/client/*.test.js
```

Dependency direction: `cli → app → session → protocol, input.base`. Nothing imports upward.

### 4.2 `InputDriver` interface

```python
class InputDriver(Protocol):
    def move(self, dx: float, dy: float) -> None: ...
    def click(self, button: Button, count: int) -> None: ...   # count: 1 single, 2 double, 3 triple
    def button(self, button: Button, down: bool) -> None: ...
    def scroll(self, dx: float, dy: float) -> None: ...
    def type_text(self, text: str) -> None: ...
    def key(self, key: Key, mods: frozenset[Mod]) -> None: ...
    def media(self, key: MediaKey) -> None: ...
    def release_all(self) -> None: ...   # release any held button; called on every disconnect
```

### 4.3 Session rules (`session.py`)

- **Auth:** first frame must be `hello` with `v == 1` and the right token, compared with
  `secrets.compare_digest`. Otherwise close 4003. No `hello` within 3 s: close 4003.
- **Origin:** reject the WebSocket (4003) unless the `Origin` header's host:port equals the
  request's `Host` header.
- **One phone:** when a new connection authenticates, close the previous one with 4001.
- **Rate limit:** more than 240 frames in any 1 s window: close 4008.
- **Invalid frame** (bad JSON, unknown type, out-of-range field): close 4400.
- **Click count:** a `click` on the same button within 300 ms of the previous one increments the
  count (max 3); otherwise count is 1. Use an injectable clock so tests are deterministic.
- **Cleanup:** on any disconnect call `driver.release_all()`.
- Driver calls are quick and synchronous; call them directly from the handler.

### 4.4 Pairing and network (`pairing.py`, `net.py`, `cli.py`)

- Token: `secrets.token_urlsafe(32)`, new on every start, kept in memory only.
- Pairing URL: `http://<lan-ip>:<port>/#<token>`. The token is in the **fragment** so it is never
  sent in an HTTP request or written to access logs.
- Bind to the detected LAN address only. `--host` overrides. Default port 8765 (`--port`).
- Startup prints: the URL, the QR code, and on macOS a clear warning with steps if the
  accessibility permission is missing.
- `--dry-run` uses `FakeDriver` and logs each action; works on any OS.

### 4.5 Client behaviour

`gestures.js` is a pure state machine (no DOM access) so it is unit-testable. Thresholds are named
constants at the top of the file.

| Gesture | Action sent |
| --- | --- |
| One finger moves | `move` (after acceleration) |
| One-finger tap: under 200 ms, under 10 px travel | `click` left |
| Two-finger tap | `click` right |
| Two fingers move | `scroll` (direction flips with the "natural scroll" setting) |
| Tap, then touch again within 300 ms and move | `button` left down → `move`s → `button` left up on lift |

- **Acceleration (`accel.js`):** `gain = sensitivity × clamp(1 + 0.6 × speed, 1, 4)`, speed in
  px/ms. Pure function.
- **Batching:** sum deltas and send at most one `move` and one `scroll` per animation frame.
  Carry the fractional remainder to the next frame.
- **Page:** token is read from `location.hash`, saved to `sessionStorage`, then removed from the
  address bar with `history.replaceState`. CSS `touch-action: none; user-select: none`. Viewport
  disables zoom. A status dot shows connecting / connected / error with the texts from §3.
- **Layout:** trackpad fills the screen; a bottom bar has: left button, right button, keyboard
  toggle, media toggle, settings. Respect iPhone safe-area insets. Dark theme.

### 4.6 macOS driver notes (`input/macos.py`)

Verify every call below in current pyobjc/Apple documentation before use.

- Move: read current location, add delta, clamp to the union of all active display bounds, post a
  mouse-moved event — or a left-mouse-**dragged** event while the left button is held.
- Click: post down then up with the click-state field set to `count`.
- Scroll: pixel-unit scroll-wheel event with two axes.
- Text: keyboard events carrying a Unicode string, sent in chunks of at most 20 UTF-16 units.
- Keys: virtual key codes plus modifier flags.
- Media: system-defined `NSEvent` (subtype 8) with the `NX_KEYTYPE_*` codes.
- Permission: check event-posting access at startup; if missing, request it and print the
  System Settings path (Privacy & Security → Accessibility).

## 5. Who should run each task

Use Claude Code. One fresh session per task, started with the prompt in §7.

| Model | Use it for | Why |
| --- | --- | --- |
| Opus 5.5 (`claude-opus-5-5`), effort `high` | T1, T2, T3 | Security-critical core, OS APIs that cannot be run in CI, and the fiddly gesture state machine. Mistakes here are costly or hard to spot. |
| Sonnet 5.5 (`claude-sonnet-5-5`), default effort | T0, T4, T5, T6 | Well-specified, conventional work (scaffolding, UI shell, features on top of an existing pattern, docs). Faster and cheaper, and the spec leaves little to decide. |
| Fable 5.2 (`claude-fable-5-2`), effort `high` | T7 | Final whole-project review. Must be a different session from any implementer so it reads the code cold. |
| Haiku 5.5 | Not assigned | The project is too small to need a bulk/mechanical worker. |

T2 and the driver half of T5 touch code that only runs on a Mac. Best: run those sessions in
Claude Code **on the Mac itself** so the agent can execute the manual checks. If run in the cloud,
the human must run the PR's manual checklist.

## 6. Tasks

Order: `T0 → T1 → (T2, T3, T4 in parallel) → T5 → T6 → T7`.

### File scope per task

A task may create or edit only these paths (plus its own tests under `tests/` and its checkbox in
this file). Touching anything else fails review.

| Task | May edit |
| --- | --- |
| T0 | Root config files, `.github/`, empty package tree, `cli.py` |
| T1 | `protocol.py`, `session.py`, `app.py`, `pairing.py`, `net.py`, `cli.py`, `input/base.py`, `input/fake.py`, `input/__init__.py`, placeholder `static/index.html` |
| T2 | `input/macos.py`, `input/__init__.py` |
| T3 | `static/js/gestures.js`, `static/js/accel.js`, `static/js/protocol.js` |
| T4 | `static/` except the three T3 files |
| T5 | `static/` (keyboard and media panels); `input/macos.py` for gap fixes only |
| T6 | `README.md` |
| T7 | Anything, but only to fix a written finding |

### Review gate (every task T0–T6)

The session that wrote a PR never approves it.

1. A **fresh** session (Opus 5.5, high effort) is started with the review prompt in §7.
2. It checks: every "Done when" line has a passing test or a listed manual check; the diff stays
   inside the task's file scope; the rules in `CLAUDE.md` hold; the full check is green. It runs
   `/code-review high` on the PR.
3. It posts findings rated `blocker`, `high`, `medium` or `low`.
4. Merge only when there is no `blocker` or `high` finding. Otherwise the implementer session
   fixes them on the same branch and a fresh review runs again.
5. After 3 failed rounds, stop and ask the human.

### - [x] T0 — Scaffold and CI · Sonnet 5.5

Depends on: nothing.

Build: `pyproject.toml` (deps from §2, `phone-mouse` console script → `phone_mouse.cli:main`,
ruff + mypy strict + pytest config), `package.json` with a `check` script, `tsconfig.json`
(`checkJs`, `noEmit`, `strict`), `.gitignore`, `.github/workflows/ci.yml` (Ubuntu + macOS jobs),
the empty package tree from §4.1, and a `cli.py` that only handles `--version`.

Done when:
- `uv sync` then the full check in `CLAUDE.md` passes locally.
- CI runs on push and pull request and is green on both jobs.
- `uv run phone-mouse --version` prints the version.

### - [x] T1 — Protocol, fake driver, session, app · Opus 5.5 (high)

Depends on: T0.

Build: `protocol.py`, `input/base.py`, `input/fake.py`, `input/__init__.py`, `session.py`,
`app.py`, `pairing.py`, `net.py`, and the real `cli.py` (§4.2–4.4). Serve a placeholder
`index.html`.

Done when (each has a test):
- Every message in §3 parses; every limit in §3 rejects out-of-range values and unknown fields.
- Valid `hello` → `ready`. Wrong token, wrong version, no `hello` in 3 s, bad Origin → close 4003.
- Second authenticated connection closes the first with 4001.
- 241 frames in one second → close 4008. Invalid frame → close 4400.
- Each message type calls the matching `FakeDriver` method with the right arguments.
- Two clicks 100 ms apart → counts 1 then 2; 400 ms apart → 1 then 1.
- Any disconnect calls `release_all()`.
- The token never appears in log output (test captures logs).
- `uv run phone-mouse --dry-run` starts, prints URL + QR code, and `/healthz` returns 200.

### - [x] T2 — macOS driver · Opus 5.5 (high) · run on the Mac if possible

Depends on: T1.

Build: `input/macos.py` per §4.6, wired into `create_driver`. The package must still import on
Linux.

Done when:
- macOS CI job: the driver constructs, and pure helpers (clamping to display bounds, text
  chunking, key-code and modifier mapping) are unit-tested.
- Ubuntu CI job still passes; `create_driver(dry_run=False)` on Linux raises a clear error.
- PR contains this manual checklist for the human, to run with `phone-mouse` plus a tiny script
  or `websocat`: cursor moves and stops at screen edges; single, double and right click work;
  drag moves a Finder window; scroll works in both axes; missing permission prints the warning.

### - [x] T3 — Gestures and acceleration · Opus 5.5 (high)

Depends on: T1.

Build: `js/gestures.js`, `js/accel.js`, `js/protocol.js` per §4.5, with vitest tests in
`tests/client/`. No DOM code in these files.

Done when (each has a test):
- Every row of the gesture table in §4.5 produces exactly the listed actions.
- A slow one-finger move over 10 px is a move, not a tap. A long press is not a tap.
- Lifting one of two fingers mid-scroll does not produce a click or a cursor jump.
- Tap-then-drag sends `button down` once and always sends `button up` on lift or touch-cancel.
- `accel` returns `sensitivity × 1` at speed 0 and never exceeds `sensitivity × 4`.

### - [x] T4 — Client page and connection · Sonnet 5.5

Depends on: T1 (uses only §3; integrate with T3 when it merges — whichever lands second wires
`main.js`).

Build: `index.html`, `styles.css`, `js/connection.js`, `js/settings.js`, `js/main.js`,
`manifest.webmanifest`, icons (§4.5): trackpad surface, left/right buttons, status dot, settings
sheet (sensitivity slider, natural-scroll toggle), per-frame batching, reconnect with backoff.

Done when:
- vitest covers: token read from hash then stripped; reconnect/backoff decisions for each close
  code in §3; batching sends at most one `move` per frame and keeps the remainder; settings
  persist.
- A Playwright (Chromium, phone viewport) smoke test against `phone-mouse --dry-run` connects,
  shows "connected", and a synthetic drag reaches the `FakeDriver`.
- Manual checklist in PR for the human on a real iPhone: no page zoom/scroll/bounce, no text
  selection, safe areas respected, reconnects after locking and unlocking the phone.

### - [x] T5 — Keyboard and media keys · Sonnet 5.5

Depends on: T2, T3, T4.

Build: a keyboard panel (text field that sends `text`, plus buttons for the `key` values) and a
media panel (the six `media` keys). Server side already dispatches these (T1) and the driver
implements them (T2); fix gaps only.

Done when:
- vitest covers the messages each control sends, including text longer than 256 characters being
  split into several `text` messages.
- Manual checklist in PR: typing appears in a Mac text field including emoji and accents;
  backspace/enter/arrows work; volume and play/pause work.

### - [ ] T6 — README and run instructions · Sonnet 5.5

Depends on: T5.

Build: `README.md` with: what it is, one-command install and start, the accessibility-permission
and firewall prompts with exact menu paths, pairing steps, "Add to Home Screen", gesture table,
troubleshooting (phone cannot reach the Mac, cursor does not move, guest/isolated Wi-Fi), security
model in plain words, and a development section (the full check, layout, how to add a gesture).

Done when: a person who has never seen the project can go from clone to moving the cursor using
only the README; every command in it was actually run.

### - [ ] T7 — Final review · Fable 5.2 (high) · fresh session

Depends on: T6.

Do: read the whole codebase against this plan. Run `/security-review` and `/code-review high`.
Check specifically: token handling and logging, Origin check, bind address, clamping, rate limit,
held-button release on every exit path, layering rules in `CLAUDE.md`, and that tests assert
behaviour rather than implementation. Fix what is clearly wrong in a PR; list judgment calls as
issues.

Done when: review findings are fixed or filed, and the full check is green.

### Later (not v1)

HTTPS with a local certificate (`mkcert`; needs a root certificate installed on the iPhone) so the
token is encrypted on the Wi-Fi; a menu-bar app so no terminal is needed; three-finger gestures.

## 7. Prompts

To review a task's PR, paste this into a fresh session (never the one that wrote it):

```
Read CLAUDE.md and PLAN.md in full. Review the pull request for task T<n> by following
"Review gate" in PLAN.md §6. Do not change code. Post your findings with severities and end with
one line: PASS or FAIL.
```

To start a task:

Paste this into a fresh Claude Code session opened in the repo, with the model from §5 selected:

```
Read CLAUDE.md and PLAN.md in full. Then do task T<n> from PLAN.md §6 and nothing else.
Follow "How to work" in CLAUDE.md exactly. When the full check passes, open the pull request.
If anything in the plan is impossible or contradictory, stop and explain instead of improvising.
```
