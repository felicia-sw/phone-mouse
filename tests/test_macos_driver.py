"""QuartzDriver tests.

Most tests run everywhere against FakeQuartz, which records the events the driver posts.
The macOS-only tests at the end check that every name and value FakeQuartz provides exists
in the real pyobjc modules, so the fake cannot drift from what the driver needs.
"""

import logging
import platform
import sys
from types import SimpleNamespace
from typing import Any

import pytest

from phone_mouse import input as input_package
from phone_mouse.input import macos
from phone_mouse.input.macos import (
    MEDIA_KEY_TYPES,
    MODIFIER_FLAGS,
    QuartzDriver,
    Rect,
    ScrollAccumulator,
    clamp_to_displays,
    media_event_data1,
    modifier_flags,
    split_utf16,
)

Event = dict[str, Any]


class FakeQuartz:
    """Records posted events. Constant values must match pyobjc (checked on macOS)."""

    kCGEventLeftMouseDown = 1
    kCGEventLeftMouseUp = 2
    kCGEventRightMouseDown = 3
    kCGEventRightMouseUp = 4
    kCGEventMouseMoved = 5
    kCGEventLeftMouseDragged = 6
    kCGMouseButtonLeft = 0
    kCGMouseButtonRight = 1
    kCGMouseEventClickState = 1
    kCGMouseEventDeltaX = 4
    kCGMouseEventDeltaY = 5
    kCGHIDEventTap = 0
    kCGScrollEventUnitPixel = 0

    def __init__(
        self,
        cursor: tuple[float, float] = (100.0, 100.0),
        displays: tuple[Rect, ...] = (Rect(0, 0, 1440, 900),),
        permission: bool = True,
    ) -> None:
        self.cursor = cursor
        self.displays = displays
        self.permission = permission
        self.permission_requested = False
        self.posted: list[Event] = []

    def CGEventCreate(self, source: None) -> Event:
        return {"kind": "null"}

    def CGEventGetLocation(self, event: Event) -> SimpleNamespace:
        return SimpleNamespace(x=self.cursor[0], y=self.cursor[1])

    def CGEventCreateMouseEvent(
        self, source: None, event_type: int, position: tuple[float, float], button: int
    ) -> Event:
        return {
            "kind": "mouse",
            "type": event_type,
            "pos": position,
            "button": button,
            "fields": {},
        }

    def CGEventSetIntegerValueField(self, event: Event, field: int, value: int) -> None:
        assert isinstance(value, int)
        event["fields"][field] = value

    def CGEventCreateScrollWheelEvent2(
        self, source: None, units: int, wheel_count: int, wheel1: int, wheel2: int, wheel3: int
    ) -> Event:
        assert all(isinstance(w, int) for w in (wheel1, wheel2, wheel3))
        return {"kind": "scroll", "units": units, "count": wheel_count, "wheels": (wheel1, wheel2)}

    def CGEventCreateKeyboardEvent(self, source: None, key_code: int, down: bool) -> Event:
        return {"kind": "key", "code": key_code, "down": down, "flags": None, "text": None}

    def CGEventKeyboardSetUnicodeString(self, event: Event, length: int, text: str) -> None:
        assert length == len(text)
        event["text"] = text

    def CGEventSetFlags(self, event: Event, flags: int) -> None:
        event["flags"] = flags

    def CGGetActiveDisplayList(
        self, max_displays: int, displays: None, count: None
    ) -> tuple[int, tuple[int, ...], int]:
        ids = tuple(range(len(self.displays)))
        return (0, ids, len(ids))

    def CGDisplayBounds(self, display_id: int) -> SimpleNamespace:
        rect = self.displays[display_id]
        return SimpleNamespace(
            origin=SimpleNamespace(x=rect.x, y=rect.y),
            size=SimpleNamespace(width=rect.width, height=rect.height),
        )

    def CGPreflightPostEventAccess(self) -> bool:
        return self.permission

    def CGRequestPostEventAccess(self) -> bool:
        self.permission_requested = True
        return self.permission

    def CGEventPost(self, tap: int, event: Event) -> None:
        assert tap == self.kCGHIDEventTap
        self.posted.append(event)
        if event["kind"] == "mouse" and event["type"] in (
            self.kCGEventMouseMoved,
            self.kCGEventLeftMouseDragged,
        ):
            self.cursor = event["pos"]  # the window server moves the cursor


