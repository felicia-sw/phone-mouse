"""End-to-end WebSocket behaviour through the real FastAPI app, with a fake driver and clock."""

import contextlib
import logging
import threading
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketTestSession
from starlette.websockets import WebSocketDisconnect

from phone_mouse.app import create_app
from phone_mouse.input.fake import Call, FakeDriver
from phone_mouse.session import SessionSettings

TOKEN = "correct-token-0123456789abcdefghijklmnop"
SAME_ORIGIN = {"origin": "http://testserver"}


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture
def driver() -> FakeDriver:
    return FakeDriver()


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def client(driver: FakeDriver, clock: FakeClock) -> Iterator[TestClient]:
    settings = SessionSettings(token=TOKEN, hello_timeout=0.2, clock=clock)
    with TestClient(create_app(settings, driver)) as test_client:
        yield test_client


def connect(client: TestClient, headers: dict[str, str] | None = None) -> WebSocketTestSession:
    return client.websocket_connect("/ws", headers=SAME_ORIGIN if headers is None else headers)


def hello(ws: WebSocketTestSession, **overrides: Any) -> None:
    ws.send_json({"t": "hello", "v": 1, "token": TOKEN, **overrides})


def authenticate(ws: WebSocketTestSession) -> None:
    hello(ws)
    assert ws.receive_json() == {"t": "ready", "v": 1}


def sync(ws: WebSocketTestSession) -> None:
    """Round-trip a ping so every earlier frame has been handled by the server."""
    ws.send_json({"t": "ping", "id": 99})
    assert ws.receive_json() == {"t": "pong", "id": 99}


SENTINEL_PING = {"t": "ping", "id": 424242}
SENTINEL_PONG = {"t": "pong", "id": 424242}


def expect_close(ws: WebSocketTestSession, code: int) -> None:
    """Expect the server to close with `code` before it answers a sentinel ping.

    The sentinel makes a missing close fail the test instead of blocking forever.
    """
    ws.send_json(SENTINEL_PING)
    with pytest.raises(WebSocketDisconnect) as exc_info:
        while True:
            assert ws.receive_json() != SENTINEL_PONG, "server answered instead of closing"
    assert exc_info.value.code == code


def wait_for_close(ws: WebSocketTestSession, code: int, timeout: float = 5.0) -> None:
    """For cases where sending anything would change the outcome.

    The receive runs on a helper thread so a missing close fails after `timeout`
    instead of blocking the test run forever.
    """
    outcome: list[object] = []

    def receive() -> None:
        try:
            outcome.append(ws.receive_json())
        except WebSocketDisconnect as exc:
            outcome.append(exc)

    waiter = threading.Thread(target=receive, daemon=True)
    waiter.start()
    waiter.join(timeout)
    assert outcome, f"server did not close within {timeout} s"
    assert isinstance(outcome[0], WebSocketDisconnect), f"expected a close, got {outcome[0]!r}"
    assert outcome[0].code == code


def driver_calls(driver: FakeDriver, name: str) -> list[Call]:
    return [call for call in driver.calls if call.name == name]


# Pages


def test_index_and_health_endpoints(client: TestClient) -> None:
    index = client.get("/")
    assert index.status_code == 200
    assert "text/html" in index.headers["content-type"]
    assert client.get("/healthz").json() == {"status": "ok"}
    assert client.get("/static/js/main.js").status_code == 200


def test_api_docs_are_not_exposed(client: TestClient) -> None:
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404


# Authentication


def test_valid_hello_gets_ready(client: TestClient) -> None:
    with connect(client) as ws:
        authenticate(ws)
        sync(ws)


@pytest.mark.parametrize(
    "first_frame",
    [
        {"t": "hello", "v": 1, "token": "wrong-token"},
        {"t": "hello", "v": 1, "token": ""},
        {"t": "hello", "v": 2, "token": TOKEN},
        {"t": "hello", "v": 1, "token": TOKEN, "extra": 1},
        {"t": "ping", "id": 1},
        {"t": "move", "dx": 1, "dy": 1},
    ],
)
def test_bad_first_frame_closes_4003(
    client: TestClient, driver: FakeDriver, first_frame: dict[str, Any]
) -> None:
    with connect(client) as ws:
        ws.send_json(first_frame)
        expect_close(ws, 4003)
    assert driver.calls == []


