"""
OpenAI-powered function healer.

Sends the broken function's source code + error details to the OpenAI API
and gets back a fixed version. Uses raw ``urllib`` — no external dependencies.
"""

import json
import os
import re
import urllib.request
import urllib.error
from typing import Optional


# Module-level config (set via configure())
_config: dict[str, str] = {
    "api_key": "",
    "model": "",
    "base_url": "",
}


def _get_api_key() -> str:
    return _config["api_key"] or os.environ.get("OPENAI_API_KEY", "")


def _get_model() -> str:
    return _config["model"] or os.environ.get("UTOPIA_MODEL", "gpt-4o")


def _get_base_url() -> str:
    return _config["base_url"] or os.environ.get("UTOPIA_BASE_URL", "https://api.openai.com")


def _build_prompt(
    function_name: str,
    source_code: str,
    error_type: str,
    error_message: str,
    error_traceback: str,
    args_repr: str,
    kwargs_repr: str,
) -> str:
    return f"""You are a Python debugging expert. A function crashed at runtime and you need to fix it.

## Function Name
{function_name}

## Original Source Code
```python
{source_code}
```

## Error
{error_type}: {error_message}

## Full Traceback
{error_traceback}

## Arguments That Caused The Error
args: {args_repr}
kwargs: {kwargs_repr}

## Instructions
1. Analyze the error and the code.
2. Write a FIXED version of the function that handles this error case correctly.
3. The fixed function MUST have the exact same name: `{function_name}`
4. The fixed function MUST have the same signature (same parameters).
5. Only output the function definition. No imports outside the function — if you need an import, put it inside the function body.
6. The fix should be minimal — only change what is needed to fix the bug.
7. Do NOT include the decorator in the fixed function.

Respond with ONLY a JSON object (no markdown fences, no extra text):
{{"fixed_code": "the complete fixed function definition as a string", "explanation": "one sentence explaining what was wrong and how you fixed it"}}"""


def _extract_json(text: str) -> Optional[dict]:
    """Parse JSON from the response, handling markdown fences if present."""
    text = text.strip()

    # Strip markdown code fences if the model wrapped them
    fence_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?\s*```", text, re.DOTALL)
    if fence_match:
        text = fence_match.group(1).strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def heal_function(
    function_name: str,
    source_code: str,
    error_type: str,
    error_message: str,
    error_traceback: str,
    args_repr: str = "",
    kwargs_repr: str = "",
) -> Optional[dict]:
    """Send error + code to OpenAI and get a fix.

    Returns ``{"fixed_code": str, "explanation": str}`` on success,
    or ``None`` if the API call fails or the response is unparseable.
    """
    api_key = _get_api_key()
    if not api_key:
        return None

    model = _get_model()
    base_url = _get_base_url().rstrip("/")

    prompt = _build_prompt(
        function_name=function_name,
        source_code=source_code,
        error_type=error_type,
        error_message=error_message,
        error_traceback=error_traceback,
        args_repr=args_repr,
        kwargs_repr=kwargs_repr,
    )

    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "response_format": {"type": "json_object"},
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            content = result["choices"][0]["message"]["content"]
            parsed = _extract_json(content)
            if parsed and "fixed_code" in parsed and "explanation" in parsed:
                return parsed
            return None
    except Exception:
        return None
