"""The interface every input driver implements (PLAN.md §4.2)."""

from typing import Protocol

from phone_mouse.protocol import Button, Key, MediaKey, Mod


class InputDriver(Protocol):
    def move(self, dx: float, dy: float) -> None: ...

    def click(self, button: Button, count: int) -> None:
        """Press and release. count: 1 single, 2 double, 3 triple."""

    def button(self, button: Button, down: bool) -> None: ...

    def scroll(self, dx: float, dy: float) -> None: ...

    def type_text(self, text: str) -> None: ...

    def key(self, key: Key, mods: frozenset[Mod]) -> None: ...

    def media(self, key: MediaKey) -> None: ...

    def release_all(self) -> None:
        """Release any held button. Called whenever the phone disconnects."""