def test_non_ascii_token_is_rejected_not_crashed(client: TestClient) -> None:
    with connect(client) as ws:
        hello(ws, token="ünïcode")
        expect_close(ws, 4003)


def test_invalid_json_first_frame_closes_4003(client: TestClient) -> None:
    with connect(client) as ws:
        ws.send_text("{nope")
        expect_close(ws, 4003)


def test_no_hello_in_time_closes_4003(client: TestClient) -> None:
    with connect(client) as ws:
        wait_for_close(ws, 4003)  # hello_timeout is 0.2 s in these tests


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"origin": "http://evil.example"},
        {"origin": "http://testserver:9999"},
        {"origin": "null"},
    ],
)
def test_bad_origin_is_rejected_4003(client: TestClient, headers: dict[str, str]) -> None:
    with pytest.raises(WebSocketDisconnect) as exc_info, connect(client, headers):
        pass
    assert exc_info.value.code == 4003


# One phone at a time


def test_second_connection_replaces_the_first(client: TestClient, driver: FakeDriver) -> None:
    with connect(client) as first:
        authenticate(first)
        with connect(client) as second:
            authenticate(second)
            expect_close(first, 4001)
            assert driver.calls == [Call("release_all", ())]  # released on takeover
            second.send_json({"t": "move", "dx": 1, "dy": 1})
            sync(second)
    assert driver.calls[1] == Call("move", (1.0, 1.0))


def test_replaced_connection_cannot_reach_the_driver(
    client: TestClient, driver: FakeDriver
) -> None:
    with contextlib.ExitStack() as first_stack:
        first = first_stack.enter_context(connect(client))
        authenticate(first)
        with connect(client) as second:
            authenticate(second)
            wait_for_close(first, 4001)  # already queued: takeover closes it before "ready"
            first.send_json({"t": "move", "dx": 7, "dy": 7})  # a frame still in flight
            first_stack.close()  # returns once the old handler has finished
            sync(second)
    assert Call("move", (7.0, 7.0)) not in driver.calls


def test_unauthenticated_connection_does_not_disturb_the_active_one(
    client: TestClient, driver: FakeDriver
) -> None:
    with connect(client) as phone:
        authenticate(phone)
        phone.send_json({"t": "button", "b": "left", "a": "down"})
        sync(phone)
        with connect(client) as intruder:
            hello(intruder, token="wrong")
            expect_close(intruder, 4003)
        sync(phone)
        assert driver_calls(driver, "release_all") == []


# Rate limit and invalid frames


def test_241_frames_in_one_second_closes_4008(client: TestClient, clock: FakeClock) -> None:
    with connect(client) as ws:
        authenticate(ws)
        for _ in range(239):
            ws.send_json({"t": "move", "dx": 1, "dy": 0})
        sync(ws)  # frame 240 is still allowed
        ws.send_json({"t": "move", "dx": 1, "dy": 0})
        expect_close(ws, 4008)


def test_rate_limit_window_slides(client: TestClient, clock: FakeClock) -> None:
    with connect(client) as ws:
        authenticate(ws)
        for _ in range(239):
            ws.send_json({"t": "move", "dx": 1, "dy": 0})
        sync(ws)
        clock.advance(1.0)
        for _ in range(239):
            ws.send_json({"t": "move", "dx": 1, "dy": 0})
        sync(ws)


@pytest.mark.parametrize(
    "send",
    [
        lambda ws: ws.send_text("{nope"),
        lambda ws: ws.send_bytes(b'{"t":"ping","id":1}'),
        lambda ws: ws.send_json({"t": "move", "dx": 501, "dy": 0}),
        lambda ws: ws.send_json({"t": "teleport"}),
        lambda ws: ws.send_json({"t": "hello", "v": 1, "token": TOKEN}),
    ],
)
def test_invalid_frame_closes_4400(client: TestClient, send: Any) -> None:
    with connect(client) as ws:
        authenticate(ws)
        send(ws)
        expect_close(ws, 4400)