class FakeNSEvent:
    @staticmethod
    def otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2_(  # noqa: E501, N802
        event_type: int,
        location: tuple[float, float],
        flags: int,
        timestamp: float,
        window: int,
        context: None,
        subtype: int,
        data1: int,
        data2: int,
    ) -> SimpleNamespace:
        event = {
            "kind": "system",
            "type": event_type,
            "flags": flags,
            "subtype": subtype,
            "data1": data1,
            "data2": data2,
        }
        return SimpleNamespace(CGEvent=lambda: event)


@pytest.fixture
def quartz() -> FakeQuartz:
    return FakeQuartz()


@pytest.fixture
def driver(quartz: FakeQuartz) -> QuartzDriver:
    return QuartzDriver(quartz=quartz, nsevent=FakeNSEvent)


# Pure helpers


def test_clamp_keeps_points_that_are_on_a_display() -> None:
    assert clamp_to_displays(10, 20, [Rect(0, 0, 100, 100)]) == (10, 20)


def test_clamp_stops_at_the_screen_edges() -> None:
    screen = [Rect(0, 0, 1440, 900)]
    assert clamp_to_displays(5000, -40, screen) == (1439, 0)
    assert clamp_to_displays(-3, 950, screen) == (0, 899)


def test_clamp_moves_into_the_nearest_of_several_displays() -> None:
    # A laptop with a taller external monitor to its left (negative x).
    displays = [Rect(0, 0, 1440, 900), Rect(-1920, -180, 1920, 1080)]
    assert clamp_to_displays(-100, -150, displays) == (-100, -150)  # on the external one
    assert clamp_to_displays(200, -150, displays) == (200, 0)  # above the laptop
    assert clamp_to_displays(-2500, 2000, displays) == (-1920, 899)


def test_clamp_without_display_information_changes_nothing() -> None:
    assert clamp_to_displays(5, 6, []) == (5, 6)


def test_split_utf16_respects_the_chunk_size() -> None:
    assert [len(c) for c in split_utf16("x" * 45)] == [20, 20, 5]


def test_split_utf16_never_splits_a_surrogate_pair() -> None:
    chunks = split_utf16("x" * 19 + "😀" + "y")
    assert [len(c) for c in chunks] == [19, 3]
    joined = "".join(chunks).encode("utf-16-le", "surrogatepass").decode("utf-16-le")
    assert joined == "x" * 19 + "😀" + "y"


def test_split_utf16_keeps_accents_and_empty_input() -> None:
    assert split_utf16("café") == ["café"]
    assert split_utf16("") == []


def test_modifier_flags_combine() -> None:
    assert modifier_flags(frozenset()) == 0
    assert modifier_flags(frozenset({"cmd", "shift"})) == 0x100000 | 0x20000


def test_media_event_data1_layout() -> None:
    assert media_event_data1(16, 10) == 0x100A00  # play, key down
    assert media_event_data1(0, 11) == 0x000B00  # volume up, key up


def test_scroll_accumulator_carries_fractions() -> None:
    scroll = ScrollAccumulator()
    assert [scroll.add(0.4, -0.6) for _ in range(3)] == [(0, 0), (0, -1), (1, 0)]


# Driver behaviour


def test_move_posts_a_mouse_moved_event_at_the_new_position(
    driver: QuartzDriver, quartz: FakeQuartz
) -> None:
    driver.move(5, -3)
    (event,) = quartz.posted
    assert event["type"] == quartz.kCGEventMouseMoved
    assert event["pos"] == (105.0, 97.0)
    assert event["fields"] == {quartz.kCGMouseEventDeltaX: 5, quartz.kCGMouseEventDeltaY: -3}


