"""FastAPI application. Endpoints are added in later tasks; this establishes
the app factory and /health."""

from collections.abc import Mapping

import uvicorn
from fastapi import FastAPI

from app.config import Config, load_config


def create_app(env: Mapping[str, str] | None = None) -> FastAPI:
    cfg: Config = load_config(env)
    app = FastAPI(title="symphony-bridge", version="1.0.0")
    app.state.config = cfg

    @app.get("/health")
    def health() -> dict[str, object]:
        # Deliberately reports posture only -- never configuration values.
        return {"status": "ok", "fake": cfg.fake}

    return app


def main() -> None:
    cfg = load_config()
    host, _, port = cfg.bind.partition(":")
    uvicorn.run(create_app(), host=host or "127.0.0.1", port=int(port or "8099"))


if __name__ == "__main__":
    main()
