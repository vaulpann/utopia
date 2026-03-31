"""
The ``@utopia`` decorator — self-healing Python functions.

Wraps any function (sync or async) so that when it raises an unexpected
exception:

1. The error + source code are sent to the OpenAI API.
2. OpenAI generates a fixed version of the function.
3. The fix is compiled and executed at runtime with the original arguments.
4. Everything is logged to ``.utopia/fixes/`` so coding agents can apply
   the permanent fix next time they spin up.

Intentional/expected exceptions pass through untouched.

Usage::

    from utopia_runtime import utopia

    @utopia
    def my_function(x, y):
        return x / y   # will self-heal on ZeroDivisionError

    @utopia(ignore=[ValueError])
    def strict_function(x):
        if x < 0:
            raise ValueError("must be positive")  # passes through, not healed
        return x ** 0.5  # other errors will still self-heal
"""

import asyncio
import functools
import inspect
import textwrap
import traceback
from typing import Any, Callable, Optional, Sequence, TypeVar, overload

from .healer import heal_function
from .fix_log import log_fix

F = TypeVar("F", bound=Callable[..., Any])


def _get_source(func: Callable) -> Optional[str]:
    """Best-effort source retrieval. Returns None if unavailable."""
    try:
        return textwrap.dedent(inspect.getsource(func))
    except (OSError, TypeError):
        return None


def _compile_fix(fixed_code: str, func: Callable) -> Optional[Callable]:
    """Compile the AI-generated fix and extract the function object."""
    try:
        local_ns: dict[str, Any] = {}
        exec(
            compile(fixed_code, f"<utopia-fix:{func.__name__}>", "exec"),
            func.__globals__,
            local_ns,
        )
        fixed_func = local_ns.get(func.__name__)
        if callable(fixed_func):
            return fixed_func
        return None
    except Exception:
        return None


def _should_heal(exc: Exception, ignore: tuple[type[BaseException], ...]) -> bool:
    """Return True if this exception should trigger self-healing."""
    if ignore and isinstance(exc, ignore):
        return False
    return True


def _handle_error(
    func: Callable,
    exc: Exception,
    args: tuple,
    kwargs: dict,
) -> Any:
    """Core healing logic shared by sync and async paths.

    Returns ``(fixed_func, ctx)`` if a fix was compiled, or ``(False, None)``
    if healing failed (caller should re-raise the original exception).
    """
    error_type = type(exc).__name__
    error_message = str(exc)
    error_tb = traceback.format_exc()

    source_code = _get_source(func)
    if source_code is None:
        return False, None

    source_file = "<unknown>"
    try:
        source_file = inspect.getfile(func)
    except (TypeError, OSError):
        pass

    fix_result = heal_function(
        function_name=func.__name__,
        source_code=source_code,
        error_type=error_type,
        error_message=error_message,
        error_traceback=error_tb,
        args_repr=repr(args),
        kwargs_repr=repr(kwargs),
    )

    if fix_result is None:
        return False, None

    fixed_code = fix_result["fixed_code"]
    explanation = fix_result["explanation"]

    fixed_func = _compile_fix(fixed_code, func)
    if fixed_func is None:
        log_fix(
            function_name=func.__name__,
            source_file=source_file,
            original_code=source_code,
            fixed_code=fixed_code,
            error_type=error_type,
            error_message=error_message,
            error_traceback=error_tb,
            explanation=explanation,
            hot_patch_success=False,
            patch_error="failed to compile fixed code",
        )
        return False, None

    return fixed_func, (fixed_code, explanation, source_code, source_file,
                        error_type, error_message, error_tb)


def _make_sync_wrapper(func: F, ignore: tuple[type[BaseException], ...]) -> F:
    @functools.wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return func(*args, **kwargs)
        except Exception as exc:
            if not _should_heal(exc, ignore):
                raise

            fixed_func, ctx = _handle_error(func, exc, args, kwargs)

            if fixed_func is False:
                raise

            (fixed_code, explanation, source_code, source_file,
             error_type, error_message, error_tb) = ctx

            try:
                result = fixed_func(*args, **kwargs)
            except Exception as patch_exc:
                log_fix(
                    function_name=func.__name__,
                    source_file=source_file,
                    original_code=source_code,
                    fixed_code=fixed_code,
                    error_type=error_type,
                    error_message=error_message,
                    error_traceback=error_tb,
                    explanation=explanation,
                    hot_patch_success=False,
                    patch_error=str(patch_exc),
                )
                raise exc from None

            log_fix(
                function_name=func.__name__,
                source_file=source_file,
                original_code=source_code,
                fixed_code=fixed_code,
                error_type=error_type,
                error_message=error_message,
                error_traceback=error_tb,
                explanation=explanation,
                hot_patch_success=True,
            )
            return result

    return wrapper  # type: ignore[return-value]


def _make_async_wrapper(func: F, ignore: tuple[type[BaseException], ...]) -> F:
    @functools.wraps(func)
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return await func(*args, **kwargs)
        except Exception as exc:
            if not _should_heal(exc, ignore):
                raise

            fixed_func, ctx = _handle_error(func, exc, args, kwargs)

            if fixed_func is False:
                raise

            (fixed_code, explanation, source_code, source_file,
             error_type, error_message, error_tb) = ctx

            try:
                result = fixed_func(*args, **kwargs)
                if asyncio.iscoroutine(result):
                    result = await result
            except Exception as patch_exc:
                log_fix(
                    function_name=func.__name__,
                    source_file=source_file,
                    original_code=source_code,
                    fixed_code=fixed_code,
                    error_type=error_type,
                    error_message=error_message,
                    error_traceback=error_tb,
                    explanation=explanation,
                    hot_patch_success=False,
                    patch_error=str(patch_exc),
                )
                raise exc from None

            log_fix(
                function_name=func.__name__,
                source_file=source_file,
                original_code=source_code,
                fixed_code=fixed_code,
                error_type=error_type,
                error_message=error_message,
                error_traceback=error_tb,
                explanation=explanation,
                hot_patch_success=True,
            )
            return result

    return wrapper  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Public API — supports @utopia, @utopia(), @utopia(ignore=[ValueError])
# ---------------------------------------------------------------------------

@overload
def utopia(func: F) -> F: ...

@overload
def utopia(*, ignore: Sequence[type[BaseException]] = ..., model: str = ...) -> Callable[[F], F]: ...

def utopia(
    func: Optional[F] = None,
    *,
    ignore: Optional[Sequence[type[BaseException]]] = None,
    model: Optional[str] = None,
) -> Any:
    """Self-healing function decorator.

    Can be used bare or with keyword arguments::

        @utopia
        def foo(): ...

        @utopia()
        def bar(): ...

        @utopia(ignore=[ValueError, KeyError])
        def baz(x):
            if x < 0:
                raise ValueError("negative")  # intentional — passes through
            return 1 / x  # unexpected ZeroDivisionError — will self-heal
    """
    ignore_tuple = tuple(ignore) if ignore else ()

    def decorator(fn: F) -> F:
        if inspect.iscoroutinefunction(fn):
            return _make_async_wrapper(fn, ignore_tuple)
        return _make_sync_wrapper(fn, ignore_tuple)

    if func is not None:
        # Called as @utopia (no parens)
        return decorator(func)

    # Called as @utopia() or @utopia(ignore=...)
    return decorator
