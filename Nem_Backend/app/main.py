import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker
from starlette.middleware.cors import CORSMiddleware
from starlette.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.routes import (
    assets,
    dashboard,
    frontend_compat,
    maintenance,
    monitoring,
    plc,
    readings,
    rules,
    variables,
)
from app.core.config import Settings, get_settings
from app.db.init_db import initialize_database
from app.db.session import create_database_engine, create_session_factory

LOGGER = logging.getLogger("nem_backend")


class FrontendStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as error:
            if error.status_code == 404 and not Path(path).suffix:
                return await super().get_response("index.html", scope)
            raise


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
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
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

    application.include_router(frontend_compat.router, prefix="/api/v1")
    application.include_router(assets.router, prefix="/api/v1")
    application.include_router(variables.router, prefix="/api/v1")
    application.include_router(readings.router, prefix="/api/v1")
    application.include_router(rules.router, prefix="/api/v1")
    application.include_router(monitoring.router, prefix="/api/v1")
    application.include_router(plc.router, prefix="/api/v1")
    application.include_router(maintenance.router, prefix="/api/v1")
    application.include_router(dashboard.router, prefix="/api/v1")
    frontend_directory = Path(__file__).resolve().parents[2] / "Nem_Frontend" / "dist"
    if frontend_directory.is_dir():
        application.mount(
            "/ui",
            FrontendStaticFiles(directory=str(frontend_directory), html=True),
            name="dashboard-ui",
        )
    application.add_api_route(
        "/plc/test",
        plc.plc_connection_test_compat,
        methods=["GET"],
        tags=["PLC / OPC UA"],
        include_in_schema=False,
    )

    @application.get("/", include_in_schema=False)
    def dashboard_home() -> RedirectResponse:
        destination = "/ui/" if frontend_directory.is_dir() else "/docs"
        return RedirectResponse(url=destination)

    return application

app = create_app()