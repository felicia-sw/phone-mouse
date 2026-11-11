"""HTTP and WebSocket routes."""

from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from phone_mouse.input.base import InputDriver
from phone_mouse.session import SessionManager, SessionSettings

STATIC_DIR = Path(__file__).parent / "static"


def create_app(settings: SessionSettings, driver: InputDriver) -> FastAPI:
    app = FastAPI(title="phone-mouse", docs_url=None, redoc_url=None, openapi_url=None)
    sessions = SessionManager(settings, driver)

    @app.get("/", include_in_schema=False)
    async def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-store"})

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.websocket("/ws")
    async def websocket(ws: WebSocket) -> None:
        await sessions.handle(ws)

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app
