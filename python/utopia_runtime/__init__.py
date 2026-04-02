"""
Utopia Runtime — Production probes + self-healing functions.

This package provides two capabilities:

**1. Production probes** — zero-impact observability for AI coding agents::

    import utopia_runtime
    utopia_runtime.report_error(file="app.py", line=10, ...)

**2. Self-healing decorator** — catches errors, fixes them with AI at runtime::

    from utopia_runtime import utopia

    @utopia
    def my_function(x, y):
        return x / y  # self-heals on ZeroDivisionError

    @utopia(ignore=[ValueError])
    def strict(x):
        if x < 0:
            raise ValueError("negative")  # intentional — passes through
        return x ** 0.5

Configuration for self-healing — set env vars or call ``configure()``::

    export OPENAI_API_KEY="sk-..."
    export UTOPIA_MODEL="gpt-4o"        # optional, default gpt-4o

    # Or in code:
    from utopia_runtime import configure
    configure(api_key="sk-...", model="gpt-4o-mini")
"""

from .probe import (
    init,
    report_error,
    report_db,
    report_api,
    report_infra,
    report_function,
    report_llm_context,
)

from .decorator import utopia
from .healer import _config as _healer_config

__version__ = '0.2.0'


def configure(
    api_key: str = "",
    model: str = "",
    base_url: str = "",
    provider: str = "",
    anthropic_api_key: str = "",
) -> None:
    """Set self-healing configuration programmatically.

    Args:
        api_key: OpenAI API key (falls back to ``OPENAI_API_KEY`` env var)
        model: Model to use (falls back to ``UTOPIA_MODEL``, default ``gpt-4o`` or ``claude-sonnet-4-20250514``)
        base_url: API base URL (falls back to ``UTOPIA_BASE_URL``)
        provider: ``"openai"`` or ``"anthropic"`` (falls back to ``UTOPIA_PROVIDER``, auto-detects from available keys)
        anthropic_api_key: Anthropic API key (falls back to ``ANTHROPIC_API_KEY`` env var)
    """
    if api_key:
        _healer_config["api_key"] = api_key
    if model:
        _healer_config["model"] = model
    if base_url:
        _healer_config["base_url"] = base_url
    if provider:
        _healer_config["provider"] = provider
    if anthropic_api_key:
        _healer_config["anthropic_api_key"] = anthropic_api_key


__all__ = [
    # Probes
    'init',
    'report_error',
    'report_db',
    'report_api',
    'report_infra',
    'report_function',
    'report_llm_context',
    # Self-healing
    'utopia',
    'configure',
]