# Dispatch


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        ({"t": "move", "dx": 3, "dy": -4.5}, Call("move", (3.0, -4.5))),
        ({"t": "click", "b": "left"}, Call("click", ("left", 1))),
        ({"t": "click", "b": "right"}, Call("click", ("right", 1))),
        ({"t": "button", "b": "left", "a": "down"}, Call("button", ("left", True))),
        ({"t": "button", "b": "left", "a": "up"}, Call("button", ("left", False))),
        ({"t": "scroll", "dx": 0, "dy": -20}, Call("scroll", (0.0, -20.0))),
        ({"t": "text", "s": "hi there"}, Call("type_text", ("hi there",))),
        ({"t": "key", "k": "enter"}, Call("key", ("enter", frozenset()))),
        (
            {"t": "key", "k": "left", "mods": ["cmd", "shift", "cmd"]},
            Call("key", ("left", frozenset({"cmd", "shift"}))),
        ),
        ({"t": "media", "k": "playpause"}, Call("media", ("playpause",))),
    ],
)
def test_each_message_calls_the_driver(
    client: TestClient, driver: FakeDriver, message: dict[str, Any], expected: Call
) -> None:
    with connect(client) as ws:
        authenticate(ws)
        ws.send_json(message)
        sync(ws)
        assert driver.calls == [expected]


def test_ping_gets_pong_and_does_not_touch_the_driver(
    client: TestClient, driver: FakeDriver
) -> None:
    with connect(client) as ws:
        authenticate(ws)
        sync(ws)
        assert driver.calls == []


@pytest.mark.parametrize(("gap", "counts"), [(0.1, [1, 2]), (0.4, [1, 1])])
def test_double_click_detection(
    client: TestClient, driver: FakeDriver, clock: FakeClock, gap: float, counts: list[int]
) -> None:
    with connect(client) as ws:
        authenticate(ws)
        ws.send_json({"t": "click", "b": "left"})
        sync(ws)
        clock.advance(gap)
        ws.send_json({"t": "click", "b": "left"})
        sync(ws)
    assert [call.args[1] for call in driver_calls(driver, "click")] == counts


# Cleanup


@pytest.mark.parametrize(
    ("end", "code"),
    [
        (lambda ws: ws.close(), None),
        (lambda ws: ws.send_text("{nope"), 4400),
        (lambda ws: [ws.send_json({"t": "ping", "id": i}) for i in range(241)], 4008),
    ],
)
def test_every_disconnect_releases_held_buttons(
    client: TestClient, driver: FakeDriver, end: Any, code: int | None
) -> None:
    with connect(client) as ws:
        authenticate(ws)
        ws.send_json({"t": "button", "b": "left", "a": "down"})
        sync(ws)
        end(ws)
        if code is not None:
            expect_close(ws, code)  # skips the pongs sent before the close
    assert driver.calls == [Call("button", ("left", True)), Call("release_all", ())]


# Logging


def test_token_never_appears_in_logs(client: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    with connect(client) as ws:
        authenticate(ws)
        ws.send_json({"t": "text", "s": "typed"})
        sync(ws)
    with connect(client) as ws:
        hello(ws, extra=TOKEN, **{TOKEN: TOKEN})
        expect_close(ws, 4003)
    with connect(client) as ws:
        authenticate(ws)
        ws.send_json({"t": "move", "dx": TOKEN, "dy": 0})
        expect_close(ws, 4400)
    with connect(client) as ws:
        hello(ws, token=TOKEN[:-1])
        expect_close(ws, 4003)

    assert caplog.records, "expected the session to log something"
    assert TOKEN not in caplog.text
    assert TOKEN[:-1] not in caplog.text
    assert "typed" not in caplog.text
