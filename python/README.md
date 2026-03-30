# utopia-runtime

Zero-impact production probe runtime for [Utopia](https://github.com/paulvann/utopia).

Captures errors, API calls, database queries, function behavior, and infrastructure context — sending it to the Utopia data service so AI coding agents can understand how your code runs in production.

## Installation

```bash
pip install utopia-runtime
```

## Usage

Probes are added by `utopia instrument` — you don't typically import this directly. The runtime auto-initializes from `.utopia/config.json` in your project root.

```python
import utopia_runtime

# Reports are non-blocking and never raise
utopia_runtime.report_function(
    file="app/routes.py",
    line=25,
    function_name="get_user",
    args=[{"user_id": 123}],
    return_value={"found": True},
    duration=15,
    call_stack=[],
)
```

## Zero dependencies

Uses only the Python standard library. No external packages required.
