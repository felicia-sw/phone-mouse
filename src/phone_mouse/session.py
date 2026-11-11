"""Connection rules (PLAN.md §4.3): auth, one phone at a time, rate limit, driver dispatch."""

import asyncio
import contextlib
import logging
import secrets
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Final
from urllib.parse import urlsplit

from fastapi import WebSocket, WebSocketDisconnect

from phone_mouse import protocol
from phone_mouse.input.base import InputDriver

logger = logging.getLogger(__name__)

CLOSE_REPLACED: Final = 4001
CLOSE_UNAUTHORIZED: Final = 4003
CLOSE_RATE_LIMITED: Final = 4008
CLOSE_INVALID: Final = 4400

MAX_CLICK_COUNT: Final = 3

Clock = Callable[[], float]


@dataclass(frozen=True)
class SessionSettings:
    token: str = field(repr=False)
    hello_timeout: float = 3.0
    rate_limit: int = 240
    rate_window: float = 1.0
    multi_click_interval: float = 0.3
    clock: Clock = time.monotonic


def origin_matches_host(origin: str | None, host: str | None) -> bool:
    """True when the page that opened the socket was served by this server."""
    if not origin or not host:
        return False
    parts = urlsplit(origin)
    return parts.scheme in ("http", "https") and parts.netloc.lower() == host.lower()


class RateLimiter:
    """Allows at most `limit` events in any sliding window of `window` seconds."""

    def __init__(self, limit: int, window: float) -> None:
        self._limit = limit
        self._window = window
        self._times: deque[float] = deque()

    def allow(self, now: float) -> bool:
        self._times.append(now)
        while now - self._times[0] >= self._window:
            self._times.popleft()
        return len(self._times) <= self._limit


class ClickCounter:
    """Turns single clicks into click counts: quick repeats on one button become double/triple."""

    def __init__(self, interval: float) -> None:
        self._interval = interval
        self._last: tuple[protocol.Button, float, int] | None = None

    def register(self, button: protocol.Button, now: float) -> int:
        count = 1
        if self._last is not None:
            last_button, last_time, last_count = self._last
            if last_button == button and now - last_time <= self._interval:
                count = min(last_count + 1, MAX_CLICK_COUNT)
        self._last = (button, now, count)
        return count


class SessionManager:
    """Owns the single active phone connection and routes its messages to the driver."""

    def __init__(self, settings: SessionSettings, driver: InputDriver) -> None:
        self._settings = settings
        self._driver = driver
        self._active: WebSocket | None = None

    async def handle(self, ws: WebSocket) -> None:
        if not origin_matches_host(ws.headers.get("origin"), ws.headers.get("host")):
            logger.warning("Rejected connection: Origin does not match Host")
            await ws.close(code=CLOSE_UNAUTHORIZED)
            return
        await ws.accept()
        try:
            authenticated = await self._authenticate(ws)
        except WebSocketDisconnect:
            return
        if not authenticated:
            await _close(ws, CLOSE_UNAUTHORIZED)
            return

        await self._take_over(ws)
        try:
            await ws.send_json(protocol.Ready().model_dump())
            code = await self._serve(ws)
            if code is not None:
                await _close(ws, code)
        except WebSocketDisconnect:
            pass
        finally:
            if self._active is ws:
                self._active = None
                self._driver.release_all()
                logger.info("Phone disconnected")

    async def _authenticate(self, ws: WebSocket) -> bool:
        try:
            async with asyncio.timeout(self._settings.hello_timeout):
                raw = await _receive_frame(ws)
        except TimeoutError:
            logger.warning(
                "Rejected connection: no hello within %.1f s", self._settings.hello_timeout
            )
            return False
        try:
            message = protocol.parse_message(raw)
        except protocol.ProtocolError as exc:
            logger.warning("Rejected connection: first frame is %s", exc)
            return False
        if not isinstance(message, protocol.Hello):
            logger.warning("Rejected connection: first frame is not hello")
            return False
        if message.v != protocol.PROTOCOL_VERSION:
            logger.warning("Rejected connection: unsupported protocol version %d", message.v)
            return False
        if not secrets.compare_digest(message.token.encode(), self._settings.token.encode()):
            logger.warning("Rejected connection: wrong token")
            return False
        return True

    async def _take_over(self, ws: WebSocket) -> None:
        previous = self._active
        self._active = ws
        logger.info("Phone connected")
        if previous is not None:
            self._driver.release_all()
            logger.info("Closing the previous connection: a newer one took over")
            await _close(previous, CLOSE_REPLACED)

    async def _serve(self, ws: WebSocket) -> int | None:
        """Handle frames until one breaks a rule (returns its close code) or a newer phone takes
        over (returns None)."""
        limiter = RateLimiter(self._settings.rate_limit, self._settings.rate_window)
        clicks = ClickCounter(self._settings.multi_click_interval)
        while True:
            raw = await _receive_frame(ws)
            if self._active is not ws:
                return None  # replaced: frames still in flight must not reach the driver
            now = self._settings.clock()
            if not limiter.allow(now):
                logger.warning("Closing connection: rate limit exceeded")
                return CLOSE_RATE_LIMITED
            try:
                message = protocol.parse_message(raw)
            except protocol.ProtocolError as exc:
                logger.warning("Closing connection: %s", exc)
                return CLOSE_INVALID
            if isinstance(message, protocol.Hello):
                logger.warning("Closing connection: hello sent twice")
                return CLOSE_INVALID
            if isinstance(message, protocol.Ping):
                await ws.send_json(protocol.Pong(id=message.id).model_dump())
                continue
            self._dispatch(message, clicks, now)

    def _dispatch(self, message: protocol.ClientMessage, clicks: ClickCounter, now: float) -> None:
        driver = self._driver
        match message:
            case protocol.Move():
                driver.move(message.dx, message.dy)
            case protocol.Click():
                driver.click(message.b, clicks.register(message.b, now))
            case protocol.ButtonPress():
                driver.button(message.b, message.a == "down")
            case protocol.Scroll():
                driver.scroll(message.dx, message.dy)
            case protocol.Text():
                driver.type_text(message.s)
            case protocol.KeyPress():
                driver.key(message.k, frozenset(message.mods))
            case protocol.Media():
                driver.media(message.k)
            case protocol.Hello() | protocol.Ping():
                raise AssertionError("handled before dispatch")


async def _receive_frame(ws: WebSocket) -> str | bytes:
    message = await ws.receive()
    if message["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(message.get("code", 1000))
    text: str | None = message.get("text")
    if text is not None:
        return text
    data: bytes | None = message.get("bytes")
    return data if data is not None else b""


async def _close(ws: WebSocket, code: int) -> None:
    # Either side may already have closed the socket; then there is nothing left to do.
    with contextlib.suppress(RuntimeError, WebSocketDisconnect):
        await ws.close(code=code)