def test_move_is_clamped_to_the_screen(driver: QuartzDriver, quartz: FakeQuartz) -> None:
    driver.move(-500, 500)
    driver.move(-500, 500)
    assert quartz.posted[-1]["pos"] == (0, 899)


def test_move_while_left_is_held_posts_drag_events(
    driver: QuartzDriver, quartz: FakeQuartz
) -> None:
    driver.button("left", down=True)
    driver.move(10, 0)
    driver.button("left", down=False)
    driver.move(10, 0)
    types = [event["type"] for event in quartz.posted]
    assert types == [
        quartz.kCGEventLeftMouseDown,
        quartz.kCGEventLeftMouseDragged,
        quartz.kCGEventLeftMouseUp,
        quartz.kCGEventMouseMoved,
    ]


@pytest.mark.parametrize(
    ("button", "down_type", "up_type", "quartz_button"),
    [("left", 1, 2, 0), ("right", 3, 4, 1)],
)
@pytest.mark.parametrize("count", [1, 2, 3])
def test_click_posts_down_and_up_with_the_click_count(
    driver: QuartzDriver,
    quartz: FakeQuartz,
    button: Any,
    down_type: int,
    up_type: int,
    quartz_button: int,
    count: int,
) -> None:
    driver.click(button, count)
    assert [(e["type"], e["button"], e["pos"]) for e in quartz.posted] == [
        (down_type, quartz_button, (100.0, 100.0)),
        (up_type, quartz_button, (100.0, 100.0)),
    ]
    assert all(e["fields"] == {quartz.kCGMouseEventClickState: count} for e in quartz.posted)


def test_repeated_button_down_is_sent_once(driver: QuartzDriver, quartz: FakeQuartz) -> None:
    driver.button("left", down=True)
    driver.button("left", down=True)
    driver.button("left", down=False)
    driver.button("left", down=False)
    assert len(quartz.posted) == 2


def test_release_all_releases_a_held_button(driver: QuartzDriver, quartz: FakeQuartz) -> None:
    driver.release_all()
    assert quartz.posted == []
    driver.button("left", down=True)
    driver.release_all()
    driver.release_all()
    assert [e["type"] for e in quartz.posted] == [
        quartz.kCGEventLeftMouseDown,
        quartz.kCGEventLeftMouseUp,
    ]


def test_scroll_uses_pixel_units_with_vertical_first(
    driver: QuartzDriver, quartz: FakeQuartz
) -> None:
    driver.scroll(3, -12)
    (event,) = quartz.posted
    assert event == {
        "kind": "scroll",
        "units": quartz.kCGScrollEventUnitPixel,
        "count": 2,
        "wheels": (-12, 3),
    }


def test_tiny_scrolls_accumulate_before_posting(driver: QuartzDriver, quartz: FakeQuartz) -> None:
    driver.scroll(0, 0.5)
    assert quartz.posted == []
    driver.scroll(0, 0.5)
    assert quartz.posted[0]["wheels"] == (1, 0)


def test_type_text_sends_chunks_as_unicode_key_events(
    driver: QuartzDriver, quartz: FakeQuartz
) -> None:
    text = "héllo wörld, this is longer than twenty units 😀"
    driver.type_text(text)
    downs = [e for e in quartz.posted if e["down"]]
    ups = [e for e in quartz.posted if not e["down"]]
    assert len(downs) == len(ups) == len(split_utf16(text))
    assert [e["text"] for e in downs] == [e["text"] for e in ups] == split_utf16(text)
    assert all(e["kind"] == "key" and e["code"] == 0 for e in quartz.posted)


