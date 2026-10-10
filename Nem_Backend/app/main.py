import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker
from starlette.middleware.cors import CORSMiddleware

from app.api.routes import (
    assets,
    dashboard,
    monitoring,
    readings,
    rules,
    variables,
)
from app.core.config import Settings, get_settings
from app.db.init_db import initialize_database
from app.db.session import create_database_engine, create_session_factory

LOGGER = logging.getLogger("nem_backend")

def create_app(settings: Settings | None = None) -> FastAPI:
    selected_settings = settings or get_settings()
    engine = create_database_engine(selected_settings.database_url)
    session_factory: sessionmaker = create_session_factory(engine)

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        initialize_database(engine)
        yield
        engine.dispose()

    application = FastAPI(
        title=selected_settings.app_name,
        description=(
            "Phase 1 industrial asset monitoring API. "
            "Readings may include simulated sample data."
        ),
        version="1.0.0",
        lifespan=lifespan,
    )

    application.state.engine = engine
    application.state.session_factory = session_factory
    application.state.settings = selected_settings

    if selected_settings.allowed_origins:
        application.add_middleware(
            CORSMiddleware,
            allow_origins=selected_settings.allowed_origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PATCH", "DELETE"],
            allow_headers=["Authorization", "Content-Type"],
        )

    @application.exception_handler(SQLAlchemyError)
    async def database_error_handler(
        request: Request,
        error: SQLAlchemyError,
    ) -> JSONResponse:
        LOGGER.error(
            "Database operation failed for %s",
            request.url.path,
            exc_info=(type(error), error, error.__traceback__),
        )
        return JSONResponse(
            status_code=503,
            content={"detail": "Database operation failed; please retry"},
        )

    @application.get("/health", tags=["health"])
    def health() -> JSONResponse:
        try:
            with session_factory() as session:
                session.execute(text("SELECT 1"))
        except SQLAlchemyError:
            LOGGER.exception("Database health check failed")
            return JSONResponse(
                status_code=503,
                content={
                    "status": "degraded",
                    "database": "disconnected",
                },
            )

        return JSONResponse(
            content={"status": "ok", "database": "connected"}
        )

    application.include_router(assets.router, prefix="/api/v1")
    application.include_router(variables.router, prefix="/api/v1")
    application.include_router(readings.router, prefix="/api/v1")
    application.include_router(rules.router, prefix="/api/v1")
    application.include_router(monitoring.router, prefix="/api/v1")
    application.include_router(dashboard.router, prefix="/api/v1")

    return application

app = create_app()