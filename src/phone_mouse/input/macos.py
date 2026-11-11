"""macOS input driver built on Quartz event services (PLAN.md §4.6).

The helpers at module level are pure and run on any OS. Quartz and AppKit are imported only
when a QuartzDriver is created, so this module imports cleanly on Linux.

Sources for every constant below:
- Virtual key codes: HIToolbox/Events.h (kVK_*).
- Modifier flags: CoreGraphics/CGEventTypes.h (kCGEventFlagMask*).
- Media keys: IOKit/hidsystem/ev_keymap.h (NX_KEYTYPE_*) and IOLLEvent.h (NX_KEYDOWN,
  NX_KEYUP, NX_SYSDEFINED, NX_SUBTYPE_AUX_CONTROL_BUTTONS).
"""

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from phone_mouse.protocol import Button, Key, MediaKey, Mod

logger = logging.getLogger(__name__)

KEY_CODES: Final[Mapping[Key, int]] = {
    "enter": 0x24,  # kVK_Return
    "backspace": 0x33,  # kVK_Delete
    "tab": 0x30,  # kVK_Tab
    "escape": 0x35,  # kVK_Escape
    "space": 0x31,  # kVK_Space
    "up": 0x7E,  # kVK_UpArrow
    "down": 0x7D,  # kVK_DownArrow
    "left": 0x7B,  # kVK_LeftArrow
    "right": 0x7C,  # kVK_RightArrow
}

MODIFIER_FLAGS: Final[Mapping[Mod, int]] = {
    "cmd": 0x100000,  # kCGEventFlagMaskCommand
    "shift": 0x20000,  # kCGEventFlagMaskShift
    "alt": 0x80000,  # kCGEventFlagMaskAlternate
    "ctrl": 0x40000,  # kCGEventFlagMaskControl
}

MEDIA_KEY_TYPES: Final[Mapping[MediaKey, int]] = {
    "volup": 0,  # NX_KEYTYPE_SOUND_UP
    "voldown": 1,  # NX_KEYTYPE_SOUND_DOWN
    "mute": 7,  # NX_KEYTYPE_MUTE
    "playpause": 16,  # NX_KEYTYPE_PLAY
    "next": 17,  # NX_KEYTYPE_NEXT
    "prev": 18,  # NX_KEYTYPE_PREVIOUS
}

NS_EVENT_TYPE_SYSTEM_DEFINED: Final = 14  # NSEventTypeSystemDefined, equal to NX_SYSDEFINED
NX_KEYDOWN: Final = 10
NX_KEYUP: Final = 11
NX_SUBTYPE_AUX_CONTROL_BUTTONS: Final = 8

MAX_UNICODE_CHUNK: Final = 20  # UTF-16 units per keyboard event
MAX_DISPLAYS: Final = 32

PERMISSION_HELP: Final = (
    "phone-mouse cannot control the cursor yet: macOS needs your permission.\n"
    "  1. Open System Settings > Privacy & Security > Accessibility.\n"
    "  2. Turn on the app you started phone-mouse from (for example Terminal).\n"
    "  3. Quit phone-mouse with Ctrl+C and start it again."
)


@dataclass(frozen=True)
class Rect:
    x: float
    y: float
    width: float
    height: float


def clamp_to_displays(x: float, y: float, displays: Sequence[Rect]) -> tuple[float, float]:
    """The point itself if it is on a display, else the nearest point that is."""
    best: tuple[float, float] | None = None
    best_distance = float("inf")
    for display in displays:
        cx = min(max(x, display.x), display.x + display.width - 1)
        cy = min(max(y, display.y), display.y + display.height - 1)
        distance = (cx - x) ** 2 + (cy - y) ** 2
        if distance < best_distance:
            best, best_distance = (cx, cy), distance
    return best if best is not None else (x, y)


def to_utf16_units(text: str) -> str:
    """Rewrite text so each code point is one UTF-16 unit (astral characters become surrogates)."""
    data = text.encode("utf-16-le", "surrogatepass")
    return "".join(chr(int.from_bytes(data[i : i + 2], "little")) for i in range(0, len(data), 2))


def split_utf16(text: str, max_units: int = MAX_UNICODE_CHUNK) -> list[str]:
    """Split into chunks of at most max_units UTF-16 units, never inside a surrogate pair."""
    units = to_utf16_units(text)
    chunks: list[str] = []
    start = 0
    while start < len(units):
        end = min(start + max_units, len(units))
        if end < len(units) and 0xD800 <= ord(units[end - 1]) <= 0xDBFF:
            end -= 1  # keep a high surrogate with its low surrogate
        chunks.append(units[start:end])
        start = end
    return chunks


def modifier_flags(mods: frozenset[Mod]) -> int:
    flags = 0
    for mod in mods:
        flags |= MODIFIER_FLAGS[mod]
    return flags


def media_event_data1(key_type: int, state: int) -> int:
    """data1 of an NX_SYSDEFINED aux-control event: key type in bits 16+, state in bits 8-15."""
    return (key_type << 16) | (state << 8)


class ScrollAccumulator:
    """Quartz scroll deltas are integers; carry the fractional part to the next event."""

    def __init__(self) -> None:
        self._dx = 0.0
        self._dy = 0.0

    def add(self, dx: float, dy: float) -> tuple[int, int]:
        self._dx += dx
        self._dy += dy
        whole_dx, whole_dy = int(self._dx), int(self._dy)
        self._dx -= whole_dx
        self._dy -= whole_dy
        return whole_dx, whole_dy


