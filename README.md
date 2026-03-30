<div align="center">

# utopia

### Debug AI Generated Code at Lightning Speed

**Your code talks back to the AI agents that wrote it.**

[![npm version](https://img.shields.io/npm/v/@utopia-ai/cli.svg)](https://www.npmjs.com/package/@utopia-ai/cli)
[![PyPI version](https://img.shields.io/pypi/v/utopia-runtime.svg)](https://pypi.org/project/utopia-runtime/)


<br />

[![Watch the demo](https://img.youtube.com/vi/dibx_WX7PpA/maxresdefault.jpg)](https://www.youtube.com/watch?v=dibx_WX7PpA)

**Watch: Utopia in action** (click to play)

<br />

</div>

---

Utopia embeds intelligent probes into your codebase that capture how your code *actually runs* — errors, API calls, data shapes, auth flows, security patterns — and feeds that context directly to your AI coding agent. No more copying logs. No more explaining what went wrong. The agent already knows.

<br />

## How It Works

```
utopia init          →  Configure your project (30 seconds)
utopia instrument    →  AI adds probes to your codebase
utopia serve -b      →  Start the local data service
                     →  Run your app, browse around
                     →  AI agent queries probe data via MCP
                     →  Writes better code because it sees production
```

Utopia uses your AI agent (Claude Code or Codex) to analyze your codebase and decide where to place probes. The probes are contextual — they don't just log "API returned 200." They capture the response shape, what triggered the call, what data flowed through, and what decisions the code made at runtime.

When your agent works on the codebase next, it queries this data automatically before writing a single line of code.

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

You'll choose your AI agent, cloud provider, data capture depth, and probe focus. Utopia auto-detects your framework and language.

### Instrument

```bash
utopia instrument
```

Your AI agent analyzes the codebase and adds probes to high-value locations — API routes, auth flows, database calls, error boundaries, business logic. Takes 2-5 minutes depending on codebase size.

### Run

```bash
utopia serve -b      # Start the data service (background)
npm run dev           # Start your app as usual
```

Browse your app. Probes start capturing data immediately.

### See It Work

Open your AI agent in the project. Ask it to fix a bug or build a feature. It will automatically query Utopia's MCP tools *before* writing code — pulling in real production context about errors, data patterns, and runtime behavior.

```
You: "Getting errors on the /api/users endpoint, can you fix it?"

Agent: *queries get_recent_errors* → sees the exact error, stack trace,
       and the input data that caused it → fixes it in one shot
```

<br />

## Supported Frameworks

| Framework | Language | Status |
|-----------|----------|--------|
| **Next.js** | TypeScript / JavaScript | Fully supported |
| **React** | TypeScript / JavaScript | Fully supported |
| **Python** | FastAPI, Flask, Django | Fully supported |

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
| `utopia reinstrument -p "purpose"` | Add targeted probes for a specific task |
| `utopia validate` | Check that all probes have valid syntax |
| `utopia serve -b` | Start the data service in the background |
| `utopia serve --stop` | Stop the background data service |
| `utopia destruct` | Remove all probes and restore original files |
| `utopia status` | Check probe counts, server health, configuration |

### Examples

**Initial setup:**
```bash
utopia init
utopia instrument
utopia validate
utopia serve -b
```

**Add probes for a specific task:**
```bash
utopia reinstrument -p "debugging auth failures on the login endpoint"
utopia reinstrument -p "need to understand billing data flow before refactoring"
utopia reinstrument -p "investigating slow database queries on the dashboard"
```

**Clean removal:**
```bash
utopia destruct            # Remove all probes, restore original files
utopia destruct --dry-run  # Preview what would be removed
```

<br />

## What the Probes Capture

Utopia probes are not logs. They capture the context an AI agent needs to understand your code at runtime.

### Debugging Probes
- **API calls** — method, URL, status, duration, request/response shapes
- **Errors** — type, message, stack trace, *the exact input data that caused it*
- **Function behavior** — arguments, return values, which code path was taken and why
- **Database queries** — SQL patterns, timing, row counts, table access patterns
- **Infrastructure** — cloud provider, region, memory usage, environment config

### Security Probes
- **SQL injection detection** — captures whether queries use parameterized inputs
- **Auth flow analysis** — token validation decisions, permission checks, role verification
- **Input validation** — where user input enters the system, whether it's sanitized
- **Insecure patterns** — HTTP calls, exposed error details, missing rate limiting, CORS config

### Data Modes

| Mode | What's captured |
|------|----------------|
| **Schemas & shapes** | Counts, types, field names, distributions — no actual user data (GDPR/CCPA safe) |
| **Full data context** | Real inputs, outputs, DB results — maximum visibility for debugging |

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

### "Why is the dashboard slow?"

The agent queries `get_api_context` and sees:

```
GET contentful://cdn.contentful.com/getEntries
  Calls: 14  |  Avg: 1,256ms  |  Slowest: 2,107ms

POST posthog://feature-flag/new-landing-page
  Calls: 28  |  Avg: 0ms  |  Status: exception_fallback
```

Contentful is averaging 1.2s per call (too slow), and PostHog is failing silently on every request. The agent knows exactly what to optimize.

### "Add probes before refactoring billing"

```bash
utopia reinstrument -p "understand billing data flow, subscription states, and payment patterns"
```

The agent adds targeted probes to billing endpoints, subscription status checks, and payment processing. After running the app, it has full visibility into the billing system's runtime behavior before changing a single line.

<br />

## How the MCP Integration Works

When you run `utopia init`, Utopia registers an MCP server with your AI agent. This gives the agent these tools:

| MCP Tool | What it does |
|----------|--------------|
| `get_recent_errors` | Errors with stack traces and the input data that caused them |
| `get_production_context` | Context relevant to a specific task or file |
| `get_full_context` | Complete production overview — use at the start of any task |
| `get_api_context` | External API call patterns, status codes, latencies |
| `get_database_context` | Database query patterns, timing, data shapes |
| `get_infrastructure_context` | Deployment environment, provider, region, config |
| `get_impact_analysis` | What is affected by changing a specific file or function |

The agent is instructed (via CLAUDE.md or AGENTS.md) to **always** check these tools before writing code. It's not optional context — it's how the agent understands your production environment.

<br />

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Your App    │────▶│ Utopia Probes │────▶│  Data Service    │
│  (running)   │     │ (in your code)│     │  (localhost:7890) │
└─────────────┘     └──────────────┘     └────────┬────────┘
                                                   │
                                          ┌────────▼────────┐
                                          │   MCP Server     │
                                          │  (utopia mcp)    │
                                          └────────┬────────┘
                                                   │
                                          ┌────────▼────────┐
                                          │  AI Agent        │
                                          │  (Claude/Codex)  │
                                          └─────────────────┘
```

- **Probes** are lightweight, non-blocking, and never throw. They use a background queue with circuit breaker.
- **Data Service** is a local Express + SQLite server. No cloud, no accounts, no data leaves your machine.
- **MCP Server** translates agent queries into data service API calls with formatted, contextual responses.

<br />

## Troubleshooting

### `utopia: command not found`
```bash
npm install -g @utopia-ai/cli
```
Make sure your npm global bin is in your PATH. Check with `npm bin -g`.

### `utopia instrument` hangs with no output
The AI agent is working — it reads files, plans the instrumentation, then writes probes. This takes 2-5 minutes. For Claude Code, you'll see streaming progress. For Codex, you'll see a spinner with elapsed time.

### `Module not found: utopia-runtime` (JavaScript/TypeScript)
The runtime didn't install. Run `utopia instrument` again — it installs the runtime from npm (`utopia-runtime` package) automatically.

### `ModuleNotFoundError: No module named 'utopia_runtime'` (Python)
The runtime didn't install into your virtualenv. Run `utopia instrument` again — it installs from PyPI (`utopia-runtime` package) automatically.

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
This means you made code changes to files that also have probes. Utopia stripped the probes but kept your changes. This is expected and safe.

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
- Probes can be configured to capture schemas only (no PII) or full data context.
- Passwords, tokens, API keys, and secrets are never captured regardless of mode.
- `utopia destruct` cleanly removes all probes and restores your original files.

<br />


<div align="center">

**Built by [Paul Vann](https://github.com/paulvann)**

*code that talks back*

</div>
