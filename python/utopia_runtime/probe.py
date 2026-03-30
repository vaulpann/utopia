"""
Utopia probe engine -- the core reporting module.

All ``report_*`` functions are designed to be completely non-blocking and
safe: they never raise exceptions, never slow down the caller, and silently
discard data when the circuit breaker is open or the queue is full.

Architecture:
    * A module-level ``queue.Queue`` buffers probe dicts.
    * A single daemon thread drains the queue every 5 s (or sooner when the
      batch reaches 50 items) and ships them via ``client.send_probes()``.
    * A simple circuit breaker (3 consecutive failures -> open for 60 s)
      avoids hammering a dead endpoint.
"""

import atexit
import os
import queue
import socket
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from . import client as _client

# ---------------------------------------------------------------------------
# Module-level state
# ---------------------------------------------------------------------------

_config: dict[str, str] = {
    "endpoint": "",
    "project_id": "",
}

_queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=10_000)

_worker_thread: Optional[threading.Thread] = None
_worker_lock = threading.Lock()
_started = False

# Circuit breaker
_consecutive_failures = 0
_circuit_open = False
_circuit_open_time: float = 0.0
_FAILURE_THRESHOLD = 3
_CIRCUIT_OPEN_DURATION = 60.0  # seconds

# Flush settings
_FLUSH_INTERVAL = 5.0  # seconds
_BATCH_SIZE = 50

# Shutdown flag
_shutdown_event = threading.Event()


# ---------------------------------------------------------------------------
# Initialisation
# ---------------------------------------------------------------------------

def _load_from_config_file() -> None:
    """Try to load config from .utopia/config.json (walks up from cwd)."""
    try:
        import json
        import pathlib
        d = pathlib.Path.cwd()
        for _ in range(10):
            cfg_path = d / ".utopia" / "config.json"
            if cfg_path.exists():
                cfg = json.loads(cfg_path.read_text())
                if not _config["endpoint"] and cfg.get("dataEndpoint"):
                    _config["endpoint"] = cfg["dataEndpoint"]
                if not _config["project_id"] and cfg.get("projectId"):
                    _config["project_id"] = cfg["projectId"]
                return
            parent = d.parent
            if parent == d:
                break
            d = parent
    except Exception:
        pass


def init(
    endpoint: str = "",
    project_id: str = "",
) -> None:
    """Explicitly initialise the Utopia runtime."""
    _config["endpoint"] = endpoint or os.environ.get("UTOPIA_ENDPOINT", "")
    _config["project_id"] = project_id or os.environ.get("UTOPIA_PROJECT_ID", "")
    if not _config["endpoint"] or not _config["project_id"]:
        _load_from_config_file()
    _start_worker()


def _ensure_initialized() -> None:
    """Auto-initialise from env vars or .utopia/config.json."""
    global _started
    if _started:
        return
    with _worker_lock:
        if _started:
            return
        if not _config["endpoint"]:
            _config["endpoint"] = os.environ.get("UTOPIA_ENDPOINT", "")
        if not _config["project_id"]:
            _config["project_id"] = os.environ.get("UTOPIA_PROJECT_ID", "")
        if not _config["endpoint"] or not _config["project_id"]:
            _load_from_config_file()
        _start_worker()


# ---------------------------------------------------------------------------
# Background worker
# ---------------------------------------------------------------------------

def _start_worker() -> None:
    """Start the daemon flush thread (idempotent)."""
    global _worker_thread, _started
    if _started:
        return
    _started = True
    _worker_thread = threading.Thread(target=_flush_loop, name="utopia-probe-worker", daemon=True)
    _worker_thread.start()
    atexit.register(_shutdown)


def _shutdown() -> None:
    """Drain remaining probes on interpreter shutdown."""
    _shutdown_event.set()
    # Give the worker a moment to flush
    if _worker_thread is not None and _worker_thread.is_alive():
        _worker_thread.join(timeout=3.0)
    # Final emergency flush
    _flush_batch()


