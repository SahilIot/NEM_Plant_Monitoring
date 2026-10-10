import logging
import asyncio
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker
from starlette.middleware.cors import CORSMiddleware

from app.api.routes import assets, dashboard, readings, rules, variables
from app.api.routes import monitoring
from app.core.config import Settings, get_settings
from app.db.session import create_database_engine, create_session_factory
from app.services.monitoring_engine import acquire_scheduler_lease, evaluate_rules, utc_now


LOGGER = logging.getLogger("nem_backend")


class RequestSizeLimitMiddleware:
    def __init__(self, app, max_bytes: int = 1_048_576) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        content_length = next(
            (value.decode("latin-1") for name, value in scope["headers"] if name == b"content-length"),
            None,
        )
        if content_length is not None:
            try:
                oversized = int(content_length) > self.max_bytes
            except ValueError:
                oversized = True
            if oversized:
                await JSONResponse(
                    status_code=413,
                    content={"error": {"code": 413, "message": "Request body exceeds 1 MiB"}},
                )(scope, receive, send)
                return

        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                await self.app(scope, receive, send)
                return
            body.extend(message.get("body", b""))
            if len(body) > self.max_bytes:
                await JSONResponse(
                    status_code=413,
                    content={"error": {"code": 413, "message": "Request body exceeds 1 MiB"}},
                )(scope, receive, send)
                return
            if not message.get("more_body", False):
                break

        body_message = {
            "type": "http.request",
            "body": bytes(body),
            "more_body": False,
        }
        delivered = False

        async def replay_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return body_message
            return await receive()

        await self.app(scope, replay_receive, send)


def create_app(settings: Settings | None = None) -> FastAPI:
    selected_settings = settings or get_settings()
    engine = create_database_engine(selected_settings.database_url)
    session_factory: sessionmaker = create_session_factory(engine)
    scheduler_owner = str(uuid4())

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        scheduler_task = None
        if selected_settings.monitoring_scheduler_enabled:
            scheduler_task = asyncio.create_task(scheduler_loop())
        try:
            yield
        finally:
            if scheduler_task is not None:
                scheduler_task.cancel()
                try:
                    await scheduler_task
                except asyncio.CancelledError:
                    pass
            engine.dispose()

    def scheduled_evaluation_tick() -> None:
        now = utc_now()
        interval = max(1, selected_settings.monitoring_evaluation_interval_seconds)
        with session_factory() as session:
            if not acquire_scheduler_lease(
                session,
                owner_id=scheduler_owner,
                now=now,
                lease_seconds=interval * 3,
            ):
                return
            result = evaluate_rules(
                session,
                evaluated_at=now,
                stale_after_seconds=selected_settings.monitoring_default_stale_after_seconds,
                respect_rule_intervals=True,
            )
            session.commit()
            LOGGER.debug("Scheduled monitoring evaluation: %s", result)

    async def scheduler_loop() -> None:
        interval = max(1, selected_settings.monitoring_evaluation_interval_seconds)
        while True:
            await asyncio.sleep(interval)
            work = asyncio.create_task(asyncio.to_thread(scheduled_evaluation_tick))
            try:
                await work
            except asyncio.CancelledError:
                await asyncio.shield(work)
                raise

    application = FastAPI(
        title=selected_settings.app_name,
        description=(
            "Industrial asset monitoring API with rule evaluation, persisted alerts, "
            "and event history. It is not a safety interlock."
        ),
        version="2.0.0",
        lifespan=lifespan,
    )
    application.state.engine = engine
    application.state.session_factory = session_factory
    application.state.settings = selected_settings
    application.add_middleware(RequestSizeLimitMiddleware, max_bytes=1_048_576)

    if selected_settings.allowed_origins:
        application.add_middleware(
            CORSMiddleware,
            allow_origins=selected_settings.allowed_origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PATCH", "DELETE"],
            allow_headers=["Authorization", "Content-Type"],
        )

    @application.exception_handler(HTTPException)
    async def http_error_handler(_request: Request, error: HTTPException) -> JSONResponse:
        message = error.detail if isinstance(error.detail, str) else "Request failed"
        return JSONResponse(
            status_code=error.status_code,
            content={"error": {"code": error.status_code, "message": message}},
            headers=error.headers,
        )

    @application.exception_handler(RequestValidationError)
    async def validation_error_handler(
        _request: Request, error: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": 422,
                    "message": "Request validation failed",
                    "details": jsonable_encoder(error.errors()),
                }
            },
        )

    @application.exception_handler(SQLAlchemyError)
    async def database_error_handler(request: Request, error: SQLAlchemyError) -> JSONResponse:
        LOGGER.error(
            "Database operation failed for %s",
            request.url.path,
            exc_info=(type(error), error, error.__traceback__),
        )
        return JSONResponse(
            status_code=503,
            content={"error": {"code": 503, "message": "Database operation failed; please retry"}},
        )

    @application.get("/api/v1/health", tags=["health"])
    @application.get("/health", tags=["health"], include_in_schema=False)
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @application.get("/api/v1/ready", tags=["health"])
    def readiness() -> JSONResponse:
        try:
            with session_factory() as session:
                session.execute(text("SELECT 1"))
        except SQLAlchemyError:
            LOGGER.exception("Database readiness check failed")
            return JSONResponse(
                status_code=503,
                content={"error": {"code": 503, "message": "Database is unavailable"}},
            )
        return JSONResponse(content={"status": "ready", "database": "connected"})

    prefix = "/api/v1"
    application.include_router(assets.router, prefix=prefix)
    application.include_router(variables.router, prefix=prefix)
    application.include_router(readings.router, prefix=prefix)
    application.include_router(rules.router, prefix=prefix)
    application.include_router(dashboard.router, prefix=prefix)
    application.include_router(monitoring.router, prefix=prefix)
    return application


app = create_app()
