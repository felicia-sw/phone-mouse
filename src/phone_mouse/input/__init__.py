"""Input drivers: the InputDriver interface, a fake, and the macOS implementation."""

import platform

from phone_mouse.input.base import InputDriver
from phone_mouse.input.fake import FakeDriver

__all__ = ["DriverUnavailableError", "InputDriver", "create_driver"]


class DriverUnavailableError(RuntimeError):
    """No real input driver can run on this machine."""


def create_driver(dry_run: bool) -> InputDriver:
    if dry_run:
        return FakeDriver()
    # platform.system() rather than sys.platform so mypy still checks this branch on Linux.
    if platform.system() != "Darwin":
        raise DriverUnavailableError(
            "phone-mouse can only control the cursor on macOS. "
            "Run with --dry-run to try it on this computer."
        )
    from phone_mouse.input.macos import create_quartz_driver

    return create_quartz_driver()