@pytest.mark.parametrize("key", list(macos.KEY_CODES))
def test_key_posts_down_and_up_with_modifier_flags(
    driver: QuartzDriver, quartz: FakeQuartz, key: Any
) -> None:
    driver.key(key, frozenset({"cmd", "alt"}))
    expected_flags = MODIFIER_FLAGS["cmd"] | MODIFIER_FLAGS["alt"]
    assert [(e["code"], e["down"], e["flags"]) for e in quartz.posted] == [
        (macos.KEY_CODES[key], True, expected_flags),
        (macos.KEY_CODES[key], False, expected_flags),
    ]


@pytest.mark.parametrize("key", list(MEDIA_KEY_TYPES))
def test_media_posts_system_defined_down_and_up(
    driver: QuartzDriver, quartz: FakeQuartz, key: Any
) -> None:
    driver.media(key)
    key_type = MEDIA_KEY_TYPES[key]
    assert quartz.posted == [
        {
            "kind": "system",
            "type": 14,
            "flags": state << 8,
            "subtype": 8,
            "data1": (key_type << 16) | (state << 8),
            "data2": -1,
        }
        for state in (10, 11)
    ]


# Permission and factory


@pytest.mark.parametrize("granted", [True, False])
def test_create_quartz_driver_requests_permission_only_when_missing(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, granted: bool
) -> None:
    quartz = FakeQuartz(permission=granted)
    monkeypatch.setattr(macos, "QuartzDriver", lambda: QuartzDriver(quartz, FakeNSEvent))
    caplog.set_level(logging.WARNING)

    macos.create_quartz_driver()

    assert quartz.permission_requested is (not granted)
    assert ("Accessibility" in caplog.text) is (not granted)


def test_create_driver_on_macos_uses_the_quartz_driver(monkeypatch: pytest.MonkeyPatch) -> None:
    sentinel = QuartzDriver(FakeQuartz(), FakeNSEvent)
    monkeypatch.setattr(platform, "system", lambda: "Darwin")
    monkeypatch.setattr(macos, "create_quartz_driver", lambda: sentinel)
    assert input_package.create_driver(dry_run=False) is sentinel


def test_create_driver_elsewhere_explains_dry_run(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    with pytest.raises(
        input_package.DriverUnavailableError, match="only control the cursor on macOS"
    ):
        input_package.create_driver(dry_run=False)


def test_module_does_not_import_quartz_at_import_time() -> None:
    assert "Quartz" not in vars(macos)
    assert "AppKit" not in vars(macos)


# Real pyobjc (macOS only)

on_macos = pytest.mark.skipif(sys.platform != "darwin", reason="needs pyobjc on macOS")

FAKE_QUARTZ_NAMES = sorted(name for name in vars(FakeQuartz) if name.startswith(("CG", "kCG")))


@on_macos
@pytest.mark.parametrize("name", FAKE_QUARTZ_NAMES)
def test_every_quartz_name_the_driver_uses_exists(name: str) -> None:
    import Quartz

    assert hasattr(Quartz, name)
    fake_value = vars(FakeQuartz)[name]
    if isinstance(fake_value, int):
        assert getattr(Quartz, name) == fake_value


@on_macos
def test_hard_coded_constants_match_the_frameworks() -> None:
    import AppKit
    import Quartz

    assert {
        "cmd": Quartz.kCGEventFlagMaskCommand,
        "shift": Quartz.kCGEventFlagMaskShift,
        "alt": Quartz.kCGEventFlagMaskAlternate,
        "ctrl": Quartz.kCGEventFlagMaskControl,
    } == MODIFIER_FLAGS
    assert AppKit.NSEventTypeSystemDefined == macos.NS_EVENT_TYPE_SYSTEM_DEFINED
    assert hasattr(
        AppKit.NSEvent,
        "otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2_",
    )


@on_macos
def test_real_driver_constructs_and_reads_the_screen() -> None:
    driver = QuartzDriver()
    assert driver._cursor() is not None
    assert isinstance(driver.has_permission(), bool)
