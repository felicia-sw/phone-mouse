# phone-mouse — rules for every agent

Use an iPhone as a trackpad for a Mac. A Python server on the Mac serves a web page; the phone
opens it in Safari and sends touch gestures over a WebSocket; the server moves the real cursor.

**Read `PLAN.md` before doing anything.** It is the single source of truth: architecture, the wire
protocol, and the task list. Do exactly one task per session.

## How to work

1. Pick the task you were given (`T0`…`T7`) in `PLAN.md`. Check its "Depends on" tasks are merged.
2. Branch from `main`: `git checkout -b <task-id>-<short-name>` (e.g. `t1-protocol-session`).
3. Build only what the task lists. Anything else goes in the PR description under "Follow-ups".
4. Run the full check (below). It must pass before you commit.
5. Open one PR per task. Title: `T<n>: <task title>`. The body must contain: each "Done when"
   line with pass/fail and the test that proves it, the list of changed paths, the commands you
   ran with their output, and any manual checklist for the human.
6. Tick the task's checkbox in `PLAN.md` in the same PR.
7. Stay inside the task's file scope (`PLAN.md` §6). Do not merge your own PR: a fresh session
   reviews it under the "Review gate" in `PLAN.md` §6.

## The full check

```bash
uv run ruff format --check . && uv run ruff check . && uv run mypy && uv run pytest
npm run check   # tsc --noEmit + vitest + prettier --check
```

## Hard rules

- **The protocol in `PLAN.md` §3 is frozen.** Do not add, rename or loosen a message. If a task
  cannot be done without a protocol change, stop and say so in the PR instead of changing it.
- **Layering:** `protocol` knows nothing about sockets or the OS. `session` talks to the driver
  only through the `InputDriver` interface. Only `input/macos.py` may import `Quartz` or `AppKit`,
  and only inside functions or behind a platform check, so the package imports cleanly on Linux.
- **Security is not optional.** Never weaken token auth, the Origin check, input clamping or the
  rate limit to make a test pass. Never log the token. Never bind to `0.0.0.0` by default.
- **No new dependencies** beyond those listed in `PLAN.md` §2 without stating why in the PR.
- **Tests come with the code.** Every behaviour in a task's acceptance criteria has a test. Never
  skip, delete or weaken a test to get green.
- **macOS APIs:** look up each Quartz/AppKit call in current documentation before using it. Do not
  write these from memory. You usually cannot run them (CI and cloud sessions are Linux), so keep
  the driver thin and list a manual test checklist in the PR for the human to run on the Mac.
- Python: type hints everywhere, `mypy --strict` clean, no bare `except`, no `print` outside
  `cli.py` and `pairing.py` (use `logging`).
- Client: plain ES modules with JSDoc types, checked by `tsc`. No framework, no bundler, no CDN.
- Small functions, clear names, comments only where the *why* is not obvious.
