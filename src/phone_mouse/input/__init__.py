"""Input drivers: the InputDriver interface, a fake, and the macOS implementation."""

from phone_mouse.input.base import InputDriver
from phone_mouse.input.fake import FakeDriver

__all__ = ["DriverUnavailableError", "InputDriver", "create_driver"]


class DriverUnavailableError(RuntimeError):
    """No real input driver can run on this machine."""


def create_driver(dry_run: bool) -> InputDriver:
    if dry_run:
        return FakeDriver()
    # The macOS driver arrives in task T2.
    raise DriverUnavailableError(
        "The real input driver is not available yet. Run with --dry-run to try the app."
    )
