import json
from typing import Any

import pytest

from phone_mouse import protocol
from phone_mouse.protocol import ProtocolError, parse_message


def frame(**fields: Any) -> str:
    return json.dumps(fields)


VALID_MESSAGES: list[tuple[dict[str, Any], protocol.ClientMessage]] = [
    (
        {"t": "hello", "v": 1, "token": "abc"},
        protocol.Hello(t="hello", v=1, token="abc"),
    ),
    ({"t": "move", "dx": 4, "dy": -2.5}, protocol.Move(t="move", dx=4, dy=-2.5)),
    ({"t": "click", "b": "left"}, protocol.Click(t="click", b="left")),
    ({"t": "click", "b": "right"}, protocol.Click(t="click", b="right")),
    (
        {"t": "button", "b": "left", "a": "down"},
        protocol.ButtonPress(t="button", b="left", a="down"),
    ),
    ({"t": "button", "b": "left", "a": "up"}, protocol.ButtonPress(t="button", b="left", a="up")),
    ({"t": "scroll", "dx": 0, "dy": 12.5}, protocol.Scroll(t="scroll", dx=0, dy=12.5)),
    ({"t": "text", "s": "héllo 👋"}, protocol.Text(t="text", s="héllo 👋")),
    ({"t": "key", "k": "enter"}, protocol.KeyPress(t="key", k="enter")),
    (
        {"t": "key", "k": "left", "mods": ["cmd", "shift"]},
        protocol.KeyPress(t="key", k="left", mods=("cmd", "shift")),
    ),
    ({"t": "media", "k": "volup"}, protocol.Media(t="media", k="volup")),
    ({"t": "ping", "id": 7}, protocol.Ping(t="ping", id=7)),
]


@pytest.mark.parametrize(("fields", "expected"), VALID_MESSAGES)
def test_every_message_type_parses(
    fields: dict[str, Any], expected: protocol.ClientMessage
) -> None:
    assert parse_message(frame(**fields)) == expected


@pytest.mark.parametrize(
    "key", ["enter", "backspace", "tab", "escape", "space", "up", "down", "left", "right"]
)
def test_every_key_parses(key: str) -> None:
    assert parse_message(frame(t="key", k=key, mods=["cmd", "shift", "alt", "ctrl"]))


@pytest.mark.parametrize("key", ["playpause", "next", "prev", "volup", "voldown", "mute"])
def test_every_media_key_parses(key: str) -> None:
    assert parse_message(frame(t="media", k=key))


@pytest.mark.parametrize("kind", ["move", "scroll"])
@pytest.mark.parametrize("value", [500, -500, 499.99])
def test_deltas_at_the_limit_are_accepted(kind: str, value: float) -> None:
    assert parse_message(frame(t=kind, dx=value, dy=value))


@pytest.mark.parametrize("kind", ["move", "scroll"])
@pytest.mark.parametrize("value", [500.01, -500.01, 1e9])
@pytest.mark.parametrize("axis", ["dx", "dy"])
def test_deltas_beyond_the_limit_are_rejected(kind: str, value: float, axis: str) -> None:
    fields: dict[str, Any] = {"t": kind, "dx": 0, "dy": 0}
    fields[axis] = value
    with pytest.raises(ProtocolError):
        parse_message(frame(**fields))


def test_text_length_limits() -> None:
    assert parse_message(frame(t="text", s="x" * 256))
    with pytest.raises(ProtocolError):
        parse_message(frame(t="text", s="x" * 257))
    with pytest.raises(ProtocolError):
        parse_message(frame(t="text", s=""))


@pytest.mark.parametrize("fields", [fields for fields, _ in VALID_MESSAGES])
def test_unknown_fields_are_rejected_on_every_message(fields: dict[str, Any]) -> None:
    with pytest.raises(ProtocolError):
        parse_message(frame(**fields, extra=1))


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        "[]",
        "null",
        "{}",
        frame(t="jump"),
        frame(dx=1, dy=1),
        frame(t="move", dx=1),
        frame(t="move", dx="1", dy=0),
        frame(t="move", dx=True, dy=0),
        '{"t":"move","dx":NaN,"dy":0}',
        '{"t":"move","dx":Infinity,"dy":0}',
        frame(t="click", b="middle"),
        frame(t="button", b="right", a="down"),
        frame(t="button", b="left", a="hold"),
        frame(t="key", k="f1"),
        frame(t="key", k="enter", mods=["hyper"]),
        frame(t="key", k="enter", mods="cmd"),
        frame(t="media", k="eject"),
        frame(t="ping", id=-1),
        frame(t="ping", id=2**53),
        frame(t="ping", id=1.5),
        frame(t="hello", v="1", token="abc"),
        frame(t="hello", v=1, token="x" * 257),
        frame(t="ready", v=1),
    ],
)
def test_malformed_frames_are_rejected(raw: str) -> None:
    with pytest.raises(ProtocolError):
        parse_message(raw)


def test_binary_frames_are_rejected() -> None:
    with pytest.raises(ProtocolError):
        parse_message(b'{"t":"ping","id":1}')


def test_oversized_frames_are_rejected_before_parsing() -> None:
    with pytest.raises(ProtocolError, match="too large"):
        parse_message(" " * (protocol.MAX_FRAME_CHARS + 1))


def test_error_messages_never_echo_client_input() -> None:
    secret = "do-not-echo-this"
    with pytest.raises(ProtocolError) as exc_info:
        parse_message(frame(t="hello", v=1, token=secret, **{secret: secret}))
    assert secret not in str(exc_info.value)


def test_server_messages_serialize_as_specified() -> None:
    assert protocol.Ready().model_dump() == {"t": "ready", "v": 1}
    assert protocol.Pong(id=3).model_dump() == {"t": "pong", "id": 3}