def _flush_loop() -> None:
    """Main loop for the background worker thread."""
    while not _shutdown_event.is_set():
        try:
            # Wait up to FLUSH_INTERVAL, but wake early if batch is large
            deadline = time.monotonic() + _FLUSH_INTERVAL
            while time.monotonic() < deadline and not _shutdown_event.is_set():
                if _queue.qsize() >= _BATCH_SIZE:
                    break
                _shutdown_event.wait(timeout=0.25)
            _flush_batch()
        except Exception:
            # Never let the worker die
            pass


def _flush_batch() -> None:
    """Drain the queue and send a batch to the data service."""
    global _consecutive_failures, _circuit_open, _circuit_open_time

    # Circuit breaker check
    if _circuit_open:
        if time.monotonic() - _circuit_open_time < _CIRCUIT_OPEN_DURATION:
            # Discard everything while circuit is open to avoid memory growth
            while not _queue.empty():
                try:
                    _queue.get_nowait()
                except queue.Empty:
                    break
            return
        else:
            # Half-open: allow one attempt
            _circuit_open = False
            _consecutive_failures = 0

    # Drain queue
    batch: list[dict[str, Any]] = []
    while len(batch) < 500:  # cap per-flush to avoid huge payloads
        try:
            item = _queue.get_nowait()
            batch.append(item)
        except queue.Empty:
            break

    if not batch:
        return

    endpoint = _config.get("endpoint", "")

    if not endpoint:
        # Nowhere to send -- silently discard
        return

    success = _client.send_probes(endpoint, batch)

    if success:
        _consecutive_failures = 0
    else:
        _consecutive_failures += 1
        if _consecutive_failures >= _FAILURE_THRESHOLD:
            _circuit_open = True
            _circuit_open_time = time.monotonic()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _generate_id() -> str:
    """Generate a unique probe identifier."""
    return str(uuid.uuid4())


def _timestamp() -> str:
    """ISO-8601 UTC timestamp."""
    return datetime.now(timezone.utc).isoformat()


def _hostname() -> str:
    try:
        return socket.gethostname()
    except Exception:
        return "<unknown>"


def _base_probe(probe_type: str, file: str, line: int, function_name: str = "") -> dict[str, Any]:
    """Build the common probe envelope."""
    return {
        "id": _generate_id(),
        "probeType": probe_type,
        "timestamp": _timestamp(),
        "projectId": _config.get("project_id", ""),
        "file": file,
        "line": line,
        "functionName": function_name,
        "metadata": {
            "runtime": "python",
            "hostname": _hostname(),
            "pid": os.getpid(),
            "env": os.environ.get("UTOPIA_ENV", os.environ.get("NODE_ENV", "production")),
        },
    }


def _enqueue(probe: dict[str, Any]) -> None:
    """Push a probe dict onto the queue; drop silently if full."""
    try:
        _queue.put_nowait(probe)
    except queue.Full:
        pass  # back-pressure: silently drop


# ---------------------------------------------------------------------------
# Public report_* functions
# ---------------------------------------------------------------------------

def report_error(
    file: str,
    line: int,
    function_name: str,
    error_type: str,
    message: str,
    stack: str,
    input_data: Optional[dict[str, str]] = None,
) -> None:
    """Report a caught exception.

    Called by the injected error-probe try/except wrappers.
    """
    try:
        _ensure_initialized()
        probe = _base_probe("error", file, line, function_name)
        probe["data"] = {
            "error_type": error_type,
            "message": message,
            "stack": stack,
            "input_data": input_data or {},
        }
        _enqueue(probe)
    except Exception:
        pass


