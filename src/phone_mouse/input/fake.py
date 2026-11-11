"""A driver that records and logs actions instead of doing them. Used by tests and --dry-run."""

import logging
from dataclasses import dataclass

from phone_mouse.protocol import Button, Key, MediaKey, Mod

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Call:
    name: str
    args: tuple[object, ...]


class FakeDriver:
    def __init__(self) -> None:
        self.calls: list[Call] = []

    def move(self, dx: float, dy: float) -> None:
        self._record("move", dx, dy)

    def click(self, button: Button, count: int) -> None:
        self._record("click", button, count)

    def button(self, button: Button, down: bool) -> None:
        self._record("button", button, down)

    def scroll(self, dx: float, dy: float) -> None:
        self._record("scroll", dx, dy)

    def type_text(self, text: str) -> None:
        self.calls.append(Call("type_text", (text,)))
        logger.info("dry-run: type_text (%d characters)", len(text))  # never log what was typed

    def key(self, key: Key, mods: frozenset[Mod]) -> None:
        self._record("key", key, mods)

    def media(self, key: MediaKey) -> None:
        self._record("media", key)

    def release_all(self) -> None:
        self._record("release_all")

    def _record(self, name: str, *args: object) -> None:
        self.calls.append(Call(name, args))
        logger.info("dry-run: %s%r", name, args)