class QuartzDriver:
    """Moves the real cursor and types on macOS.

    `quartz` and `nsevent` default to the real pyobjc modules; tests pass fakes.
    """

    def __init__(self, quartz: Any = None, nsevent: Any = None) -> None:
        if quartz is None:
            import Quartz

            quartz = Quartz
        if nsevent is None:
            from AppKit import NSEvent

            nsevent = NSEvent
        self._q = quartz
        self._nsevent = nsevent
        self._left_down = False
        self._scroll = ScrollAccumulator()

    # Permission

    def has_permission(self) -> bool:
        return bool(self._q.CGPreflightPostEventAccess())

    def request_permission(self) -> bool:
        """Ask macOS for permission (may show a system prompt). True if already granted."""
        return bool(self._q.CGRequestPostEventAccess())

    # InputDriver

    def move(self, dx: float, dy: float) -> None:
        q = self._q
        x, y = self._cursor()
        x, y = clamp_to_displays(x + dx, y + dy, self._displays())
        event_type = q.kCGEventLeftMouseDragged if self._left_down else q.kCGEventMouseMoved
        event = q.CGEventCreateMouseEvent(None, event_type, (x, y), q.kCGMouseButtonLeft)
        # Some apps (games, 3D tools) read the raw deltas instead of the position.
        q.CGEventSetIntegerValueField(event, q.kCGMouseEventDeltaX, round(dx))
        q.CGEventSetIntegerValueField(event, q.kCGMouseEventDeltaY, round(dy))
        self._post(event)

    def click(self, button: Button, count: int) -> None:
        self._mouse_button(button, down=True, count=count)
        self._mouse_button(button, down=False, count=count)

    def button(self, button: Button, down: bool) -> None:
        if button == "left":
            if down == self._left_down:
                return  # already in that state; avoid duplicate down/up events
            self._left_down = down
        self._mouse_button(button, down=down, count=1)

    def scroll(self, dx: float, dy: float) -> None:
        whole_dx, whole_dy = self._scroll.add(dx, dy)
        if whole_dx == 0 and whole_dy == 0:
            return
        q = self._q
        # wheel1 is the vertical axis and wheel2 the horizontal one (CGEventTypes.h).
        event = q.CGEventCreateScrollWheelEvent2(
            None, q.kCGScrollEventUnitPixel, 2, whole_dy, whole_dx, 0
        )
        self._post(event)

    def type_text(self, text: str) -> None:
        q = self._q
        for chunk in split_utf16(text):
            for down in (True, False):
                event = q.CGEventCreateKeyboardEvent(None, 0, down)
                q.CGEventKeyboardSetUnicodeString(event, len(chunk), chunk)
                self._post(event)

    def key(self, key: Key, mods: frozenset[Mod]) -> None:
        q = self._q
        flags = modifier_flags(mods)
        for down in (True, False):
            event = q.CGEventCreateKeyboardEvent(None, KEY_CODES[key], down)
            q.CGEventSetFlags(event, flags)
            self._post(event)

    def media(self, key: MediaKey) -> None:
        key_type = MEDIA_KEY_TYPES[key]
        for state in (NX_KEYDOWN, NX_KEYUP):
            event = self._nsevent.otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2_(  # noqa: E501
                NS_EVENT_TYPE_SYSTEM_DEFINED,
                (0, 0),
                state << 8,
                0,
                0,
                None,
                NX_SUBTYPE_AUX_CONTROL_BUTTONS,
                media_event_data1(key_type, state),
                -1,
            )
            self._post(event.CGEvent())

    def release_all(self) -> None:
        if self._left_down:
            self.button("left", down=False)

    # Helpers

    def _mouse_button(self, button: Button, down: bool, count: int) -> None:
        q = self._q
        if button == "left":
            event_type = q.kCGEventLeftMouseDown if down else q.kCGEventLeftMouseUp
            quartz_button = q.kCGMouseButtonLeft
        else:
            event_type = q.kCGEventRightMouseDown if down else q.kCGEventRightMouseUp
            quartz_button = q.kCGMouseButtonRight
        event = q.CGEventCreateMouseEvent(None, event_type, self._cursor(), quartz_button)
        q.CGEventSetIntegerValueField(event, q.kCGMouseEventClickState, count)
        self._post(event)

    def _cursor(self) -> tuple[float, float]:
        location = self._q.CGEventGetLocation(self._q.CGEventCreate(None))
        return (float(location.x), float(location.y))

    def _displays(self) -> list[Rect]:
        q = self._q
        error, display_ids, count = q.CGGetActiveDisplayList(MAX_DISPLAYS, None, None)
        if error != 0:
            logger.warning("Could not list displays (CGError %d); cursor is not clamped", error)
            return []
        rects = []
        for display_id in list(display_ids)[:count]:
            bounds = q.CGDisplayBounds(display_id)
            rects.append(
                Rect(bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height)
            )
        return rects

    def _post(self, event: Any) -> None:
        self._q.CGEventPost(self._q.kCGHIDEventTap, event)


def create_quartz_driver() -> QuartzDriver:
    """The real driver, after checking (and if needed requesting) the macOS permission."""
    driver = QuartzDriver()
    if not driver.has_permission():
        driver.request_permission()
        logger.warning(PERMISSION_HELP)
    return driver