def report_db(
    file: str,
    line: int,
    function_name: str = "",
    operation: str = "",
    query: Optional[str] = None,
    table: Optional[str] = None,
    duration: float = 0.0,
    row_count: Optional[int] = None,
    connection_info: Optional[dict[str, Any]] = None,
    params: Optional[Any] = None,
) -> None:
    """Report a database operation.

    Called by the injected database-probe wrappers.
    """
    try:
        _ensure_initialized()
        probe = _base_probe("database", file, line, function_name)
        probe["data"] = {
            "operation": operation,
            "query": query,
            "table": table,
            "duration": duration,
            "row_count": row_count,
            "connection_info": connection_info or {},
            "params": repr(params) if params is not None else None,
        }
        _enqueue(probe)
    except Exception:
        pass


def report_api(
    file: str,
    line: int,
    function_name: str = "",
    method: str = "",
    url: str = "",
    status_code: Optional[int] = None,
    duration: float = 0.0,
    request_headers: Optional[dict[str, str]] = None,
    response_headers: Optional[dict[str, str]] = None,
    request_body: Optional[str] = None,
    response_body: Optional[str] = None,
    error: Optional[str] = None,
) -> None:
    """Report an outbound HTTP API call.

    Called by the injected API-probe wrappers.
    """
    try:
        _ensure_initialized()
        probe = _base_probe("api", file, line, function_name)

        # Sanitize headers: strip sensitive values
        _sensitive_keys = {"authorization", "x-api-key", "cookie", "set-cookie"}

        def _sanitize_headers(headers: Optional[dict[str, str]]) -> Optional[dict[str, str]]:
            if headers is None:
                return None
            return {
                k: ("***" if k.lower() in _sensitive_keys else v)
                for k, v in headers.items()
            }

        probe["data"] = {
            "method": method,
            "url": url,
            "status_code": status_code,
            "duration": duration,
            "request_headers": _sanitize_headers(request_headers),
            "response_headers": _sanitize_headers(response_headers),
            "request_body": request_body,
            "response_body": response_body,
            "error": error,
        }
        _enqueue(probe)
    except Exception:
        pass


def report_infra(
    file: str,
    line: int = 0,
    provider: str = "other",
    region: Optional[str] = None,
    service_type: Optional[str] = None,
    instance_id: Optional[str] = None,
    container_info: Optional[dict[str, Any]] = None,
    env_vars: Optional[dict[str, str]] = None,
) -> None:
    """Report infrastructure / deployment environment information.

    Typically called once at application startup from the injected infra probe.
    """
    try:
        _ensure_initialized()
        probe = _base_probe("infra", file, line)
        probe["data"] = {
            "provider": provider,
            "region": region,
            "service_type": service_type,
            "instance_id": instance_id,
            "container_info": container_info or {},
            "env_vars": env_vars or {},
        }
        _enqueue(probe)
    except Exception:
        pass


def report_function(
    file: str,
    line: int,
    function_name: str,
    args: Optional[dict[str, str]] = None,
    return_value: Optional[str] = None,
    duration: float = 0.0,
    call_stack: Optional[list[str]] = None,
) -> None:
    """Report a function invocation (utopia mode).

    Captures entry arguments and execution duration for every instrumented
    function call.
    """
    try:
        _ensure_initialized()
        probe = _base_probe("function", file, line, function_name)
        probe["data"] = {
            "args": args or {},
            "return_value": return_value,
            "duration": duration,
            "call_stack": call_stack or [],
        }
        _enqueue(probe)
    except Exception:
        pass


def report_llm_context(
    file: str,
    line: int,
    function_name: str,
    context: Any,
) -> None:
    """Report LLM context data (utopia mode).

    Used to capture context windows, prompt chains, and other LLM-specific
    observability data that helps AI coding agents understand the production
    environment.
    """
    try:
        _ensure_initialized()
        probe = _base_probe("llm_context", file, line, function_name)
        # Serialize context safely
        if isinstance(context, dict):
            probe["data"] = context
        elif isinstance(context, str):
            probe["data"] = {"context": context}
        else:
            probe["data"] = {"context": repr(context)}
        _enqueue(probe)
    except Exception:
        pass
