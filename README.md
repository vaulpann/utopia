<div align="center">

# utopia

### Production Observability, Self-Healing, and Security Analysis for AI-Assisted Development

**Give your AI coding agent real-time production context, automatic error recovery, and runtime vulnerability detection.**

[![npm version](https://img.shields.io/npm/v/@utopia-ai/cli.svg)](https://www.npmjs.com/package/@utopia-ai/cli)
[![PyPI version](https://img.shields.io/pypi/v/utopia-runtime.svg)](https://pypi.org/project/utopia-runtime/)


<br />

[![Watch the demo](https://img.youtube.com/vi/dibx_WX7PpA/maxresdefault.jpg)](https://www.youtube.com/watch?v=dibx_WX7PpA)

**Watch: Utopia in action** (click to play)

<br />

</div>

---

Utopia is a CLI tool that instruments your codebase with three capabilities:

1. **Production probes** -- captures how code actually runs at runtime (errors, API calls, database queries, auth decisions, data shapes) and makes it available to your AI coding agent via MCP.
2. **Self-healing functions** -- wraps functions so they catch unexpected errors at runtime, generate fixes via OpenAI or Anthropic, hot-patch them live, and log everything for permanent application by your coding agent.
3. **Runtime security audit** -- analyzes collected probe data to find vulnerabilities that static analysis tools cannot detect, because it operates on real runtime behavior rather than source code patterns.

<br />

## How It Works

```
utopia init          ->  Configure your project (30 seconds)
utopia instrument    ->  AI adds probes + self-healing to your codebase
utopia serve -b      ->  Start the local data service
                     ->  Run your app normally
                     ->  Probes capture runtime data
                     ->  Self-healing catches and fixes errors automatically
                     ->  AI agent queries everything via MCP
utopia audit         ->  AI analyzes runtime data for security vulnerabilities
```

`utopia instrument` handles both probes and self-healing in a single command based on the mode selected during `utopia init`. `utopia audit` performs deep security analysis using the collected probe data.

<br />

## Runtime Security Audit

Traditional security tools scan source code (SAST) or network traffic (DAST). Utopia analyzes *semantic runtime behavior* -- what the code actually does with data, how auth decisions are made, and what crosses trust boundaries at runtime.

```bash
utopia audit
```

### Findings from production applications

**Auth bypass via UI-only gate:**
```
[CRITICAL] Lab content rendered to unauthenticated users — auth is UI overlay only

Evidence: app/lab/layout.tsx renders {props.children} unconditionally, then adds
an overlay on top. The probe records auth_enforcement: "overlay_ui_only". Any user
can open DevTools and remove the overlay to access all lab content.

Fix: Gate children at the server level — redirect before rendering.
```

**SQL injection through external API:**
```
[HIGH] Non-parameterized SQL WHERE clause sent to HuggingFace datasets API

Evidence: buildWhereClause() uses string interpolation with single-quote doubling.
The probe confirms: query_parameterized: false, escape_method: "single_quote_doubling".
User-supplied category/language values flow directly into DuckDB SQL.

Fix: Validate inputs against the known allowlists before building the clause.
```

**Credential exposure in client bundle:**
```
[HIGH] Private inference endpoint credentials potentially exposed client-side

Evidence: NEXT_PUBLIC_INFERENCE_ENDPOINT bundles the private HF endpoint URL into
the client. The probe shows 8+ consecutive 401s — the auth token is being sent
from the browser to a paid, metered LLM endpoint.

Fix: Proxy through an API route. Keep the token server-side.
```

**Host header injection in OAuth:**
```
[MEDIUM] OAuth redirect URI derived from request Host header

Evidence: When the env var is unset, the fallback constructs the redirect URI from
the request's hostname. The probe records source: "request_hostname". An attacker
who controls the Host header steals the OAuth authorization code.

Fix: Validate the hostname against an allowlist of known-good domains.
```

### How it differs from static analysis

| Static analysis | Utopia runtime audit |
|----------------|---------------------|
| Sees `return user` -- doesn't know what `user` contains | Probes captured the actual response shape, including `password_hash` |
| Sees `try/catch` -- assumes errors are handled | Probes captured that the catch block re-throws raw upstream error bodies |
| Sees an auth middleware import | Probes captured that it only runs on `/api/*`, not on routes that need it |
| Pattern-matches known vulnerability signatures | Analyzes actual data flow, auth decisions, and trust boundary crossings |

### How findings reach your agent

After `utopia audit`, findings are stored in the data service and available via the `get_security_findings` MCP tool:

```
You: "Any security issues?"

Agent: *calls get_security_findings*
       -> Found 3 findings: auth bypass (critical), SQL injection (high),
          Host header injection (medium)
       -> Reads evidence, applies fixes, marks findings as resolved
```

<br />

## Self-Healing Functions

Wrap any function with automatic error recovery. Works with Python (`@utopia` decorator) and JavaScript/TypeScript (`utopia()` wrapper).

### Python

```python
from utopia_runtime import utopia

@utopia
def process_payment(order_id: str, amount: float):
    charge = stripe.charges.create(amount=int(amount), currency="usd")
    return charge.id
```

### JavaScript / TypeScript

```typescript
import { utopia } from 'utopia-runtime';

const processPayment = utopia(async (orderId: string, amount: number) => {
  const charge = await stripe.charges.create({ amount, currency: 'usd' });
  return charge.id;
}, { name: 'processPayment' });
```

### Error recovery flow

1. Utopia catches the error before it propagates
2. Sends the error, traceback, source code, and arguments to OpenAI or Anthropic
3. The AI generates a fix
4. The fix is compiled and re-executed at runtime
5. The fix is logged to `.utopia/fixes/` with original code, fixed code, and explanation
6. Your coding agent reads the fix via the `get_pending_fixes` MCP tool and applies it permanently

### Intentional errors pass through

Use `ignore` to let expected exceptions propagate normally:

```python
@utopia(ignore=[ValueError, PermissionError])
def validate_input(data):
    if not data.get("email"):
        raise ValueError("email required")  # intentional -- passes through
    return parse(data)  # unexpected errors still self-heal
```

```typescript
const strictParse = utopia((data: string) => {
  if (!data) throw new TypeError('data required');  // intentional
  return JSON.parse(data);  // unexpected errors self-heal
}, { ignore: [TypeError] });
```

### Multi-provider support

Self-healing works with both OpenAI and Anthropic. Utopia auto-detects which key is available:

| Variable | Provider | Default Model |
|----------|----------|---------------|
| `OPENAI_API_KEY` | OpenAI | `gpt-4o` |
| `ANTHROPIC_API_KEY` | Anthropic | `claude-sonnet-4-20250514` |

### Probe-enriched healing

When both probes and self-healing are enabled, the healer queries your local data service for production context before calling the AI. The prompt includes recent errors, typical inputs, and function call patterns -- producing fixes informed by how the function actually behaves in production.

<br />

## Quick Start

### Install

```bash
npm install -g @utopia-ai/cli
```

> **Requirements:** macOS, Node.js 18+, and either [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex CLI](https://github.com/openai/codex) installed.

### Setup

```bash
cd your-project
utopia init
```

Select your AI agent, capabilities (probes, self-healing, or both), cloud provider, and data capture depth. Utopia auto-detects your framework and language.

### Instrument

```bash
utopia instrument
```

One command handles everything based on the mode you selected:
- **Probes only** -- AI adds `// utopia:probe` blocks that capture runtime data
- **Self-healing only** -- AI adds `@utopia` decorators (Python) or `utopia()` wrappers (JS/TS)
- **Both** -- runs probes first, then self-healing, back-to-back

### Run

```bash
utopia serve -b      # Start the data service (if using probes)
npm run dev           # Start your app as usual
```

### Audit

```bash
utopia audit
```

Analyzes all collected probe data for security vulnerabilities. The AI agent reads your codebase and runtime data together, identifying issues that static analysis cannot detect.

### Agent integration

Your AI agent automatically checks Utopia's MCP tools when starting a session:

1. `get_pending_fixes` -- apply any self-healing fixes generated at runtime
2. `get_security_findings` -- review vulnerabilities detected from probe data
3. `get_recent_errors` -- see production errors with full context
4. `get_production_context` -- understand runtime behavior before modifying code

<br />

## Supported Frameworks

| Framework | Language | Probes | Self-Healing | Security Audit |
|-----------|----------|--------|--------------|----------------|
| **Next.js** | TypeScript / JavaScript | Yes | Yes | Yes |
| **React** | TypeScript / JavaScript | Yes | Yes | Yes |
| **Python** | FastAPI, Flask, Django | Yes | Yes | Yes |

<br />

## Supported AI Agents

| Agent | Integration |
|-------|-------------|
| **Claude Code** | MCP tools + CLAUDE.md instructions |
| **Codex (OpenAI)** | MCP tools + AGENTS.md instructions |

<br />

## CLI Reference

| Command | Description |
|---------|-------------|
| `utopia init` | Initialize Utopia in your project |
| `utopia instrument` | AI adds probes and/or self-healing decorators |
| `utopia audit` | AI analyzes runtime probe data for security vulnerabilities |
| `utopia audit --hours 48` | Analyze only the last 48 hours of probe data |
| `utopia reinstrument -p "purpose"` | Add targeted probes for a specific task |
| `utopia validate` | Verify probe syntax |
| `utopia serve -b` | Start the data service in the background |
| `utopia serve --stop` | Stop the data service |
| `utopia destruct` | Remove all probes and decorators |
| `utopia status` | Check probe counts, server health, configuration |

<br />

## What the Probes Capture

Probes capture the context an AI agent needs to understand runtime behavior and the evidence a security audit needs to identify vulnerabilities.

- **API calls** -- method, URL, status, duration, request/response shapes
- **Errors** -- type, message, stack trace, the exact input data that caused it
- **Function behavior** -- arguments, return values, which code path was taken and why
- **Database queries** -- SQL patterns, timing, row counts, parameterization status
- **Infrastructure** -- cloud provider, region, memory usage, environment config
- **Auth decisions** -- token validation results, permission checks, role verification

| Data Mode | What's captured |
|-----------|----------------|
| **Schemas & shapes** | Counts, types, field names, distributions -- no actual user data (GDPR/CCPA safe) |
| **Full data context** | Real inputs, outputs, DB results -- maximum visibility for debugging and security |

<br />

## MCP Tools

When you run `utopia init`, Utopia registers an MCP server with your AI agent:

| Tool | Purpose |
|------|---------|
| `get_pending_fixes` | Self-healing fixes ready to be permanently applied |
| `mark_fix_applied` | Mark a fix as applied after editing the source |
| `get_security_findings` | Security vulnerabilities detected from runtime probe data |
| `update_security_finding` | Mark a security finding as fixed or false positive |
| `get_recent_errors` | Errors with stack traces and the input data that caused them |
| `get_production_context` | Context relevant to a specific task or file |
| `get_full_context` | Complete production overview |
| `get_api_context` | External API call patterns, status codes, latencies |
| `get_database_context` | Database query patterns, timing, data shapes |
| `get_infrastructure_context` | Deployment environment, provider, region, config |
| `get_impact_analysis` | What is affected by changing a specific file or function |

<br />

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Your App    │────>│ Utopia Probes │────>│  Data Service    │
│  (running)   │     │ (in your code)│     │  (localhost:7890) │
└──────┬──────┘     └──────────────┘     └────────┬────────┘
       │                                           │
       │  @utopia / utopia() catches errors        │  utopia audit
       │  ────> OpenAI or Anthropic fixes them     │  ────> AI reads probe data
       │  ────> .utopia/fixes/                     │  ────> finds security vulns
       │                                           │  ────> stores findings
       │                                  ┌────────v────────┐
       │                                  │   MCP Server     │
       │                                  │  (utopia mcp)    │
       │                                  └────────┬────────┘
       │                                           │
       │                                  ┌────────v────────┐
       └─────────────────────────────────>│  AI Agent        │
         fixes + security findings        │  (Claude/Codex)  │
              flow back                   └─────────────────┘
```

- **Probes** are lightweight, non-blocking, and never throw. Background queue with circuit breaker.
- **Self-healing** captures function source, sends to OpenAI or Anthropic, compiles the fix, and re-runs with original args. Single attempt per error.
- **Probe-enriched healing** queries the local data service for production context before generating a fix.
- **Security audit** feeds runtime probe data to an AI agent that reads both the data and the source code to find vulnerabilities.
- **Data service** is a local Express + SQLite server. No cloud, no accounts, no external data transmission.
- **MCP server** exposes probe data, self-healing fixes, and security findings to your AI agent.

<br />

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `utopia: command not found` | `npm install -g @utopia-ai/cli` -- ensure npm global bin is in PATH |
| `utopia instrument` hangs | The AI agent is working (2-5 min per phase). Claude Code streams progress; Codex shows a spinner. |
| `Module not found: utopia-runtime` | Run `utopia instrument` again -- it installs the runtime automatically |
| `utopia audit` says "Could not fetch probe data" | Run your app with probes active first to generate data |
| Port 7890 in use | `utopia serve --stop && lsof -ti:7890 \| xargs kill && utopia serve -b` |
| MCP tools not available | Re-run `utopia init` to re-register the MCP server, then restart your agent session |

<br />

## Privacy & Security

- All probe data stays on your machine. The data service runs locally on `localhost:7890`.
- No cloud accounts, no telemetry, no data transmission to external services.
- Self-healing and security audit send function code and errors to OpenAI or Anthropic for analysis. No other data leaves your machine.
- Probes can be configured to capture schemas only (no PII) or full data context.
- Passwords, tokens, API keys, and secrets are never captured regardless of mode.
- `utopia destruct` removes all probes, decorators, and generated artifacts.

<br />

## Platform Support

| Platform | Status |
|----------|--------|
| **macOS** | Fully supported |
| **Linux** | Should work (not yet tested) |
| **Windows** | Not yet supported |

<br />

<div align="center">

**Built by [Paul Vann](https://github.com/vaulpann)**

</div>
