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
2. **Self-healing functions** -- wraps your functions so they catch errors at runtime, generate AI-powered fixes via OpenAI or Anthropic, hot-patch them live, and log everything so your coding agent can apply the permanent fix instantly.

No more copying logs. No more explaining what went wrong. The agent already knows -- and the fix might already be written.

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
                     ->  Writes better code because it sees production
```

`utopia instrument` handles everything in one command. Based on the mode you chose in `utopia init` (probes, self-healing, or both), it runs the appropriate agent sessions back-to-back.

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

Override with `UTOPIA_PROVIDER`, `UTOPIA_MODEL`, or in code:

```python
from utopia_runtime import configure
configure(provider="anthropic", anthropic_api_key="sk-ant-...", model="claude-sonnet-4-20250514")
```

### Probe-Enriched Healing

When both probes and self-healing are enabled, the healer queries your local Utopia data service for production context *before* calling the AI. The prompt includes recent errors, typical inputs, and function call patterns -- so the generated fix is informed by how the function actually behaves in production, not just the code and the error.

If the data service isn't running or probes aren't enabled, healing still works -- it just uses the code + error context alone.

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

Takes 2-5 minutes per phase depending on codebase size.

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
| **Next.js** | TypeScript / JavaScript | Yes | Yes |
| **React** | TypeScript / JavaScript | Yes | Yes |
| **Python** | FastAPI, Flask, Django | Yes | Yes |

<br />

## Supported AI Agents

| Agent | Integration |
|-------|-------------|
| **Claude Code** | MCP tools + CLAUDE.md instructions |
| **Codex (OpenAI)** | MCP tools + AGENTS.md instructions |

<br />

## Supported Healing Providers

| Provider | Env Variable | Default Model |
|----------|-------------|---------------|
| **OpenAI** | `OPENAI_API_KEY` | `gpt-4o` |
| **Anthropic** | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` |

Set `UTOPIA_PROVIDER=anthropic` to force Anthropic, or let Utopia auto-detect from whichever key is available.

<br />

## CLI Reference

### Core Commands

| Command | Description |
|---------|-------------|
| `utopia init` | Initialize Utopia in your project |
| `utopia instrument` | AI adds probes and/or self-healing decorators to your codebase |
| `utopia reinstrument -p "purpose"` | Add targeted probes for a specific task |
| `utopia validate` | Check that all probes have valid syntax |
| `utopia serve -b` | Start the data service in the background |
| `utopia serve --stop` | Stop the background data service |
| `utopia destruct` | Remove all probes/decorators and restore original files |
| `utopia status` | Check probe counts, server health, configuration |

### Examples

**Full setup (probes + self-healing):**
```bash
utopia init              # Select "Both"
utopia instrument        # Adds probes, then self-healing decorators
utopia validate
utopia serve -b
```

**Self-healing only:**
```bash
utopia init              # Select "Self-healing"
utopia instrument        # Adds self-healing decorators only
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

### "My app keeps crashing in production"

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
       │  @utopia / utopia() catches errors        │
       │  ────> OpenAI or Anthropic fixes them     │
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
- **Self-healing** captures the function source, sends to OpenAI or Anthropic for debugging, compiles the fix, and re-runs with original args. One attempt only -- no infinite loops. `RecursionError`, `SystemExit`, `KeyboardInterrupt`, and `MemoryError` always pass through.
- **Probe-enriched healing** -- when both features are active, the healer queries the local data service for production context before generating a fix. The AI sees not just the error, but how the function normally behaves.
- **Data Service** is a local Express + SQLite server. No cloud, no accounts, no data leaves your machine.
- **MCP Server** serves both probe data and self-healing fixes to your AI agent.

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
The runtime didn't install. Run `utopia instrument` again -- it installs the runtime from npm (`utopia-runtime` package) automatically.

### `ModuleNotFoundError: No module named 'utopia_runtime'` (Python)
The runtime didn't install into your environment. Run `utopia instrument` again -- it installs from PyPI (`utopia-runtime` package) automatically. If using a virtualenv, make sure it's activated.

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
- Self-healing sends function code + errors to OpenAI or Anthropic for fix generation. No other data leaves your machine.
- Probes can be configured to capture schemas only (no PII) or full data context.
- Passwords, tokens, API keys, and secrets are never captured regardless of mode.
- `utopia destruct` cleanly removes all probes, decorators, and fix logs.

<br />


<div align="center">

**Built by [Paul Vann](https://github.com/vaulpann)**

*code that talks back -- and fixes itself*

</div>
