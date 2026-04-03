<div align="center">

# utopia

### Debug AI Generated Code at Lightning Speed

**Your code talks back to the AI agents that wrote it. It fixes itself. And it finds vulnerabilities static analysis can't.**

[![npm version](https://img.shields.io/npm/v/@utopia-ai/cli.svg)](https://www.npmjs.com/package/@utopia-ai/cli)
[![PyPI version](https://img.shields.io/pypi/v/utopia-runtime.svg)](https://pypi.org/project/utopia-runtime/)


<br />

[![Watch the demo](https://img.youtube.com/vi/dibx_WX7PpA/maxresdefault.jpg)](https://www.youtube.com/watch?v=dibx_WX7PpA)

**Watch: Utopia in action** (click to play)

<br />

</div>

---

Utopia does three things:

1. **Production probes** -- embeds intelligent observability into your codebase so AI agents see how code *actually runs* before writing a single line.
2. **Self-healing functions** -- wraps your functions so they catch errors at runtime, generate AI-powered fixes via OpenAI or Anthropic, hot-patch them live, and log everything so your coding agent can apply the permanent fix instantly.
3. **Runtime security audit** -- analyzes actual production data (API calls, database queries, auth decisions, data flows) to find vulnerabilities that static analysis tools miss completely.

No more copying logs. No more explaining what went wrong. The agent already knows -- the fix might already be written, and the vulnerabilities are already found.

<br />

## How It Works

```
utopia init          ->  Configure your project (30 seconds)
utopia instrument    ->  AI adds probes + self-healing to your codebase
utopia serve -b      ->  Start the local data service
                     ->  Run your app, browse around
                     ->  Function crashes? Fixed at runtime by AI
                     ->  Fix logged to .utopia/fixes/
                     ->  AI agent queries probe data + pending fixes via MCP
utopia audit         ->  AI analyzes runtime data for security vulnerabilities
```

`utopia instrument` handles probes and self-healing in one command. `utopia audit` uses the probe data to find security issues that no static analysis tool could catch -- because it's looking at what your code *actually does* at runtime, not what it looks like on paper.

<br />

## Runtime Security Audit

This is the thing no one else does. Every security tool today either scans code (static) or scans network traffic (DAST). Nobody analyzes the *semantic runtime behavior* -- what the code actually does with data, how auth decisions flow, what shapes cross trust boundaries.

Utopia's probes capture all of that. `utopia audit` feeds it to an AI agent for deep security analysis.

```bash
utopia audit
```

### What it finds (real examples from production apps)

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

### Why this works

Static analysis sees `return user` and doesn't know what `user` contains. Utopia's probes captured the actual response shape -- and the AI spotted that `password_hash` was in it.

Static analysis sees a `try/catch` and assumes errors are handled. Utopia's probes captured that the catch block is re-throwing raw upstream error bodies to the client.

Static analysis sees an auth middleware import. Utopia's probes captured that it only runs on `/api/*` routes, not on the routes that actually need it.

**The probe data is the evidence. The AI is the analyst.**

### How findings reach your agent

After `utopia audit`, findings are stored in the data service. Your AI agent sees them via the `get_security_findings` MCP tool:

```
You: "Any security issues?"

Agent: *calls get_security_findings*
       -> Found 3 findings: auth bypass (critical), SQL injection (high),
          Host header injection (medium)
       -> Reads evidence, applies fixes, marks findings as resolved
```

<br />

## Self-Healing Functions

Wrap any function and it becomes self-healing. Works with Python (`@utopia` decorator) and JavaScript/TypeScript (`utopia()` wrapper).

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

### What happens when it crashes

1. Utopia catches the error before it kills your app
2. Sends the error, traceback, source code, and the exact arguments to OpenAI or Anthropic
3. The AI generates a fix
4. The fix is compiled and re-executed at runtime -- your app keeps running
5. The fix is logged to `.utopia/fixes/` with the original code, fixed code, and explanation
6. Next time you open Claude Code or Codex, the MCP server serves the fix. The agent applies it permanently. Done.

**The bug is solved before you even look at it.**

### Intentional Errors Pass Through

Not every exception is a bug. Use `ignore` to let intentional errors through:

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

### Multi-Provider Support

Self-healing works with both OpenAI and Anthropic. It auto-detects which key you have set:

| Variable | Provider | Default Model |
|----------|----------|---------------|
| `OPENAI_API_KEY` | OpenAI | `gpt-4o` |
| `ANTHROPIC_API_KEY` | Anthropic | `claude-sonnet-4-20250514` |

### Probe-Enriched Healing

When both probes and self-healing are enabled, the healer queries your local Utopia data service for production context *before* calling the AI. The prompt includes recent errors, typical inputs, and function call patterns -- so the generated fix is informed by how the function actually behaves in production, not just the code and the error.

<br />

## Quick Start

### Install

```bash
npm install -g @utopia-ai/cli
```

> **Requirements:** macOS, Node.js 18+, and either [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex CLI](https://github.com/openai/codex) installed.

### Setup (30 seconds)

```bash
cd your-project
utopia init
```

You'll choose your AI agent, capabilities (probes, self-healing, or both), cloud provider, and data capture depth. Utopia auto-detects your framework and language.

### Instrument

```bash
utopia instrument
```

One command does everything based on the mode you selected:
- **Probes only** -- AI adds `// utopia:probe` blocks that capture runtime data
- **Self-healing only** -- AI adds `@utopia` decorators (Python) or `utopia()` wrappers (JS/TS)
- **Both** -- runs probes first, then self-healing, back-to-back

### Run

```bash
utopia serve -b      # Start the data service (if using probes)
npm run dev           # Start your app as usual
```

Browse your app. Probes capture data. Self-healing catches errors. Both feed your agent.

### Audit

```bash
utopia audit
```

Analyzes all collected probe data for security vulnerabilities. Your AI agent reads the codebase and the runtime data together -- finding issues that static analysis misses because it sees what the code *actually does*.

### See It Work

Open your AI agent in the project. It will:

1. Check `get_pending_fixes` -- apply any self-healing fixes from runtime
2. Check `get_security_findings` -- see vulnerabilities detected from probe data
3. Check `get_recent_errors` -- see what's been happening in production
4. Use all that context to write better, more secure code

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

### Core Commands

| Command | Description |
|---------|-------------|
| `utopia init` | Initialize Utopia in your project |
| `utopia instrument` | AI adds probes and/or self-healing decorators to your codebase |
| `utopia audit` | AI analyzes runtime probe data for security vulnerabilities |
| `utopia reinstrument -p "purpose"` | Add targeted probes for a specific task |
| `utopia validate` | Check that all probes have valid syntax |
| `utopia serve -b` | Start the data service in the background |
| `utopia serve --stop` | Stop the background data service |
| `utopia destruct` | Remove all probes/decorators and restore original files |
| `utopia status` | Check probe counts, server health, configuration |

### Examples

**Full setup (probes + self-healing + audit):**
```bash
utopia init              # Select "Both"
utopia instrument        # Adds probes, then self-healing decorators
utopia serve -b          # Start data service
# Run your app, browse around, generate probe data
utopia audit             # AI security analysis on the collected data
```

**Self-healing only:**
```bash
utopia init              # Select "Self-healing"
utopia instrument        # Adds self-healing decorators only
export OPENAI_API_KEY="sk-..."
python app.py            # Errors self-heal at runtime
```

**Security audit on an existing instrumented project:**
```bash
utopia audit             # Analyzes all probe data for vulnerabilities
utopia audit --hours 48  # Only analyze last 48 hours of data
```

**Clean removal:**
```bash
utopia destruct            # Remove all probes and decorators, restore original files
```

<br />

## What the Probes Capture

Utopia probes are not logs. They capture the context an AI agent needs to understand your code at runtime -- and the evidence a security audit needs to find real vulnerabilities.

### Runtime Data
- **API calls** -- method, URL, status, duration, request/response shapes
- **Errors** -- type, message, stack trace, *the exact input data that caused it*
- **Function behavior** -- arguments, return values, which code path was taken and why
- **Database queries** -- SQL patterns, timing, row counts, parameterization status
- **Infrastructure** -- cloud provider, region, memory usage, environment config
- **Auth decisions** -- token validation results, permission checks, role verification

### Data Modes

| Mode | What's captured |
|------|----------------|
| **Schemas & shapes** | Counts, types, field names, distributions -- no actual user data (GDPR/CCPA safe) |
| **Full data context** | Real inputs, outputs, DB results -- maximum visibility for debugging and security |

<br />

## How the MCP Integration Works

When you run `utopia init`, Utopia registers an MCP server with your AI agent. This gives the agent these tools:

| MCP Tool | What it does |
|----------|--------------|
| `get_pending_fixes` | Self-healing fixes ready to be permanently applied |
| `mark_fix_applied` | Mark a fix as applied after editing the source |
| `get_security_findings` | Security vulnerabilities detected from runtime probe data |
| `update_security_finding` | Mark a security finding as fixed or false positive |
| `get_recent_errors` | Errors with stack traces and the input data that caused them |
| `get_production_context` | Context relevant to a specific task or file |
| `get_full_context` | Complete production overview -- use at the start of any task |
| `get_api_context` | External API call patterns, status codes, latencies |
| `get_database_context` | Database query patterns, timing, data shapes |
| `get_infrastructure_context` | Deployment environment, provider, region, config |
| `get_impact_analysis` | What is affected by changing a specific file or function |

The agent is instructed (via CLAUDE.md or AGENTS.md) to check `get_pending_fixes` and `get_security_findings` first, then production context before writing code.

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

- **Probes** are lightweight, non-blocking, and never throw. They use a background queue with circuit breaker.
- **Self-healing** captures the function source, sends to OpenAI or Anthropic for debugging, compiles the fix, and re-runs with original args. One attempt only -- no infinite loops.
- **Probe-enriched healing** -- when both features are active, the healer queries the local data service for production context before generating a fix.
- **Security audit** -- the AI agent reads actual runtime probe data (API calls, DB queries, auth flows, data shapes) and finds vulnerabilities that static analysis can't see.
- **Data Service** is a local Express + SQLite server. No cloud, no accounts, no data leaves your machine.
- **MCP Server** serves probe data, self-healing fixes, and security findings to your AI agent.

<br />

## Troubleshooting

### `utopia: command not found`
```bash
npm install -g @utopia-ai/cli
```
Make sure your npm global bin is in your PATH. Check with `npm bin -g`.

### `utopia instrument` hangs with no output
The AI agent is working -- it reads files, plans the changes, then writes them. This takes 2-5 minutes per phase depending on codebase size. For Claude Code, you'll see streaming progress. For Codex, you'll see a spinner with elapsed time.

### `Module not found: utopia-runtime` (JavaScript/TypeScript)
Run `utopia instrument` again -- it installs the runtime from npm automatically.

### `ModuleNotFoundError: No module named 'utopia_runtime'` (Python)
Run `utopia instrument` again -- it installs from PyPI automatically. If using a virtualenv, make sure it's activated.

### `utopia audit` says "Could not fetch probe data"
Your app needs to be running with probes active so there's data to analyze. Run your app, use it for a bit, then run `utopia audit`.

### `utopia serve -b` says port 7890 is in use
```bash
utopia serve --stop
lsof -ti:7890 | xargs kill
utopia serve -b
```

### MCP tools not available in Claude Code / Codex
Re-run `utopia init` to re-register the MCP server. Then restart your AI agent session.

<br />

## Platform Support

| Platform | Status |
|----------|--------|
| **macOS** | Fully supported |
| **Linux** | Should work (not yet tested) |
| **Windows** | Not yet supported |

<br />

## Privacy & Security

- All data stays on your machine. The data service runs locally on `localhost:7890`.
- No cloud accounts, no telemetry, no data transmission to external services.
- Self-healing and security audit send function code + errors to OpenAI or Anthropic. No other data leaves your machine.
- Probes can be configured to capture schemas only (no PII) or full data context.
- Passwords, tokens, API keys, and secrets are never captured regardless of mode.
- `utopia destruct` cleanly removes all probes, decorators, and fix logs.

<br />


<div align="center">

**Built by [Paul Vann](https://github.com/vaulpann)**

*code that talks back, fixes itself, and watches its own back*

</div>
