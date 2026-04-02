"""
AI-powered function healer.

Sends the broken function's source code + error details (and optionally
production probe context) to OpenAI or Anthropic and gets back a fixed
version. Uses raw ``urllib`` — no external dependencies.
"""

import json
import os
import re
import urllib.request
import urllib.error
from typing import Optional


# ---------------------------------------------------------------------------
# Module-level config (set via configure())
# ---------------------------------------------------------------------------

_config: dict[str, str] = {
    "api_key": "",
    "model": "",
    "base_url": "",
    "provider": "",          # "openai" or "anthropic"
    "anthropic_api_key": "",
}


def _get_provider() -> str:
    return (_config["provider"]
            or os.environ.get("UTOPIA_PROVIDER", "")
            or ("anthropic" if _get_anthropic_api_key() and not _get_openai_api_key() else "openai"))


def _get_openai_api_key() -> str:
    return _config["api_key"] or os.environ.get("OPENAI_API_KEY", "")


def _get_anthropic_api_key() -> str:
    return _config["anthropic_api_key"] or os.environ.get("ANTHROPIC_API_KEY", "")


def _get_model() -> str:
    if _config["model"]:
        return _config["model"]
    if os.environ.get("UTOPIA_MODEL"):
        return os.environ["UTOPIA_MODEL"]
    # Provider-specific defaults
    provider = _get_provider()
    if provider == "anthropic":
        return "claude-sonnet-4-20250514"
    return "gpt-4o"


def _get_base_url() -> str:
    if _config["base_url"]:
        return _config["base_url"]
    if os.environ.get("UTOPIA_BASE_URL"):
        return os.environ["UTOPIA_BASE_URL"]
    provider = _get_provider()
    if provider == "anthropic":
        return "https://api.anthropic.com"
    return "https://api.openai.com"


# ---------------------------------------------------------------------------
# Probe context enrichment
# ---------------------------------------------------------------------------

def _fetch_probe_context(function_name: str, source_file: str) -> str:
    """Query the local Utopia data service for production context.

    Returns a formatted string of probe data, or empty string if the
    service is unavailable or probes are not enabled.
    """
    try:
        # Load .utopia/config.json to get endpoint and check mode
        import pathlib
        d = pathlib.Path.cwd()
        cfg = None
        for _ in range(10):
            cfg_path = d / ".utopia" / "config.json"
            if cfg_path.exists():
                cfg = json.loads(cfg_path.read_text())
                break
            parent = d.parent
            if parent == d:
                break
            d = parent

        if not cfg:
            return ""

        mode = cfg.get("utopiaMode", "instrument")
        if mode not in ("instrument", "both"):
            return ""

        endpoint = cfg.get("dataEndpoint", "")
        if not endpoint:
            return ""

        sections: list[str] = []

        # Recent errors for this function
        try:
            url = f"{endpoint}/api/v1/probes/errors/recent?hours=168&limit=5"
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                probes = data.get("probes", [])
                # Filter to this function
                relevant = [p for p in probes
                            if p.get("functionName") == function_name
                            or p.get("file", "").endswith(source_file.split("/")[-1])]
                if relevant:
                    lines = ["Recent errors for this function/file:"]
                    for p in relevant[:3]:
                        d = p.get("data", {})
                        lines.append(f"  - {d.get('error_type', d.get('errorType', '?'))}: "
                                     f"{d.get('message', '?')} "
                                     f"(input: {json.dumps(d.get('input_data', d.get('inputData', {})))})")
                    sections.append("\n".join(lines))
        except Exception:
            pass

        # Recent successful calls for this function
        try:
            url = (f"{endpoint}/api/v1/probes"
                   f"?probe_type=function&limit=5")
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                probes = data.get("probes", [])
                relevant = [p for p in probes if p.get("functionName") == function_name]
                if relevant:
                    lines = ["Recent successful calls to this function:"]
                    for p in relevant[:3]:
                        d = p.get("data", {})
                        lines.append(f"  - args: {json.dumps(d.get('args', []))}, "
                                     f"returned: {json.dumps(d.get('return_value', d.get('returnValue', None)))}, "
                                     f"duration: {d.get('duration', '?')}ms")
                    sections.append("\n".join(lines))
        except Exception:
            pass

        if not sections:
            return ""

        return "\n\n## Production Context (from Utopia probes)\n\n" + "\n\n".join(sections)

    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Prompt building
# ---------------------------------------------------------------------------

def _build_prompt(
    function_name: str,
    source_code: str,
    error_type: str,
    error_message: str,
    error_traceback: str,
    args_repr: str,
    kwargs_repr: str,
    probe_context: str = "",
) -> str:
    base = f"""You are a Python debugging expert. A function crashed at runtime and you need to fix it.

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
{probe_context}
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
    return base


def _extract_json(text: str) -> Optional[dict]:
    """Parse JSON from the response, handling markdown fences if present."""
    text = text.strip()
    fence_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?\s*```", text, re.DOTALL)
    if fence_match:
        text = fence_match.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


# ---------------------------------------------------------------------------
# Provider-specific API calls
# ---------------------------------------------------------------------------

def _call_openai(prompt: str, model: str, base_url: str, api_key: str) -> Optional[dict]:
    """Call the OpenAI-compatible chat completions API."""
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "response_format": {"type": "json_object"},
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/v1/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read().decode("utf-8"))
        content = result["choices"][0]["message"]["content"]
        return _extract_json(content)


def _call_anthropic(prompt: str, model: str, base_url: str, api_key: str) -> Optional[dict]:
    """Call the Anthropic Messages API."""
    body = json.dumps({
        "model": model,
        "max_tokens": 4096,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/v1/messages",
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read().decode("utf-8"))
        # Anthropic returns content as a list of blocks
        text_blocks = [b["text"] for b in result.get("content", []) if b.get("type") == "text"]
        content = "\n".join(text_blocks)
        return _extract_json(content)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def heal_function(
    function_name: str,
    source_code: str,
    error_type: str,
    error_message: str,
    error_traceback: str,
    args_repr: str = "",
    kwargs_repr: str = "",
    source_file: str = "",
) -> Optional[dict]:
    """Send error + code to an AI provider and get a fix.

    Returns ``{"fixed_code": str, "explanation": str}`` on success,
    or ``None`` if the API call fails or the response is unparseable.
    """
    provider = _get_provider()

    if provider == "anthropic":
        api_key = _get_anthropic_api_key()
    else:
        api_key = _get_openai_api_key()

    if not api_key:
        return None

    model = _get_model()
    base_url = _get_base_url()

    # Fetch production context if available (never blocks on failure)
    probe_context = _fetch_probe_context(function_name, source_file) if source_file else ""

    prompt = _build_prompt(
        function_name=function_name,
        source_code=source_code,
        error_type=error_type,
        error_message=error_message,
        error_traceback=error_traceback,
        args_repr=args_repr,
        kwargs_repr=kwargs_repr,
        probe_context=probe_context,
    )

    try:
        if provider == "anthropic":
            parsed = _call_anthropic(prompt, model, base_url, api_key)
        else:
            parsed = _call_openai(prompt, model, base_url, api_key)

        if parsed and "fixed_code" in parsed and "explanation" in parsed:
            return parsed
        return None
    except Exception:
        return None
