"""
Utopia Runtime - Lightweight probe runtime for production observability.

This package provides zero-impact probe reporting functions that collect
observability data (errors, database calls, API calls, infrastructure info,
function traces) and send them asynchronously to the Utopia data service.

Only Python stdlib is used -- no external dependencies required.
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

__version__ = '0.1.0'
__all__ = [
    'init',
    'report_error',
    'report_db',
    'report_api',
    'report_infra',
    'report_function',
    'report_llm_context',
]
