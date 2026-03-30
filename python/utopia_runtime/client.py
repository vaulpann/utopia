"""HTTP client for sending probe data to the Utopia data service.

Uses only ``urllib`` from the standard library -- no external dependencies.
All public functions are designed to never raise; failures are silently
swallowed so that instrumented applications are never impacted by probe
reporting issues.
"""

import json
import urllib.request
import urllib.error
from typing import Any


def send_probes(endpoint: str, probes: list[dict[str, Any]]) -> bool:
    """Send a batch of probes to the data service. Never raises."""
    try:
        url = f"{endpoint.rstrip('/')}/api/v1/probes"
        data = json.dumps(probes).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False
