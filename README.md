<div align="center">

# utopia

### Debug AI Generated Code at Lightning Speed

**Your code talks back to the AI agents that wrote it. And now it fixes itself.**

[![npm version](https://img.shields.io/npm/v/@utopia-ai/cli.svg)](https://www.npmjs.com/package/@utopia-ai/cli)
[![PyPI version](https://img.shields.io/pypi/v/utopia-runtime.svg)](https://pypi.org/project/utopia-runtime/)


<br />

[![Watch the demo](https://img.youtube.com/vi/dibx_WX7PpA/maxresdefault.jpg)](https://www.youtube.com/watch?v=dibx_WX7PpA)

**Watch: Utopia in action** (click to play)

<br />

</div>

---

Utopia does two things:

1. **Production probes** -- embeds intelligent observability into your codebase so AI agents see how code *actually runs* before writing a single line.
2. **Self-healing functions** -- a `@utopia` decorator that catches errors at runtime, generates AI-powered fixes via OpenAI, hot-patches them live, and logs everything so your coding agent can apply the permanent fix instantly.

No more copying logs. No more explaining what went wrong. The agent already knows -- and the fix might already be written.

<br />

## How It Works

### Production Probes

```
utopia init          ->  Configure your project (30 seconds)
utopia instrument    ->  AI adds probes to your codebase
utopia serve -b      ->  Start the local data service
                     ->  Run your app, browse around
                     ->  AI agent queries probe data via MCP
                     ->  Writes better code because it sees production
```

### Self-Healing Functions (Python)

```
utopia init          ->  Configure (select "Self-healing" or "Both")
utopia heal          ->  AI adds @utopia decorators to your functions
                     ->  Run your app
                     ->  Function crashes? Fixed at runtime via OpenAI
                     ->  Fix logged to .utopia/fixes/
                     ->  Open Claude Code -- fix is already there, ready to apply
```

<br />

## Self-Healing: The `@utopia` Decorator

This is the part that's new. Decorate any Python function with `@utopia` and it becomes self-healing:

```python
from utopia_runtime import utopia

@utopia
def process_payment(order_id: str, amount: float):
    charge = stripe.charges.create(amount=int(amount), currency="usd")
    return charge.id
```

If `process_payment` crashes at runtime:

1. Utopia catches the error before it kills your app
2. Sends the error, traceback, source code, and the exact arguments to OpenAI
3. OpenAI generates a fix
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

### What the Fix Log Looks Like

When a function self-heals, Utopia logs a JSON file and auto-generates `.utopia/FIXES.md`:

```
## Pending Fixes (1)

### `process_payment` -- TypeError
- File: `app/billing.py`
- Error: int() argument must be a string or real number, not 'NoneType'
- Explanation: Added None check for amount before converting to int

Original code:
    charge = stripe.charges.create(amount=int(amount), currency="usd")

Fixed code:
    if amount is None:
        raise ValueError("amount cannot be None")
    charge = stripe.charges.create(amount=int(amount * 100), currency="usd")
```

Your agent reads this via the `get_pending_fixes` MCP tool, applies the change, calls `mark_fix_applied`, and moves on.

### Works with Async Too

```python
@utopia
async def fetch_user(user_id: str):
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"/api/users/{user_id}")
        return resp.json()
```

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

### Instrument (Probes)

```bash
utopia instrument
```

Your AI agent analyzes the codebase and adds probes to high-value locations -- API routes, auth flows, database calls, error boundaries, business logic. Takes 2-5 minutes depending on codebase size.

### Heal (Self-Healing)

```bash
utopia heal
```

Your AI agent analyzes the codebase and adds `@utopia` decorators to functions that should self-heal -- API handlers, data processing, business logic, anything where an unexpected error would hurt. Requires `OPENAI_API_KEY` set at runtime.

### Run

```bash
utopia serve -b      # Start the data service (if using probes)
npm run dev           # Start your app as usual
```

Browse your app. Probes capture data. Self-healing catches errors. Both feed your agent.

### See It Work

Open your AI agent in the project. It will:

1. Check `get_pending_fixes` -- apply any self-healing fixes that were generated at runtime
2. Check `get_recent_errors` -- see what's been happening in production
3. Use that context to write better code

```
You: "Getting errors on the /api/users endpoint, can you fix it?"

Agent: *checks get_pending_fixes* -> fix already exists from self-healing
       -> applies it permanently -> done
```

<br />

## Supported Frameworks

| Framework | Language | Probes | Self-Healing |
|-----------|----------|--------|--------------|
| **Next.js** | TypeScript / JavaScript | Yes | Coming soon |
| **React** | TypeScript / JavaScript | Yes | Coming soon |
| **Python** | FastAPI, Flask, Django | Yes | Yes |

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
| `utopia instrument` | AI adds production probes to your codebase |
| `utopia heal` | AI adds self-healing `@utopia` decorators (Python) |
| `utopia reinstrument -p "purpose"` | Add targeted probes for a specific task |
| `utopia validate` | Check that all probes have valid syntax |
| `utopia serve -b` | Start the data service in the background |
| `utopia serve --stop` | Stop the background data service |
| `utopia destruct` | Remove all probes/decorators and restore original files |
| `utopia status` | Check probe counts, server health, configuration |

### Examples

**Probes + self-healing setup:**
```bash
utopia init              # Select "Both"
utopia instrument        # Add probes
utopia heal              # Add self-healing decorators
utopia validate
utopia serve -b
```

**Self-healing only:**
```bash
utopia init              # Select "Self-healing"
utopia heal
export OPENAI_API_KEY="sk-..."
python app.py            # Errors self-heal at runtime
```

**Add probes for a specific task:**
```bash
utopia reinstrument -p "debugging auth failures on the login endpoint"
utopia reinstrument -p "need to understand billing data flow before refactoring"
utopia reinstrument -p "investigating slow database queries on the dashboard"
```

**Clean removal:**
```bash
utopia destruct            # Remove all probes and decorators, restore original files
utopia destruct --dry-run  # Preview what would be removed
```

<br />

## What the Probes Capture

Utopia probes are not logs. They capture the context an AI agent needs to understand your code at runtime.

### Debugging Probes
- **API calls** -- method, URL, status, duration, request/response shapes
- **Errors** -- type, message, stack trace, *the exact input data that caused it*
- **Function behavior** -- arguments, return values, which code path was taken and why
- **Database queries** -- SQL patterns, timing, row counts, table access patterns
- **Infrastructure** -- cloud provider, region, memory usage, environment config

### Security Probes
- **SQL injection detection** -- captures whether queries use parameterized inputs
- **Auth flow analysis** -- token validation decisions, permission checks, role verification
- **Input validation** -- where user input enters the system, whether it's sanitized
- **Insecure patterns** -- HTTP calls, exposed error details, missing rate limiting, CORS config

### Data Modes

| Mode | What's captured |
|------|----------------|
| **Schemas & shapes** | Counts, types, field names, distributions -- no actual user data (GDPR/CCPA safe) |
| **Full data context** | Real inputs, outputs, DB results -- maximum visibility for debugging |

<br />

## Real-World Examples

### "Fix the auth redirect bug"

Without Utopia, the agent would need to run the app, reproduce the issue, read logs, and guess at the cause.

With Utopia, the agent queries `get_recent_errors` and immediately sees:

```
Error: NEXT_REDIRECT
File: app/login/route.ts:26
Data: { redirectUri: "https://staging.validia.ai/auth/callback",
        origin: "http://localhost:3000" }
```

The agent sees the redirect URI is hardcoded to staging instead of being computed from the request origin. Fix is immediate.

### "My Python app keeps crashing in production"

With self-healing enabled, it doesn't crash -- it fixes itself:

```
[utopia] healed: parse_webhook -- KeyError: 'event_type'
[utopia] fix logged to .utopia/fixes/parse_webhook_20260330_183406.json
```

The function kept running with the fix. When you open Claude Code:

```
Agent: *calls get_pending_fixes*
       -> Found 1 pending fix: parse_webhook accessed 'event_type'
          but the payload uses 'type'. Fixed with dict.get() fallback.
       -> Applied fix to app/webhooks.py
       -> Marked as applied. Done.
```

### "Why is the dashboard slow?"

The agent queries `get_api_context` and sees:

```
GET contentful://cdn.contentful.com/getEntries
  Calls: 14  |  Avg: 1,256ms  |  Slowest: 2,107ms

POST posthog://feature-flag/new-landing-page
  Calls: 28  |  Avg: 0ms  |  Status: exception_fallback
```

Contentful is averaging 1.2s per call (too slow), and PostHog is failing silently on every request. The agent knows exactly what to optimize.

<br />

## How the MCP Integration Works

When you run `utopia init`, Utopia registers an MCP server with your AI agent. This gives the agent these tools:

| MCP Tool | What it does |
|----------|--------------|
| `get_pending_fixes` | Self-healing fixes ready to be permanently applied |
| `mark_fix_applied` | Mark a fix as applied after editing the source |
| `get_recent_errors` | Errors with stack traces and the input data that caused them |
| `get_production_context` | Context relevant to a specific task or file |
| `get_full_context` | Complete production overview -- use at the start of any task |
| `get_api_context` | External API call patterns, status codes, latencies |
| `get_database_context` | Database query patterns, timing, data shapes |
| `get_infrastructure_context` | Deployment environment, provider, region, config |
| `get_impact_analysis` | What is affected by changing a specific file or function |

The agent is instructed (via CLAUDE.md or AGENTS.md) to **always** check `get_pending_fixes` first, then production context before writing code. It's not optional context -- it's how the agent understands your codebase.

<br />

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Your App    │────>│ Utopia Probes │────>│  Data Service    │
│  (running)   │     │ (in your code)│     │  (localhost:7890) │
└──────┬──────┘     └──────────────┘     └────────┬────────┘
       │                                           │
       │  @utopia catches errors                   │
       │  ────> OpenAI fixes them                  │
       │  ────> .utopia/fixes/                     │
       │                                  ┌────────v────────┐
       │                                  │   MCP Server     │
       │                                  │  (utopia mcp)    │
       │                                  └────────┬────────┘
       │                                           │
       │                                  ┌────────v────────┐
       └─────────────────────────────────>│  AI Agent        │
              fixes flow back             │  (Claude/Codex)  │
                                          └─────────────────┘
```

- **Probes** are lightweight, non-blocking, and never throw. They use a background queue with circuit breaker.
- **Self-healing** uses `inspect.getsource()` to capture the function, sends to OpenAI for debugging, compiles the fix with `exec()`, and re-runs with original args. One attempt only -- no infinite loops.
- **Data Service** is a local Express + SQLite server. No cloud, no accounts, no data leaves your machine.
- **MCP Server** serves both probe data and self-healing fixes to your AI agent.

<br />

## Configuration

### Self-Healing Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | (required) | Your OpenAI API key for generating fixes |
| `UTOPIA_MODEL` | `gpt-4o` | Which model to use for fix generation |
| `UTOPIA_BASE_URL` | `https://api.openai.com` | Custom API endpoint (for proxies) |

Or configure in code:

```python
from utopia_runtime import configure
configure(api_key="sk-...", model="gpt-4o-mini")
```

<br />

## Troubleshooting

### `utopia: command not found`
```bash
npm install -g @utopia-ai/cli
```
Make sure your npm global bin is in your PATH. Check with `npm bin -g`.

### `utopia instrument` or `utopia heal` hangs with no output
The AI agent is working -- it reads files, plans the changes, then writes them. This takes 2-5 minutes depending on codebase size. For Claude Code, you'll see streaming progress. For Codex, you'll see a spinner with elapsed time.

### `Module not found: utopia-runtime` (JavaScript/TypeScript)
The runtime didn't install. Run `utopia instrument` again -- it installs the runtime from npm (`utopia-runtime` package) automatically.

### `ModuleNotFoundError: No module named 'utopia_runtime'` (Python)
The runtime didn't install into your environment. Run `utopia instrument` or `utopia heal` again -- it installs from PyPI (`utopia-runtime` package) automatically. If using a virtualenv, make sure it's activated.

### Pydantic `Extra inputs are not permitted` error (Python)
Old Utopia env vars in your `.env` file are conflicting with Pydantic Settings. Utopia no longer writes env vars for Python projects (it reads from `.utopia/config.json` instead). Remove any `UTOPIA_ENDPOINT` or `UTOPIA_PROJECT_ID` lines from your `.env`.

### `utopia serve -b` says port 7890 is in use
```bash
utopia serve --stop          # Try stopping the existing server
lsof -ti:7890 | xargs kill  # Force kill whatever is on that port
utopia serve -b              # Start fresh
```

### MCP tools not available in Claude Code / Codex
Re-run `utopia init` to re-register the MCP server. Then restart your AI agent session. The MCP server must be registered with the agent before it can use the tools.

### `utopia destruct` shows "user changes preserved"
This means you made code changes to files that also have probes or decorators. Utopia stripped the Utopia-specific code but kept your changes. This is expected and safe.

### Probes not sending data (0 probes in server)
1. Is the server running? Check: `curl http://localhost:7890/api/v1/health`
2. For JS/TS: Are the env vars set? Check `.env.local` has `UTOPIA_ENDPOINT` and `UTOPIA_PROJECT_ID`
3. For Python: Does `.utopia/config.json` exist in the project root?
4. Did you restart your app after instrumenting?

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
- Self-healing sends function code + errors to OpenAI's API for fix generation. No other data leaves your machine.
- Probes can be configured to capture schemas only (no PII) or full data context.
- Passwords, tokens, API keys, and secrets are never captured regardless of mode.
- `utopia destruct` cleanly removes all probes, decorators, and fix logs.

<br />


<div align="center">

**Built by [Paul Vann](https://github.com/vaulpann)**

*code that talks back -- and fixes itself*

</div>
