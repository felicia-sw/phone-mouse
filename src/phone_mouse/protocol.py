"""Wire protocol v1 (PLAN.md §3): message models and parsing.

This module knows nothing about sockets or the operating system.
"""

from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

PROTOCOL_VERSION: Final = 1
MAX_DELTA: Final = 500.0
MAX_TEXT_LENGTH: Final = 256
MAX_TOKEN_LENGTH: Final = 256
MAX_PING_ID: Final = 2**53 - 1  # largest integer a JavaScript number holds exactly
# A 256-character text message is at most ~3 KiB of JSON even with every character escaped.
MAX_FRAME_CHARS: Final = 8192

Button = Literal["left", "right"]
ButtonAction = Literal["down", "up"]
Key = Literal["enter", "backspace", "tab", "escape", "space", "up", "down", "left", "right"]
Mod = Literal["cmd", "shift", "alt", "ctrl"]
MediaKey = Literal["playpause", "next", "prev", "volup", "voldown", "mute"]

Delta = Annotated[float, Field(ge=-MAX_DELTA, le=MAX_DELTA, allow_inf_nan=False)]


class ProtocolError(ValueError):
    """A frame that is not a valid protocol v1 message."""


class _Message(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


# Phone -> Mac


class Hello(_Message):
    t: Literal["hello"]
    v: int
    token: Annotated[str, Field(max_length=MAX_TOKEN_LENGTH)]


class Move(_Message):
    t: Literal["move"]
    dx: Delta
    dy: Delta


class Click(_Message):
    t: Literal["click"]
    b: Button


class ButtonPress(_Message):
    t: Literal["button"]
    b: Literal["left"]
    a: ButtonAction


class Scroll(_Message):
    t: Literal["scroll"]
    dx: Delta
    dy: Delta


class Text(_Message):
    t: Literal["text"]
    s: Annotated[str, Field(min_length=1, max_length=MAX_TEXT_LENGTH)]


class KeyPress(_Message):
    t: Literal["key"]
    k: Key
    mods: Annotated[tuple[Mod, ...], Field(max_length=4)] = ()


class Media(_Message):
    t: Literal["media"]
    k: MediaKey


class Ping(_Message):
    t: Literal["ping"]
    id: Annotated[int, Field(ge=0, le=MAX_PING_ID)]


ClientMessage = Annotated[
    Hello | Move | Click | ButtonPress | Scroll | Text | KeyPress | Media | Ping,
    Field(discriminator="t"),
]

_CLIENT_MESSAGE: TypeAdapter[ClientMessage] = TypeAdapter(ClientMessage)


# Mac -> Phone


class Ready(_Message):
    t: Literal["ready"] = "ready"
    v: int = PROTOCOL_VERSION


class Pong(_Message):
    t: Literal["pong"] = "pong"
    id: int


def parse_message(raw: str | bytes) -> ClientMessage:
    """Parse one WebSocket frame. Raises ProtocolError for anything that is not valid v1."""
    if isinstance(raw, bytes):
        raise ProtocolError("binary frames are not allowed")
    if len(raw) > MAX_FRAME_CHARS:
        raise ProtocolError("frame too large")
    try:
        return _CLIENT_MESSAGE.validate_json(raw)
    except ValidationError as exc:
        raise ProtocolError(_describe(exc)) from None


def _describe(exc: ValidationError) -> str:
    # Only error types: field names and values come from the client and may hold the token.
    types = sorted({error["type"] for error in exc.errors(include_url=False, include_input=False)})
    return "invalid message (" + ", ".join(types) + ")"
