# Contributing to Utopia

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/vaulpann/utopia.git
cd utopia
npm install
npm run build
npm link  # Makes `utopia` available globally from source
```

After making changes to TypeScript files, run `npm run build` to recompile.

## Project Structure

```
utopia/
├── bin/                    # CLI entry point
├── src/
│   ├── cli/               # CLI commands (init, instrument, heal, serve, etc.)
│   │   ├── commands/      # Each command is its own file
│   │   └── utils/         # Shared utilities (config types, load/save)
│   ├── server/            # Express + SQLite data service
│   ├── mcp/               # MCP server for Claude Code / Codex
│   ├── runtime/js/        # JavaScript/TypeScript probe runtime (published to npm)
│   ├── instrumenter/      # AST-based instrumenter (legacy, not primary path)
│   ├── graph/             # Impact graph engine
│   └── utopia-mode/       # Selective async LLM context capture
├── python/
│   └── utopia_runtime/    # Python runtime — probes + self-healing (published to PyPI)
│       ├── probe.py       # Probe engine (background queue, circuit breaker)
│       ├── client.py      # HTTP client for sending probe data
│       ├── decorator.py   # @utopia self-healing decorator
│       ├── healer.py      # OpenAI API integration for fix generation
│       └── fix_log.py     # Fix logging to .utopia/fixes/ and FIXES.md
└── scripts/               # Publish scripts
```

## Key Concepts

### Probes (Observability)

- **Probes are added by AI agents**, not by AST transforms. The `instrument` command spawns Claude Code or Codex with a detailed prompt that teaches it how to place probes.
- **The runtime is lightweight and never throws.** Every probe call is wrapped in try/catch. Background queue with circuit breaker.
- **The data service is local-only.** SQLite + Express on localhost. No auth, no cloud.
- **MCP tools are how agents query probe data.** The MCP server translates tool calls into data service API requests.

### Self-Healing (The `@utopia` Decorator)

- **Self-healing is part of the same `utopia-runtime` package** on PyPI. No separate SDK.
- **The `heal` command spawns an AI agent** to add `@utopia` decorators to Python functions, same pattern as `instrument`.
- **The decorator uses only stdlib** (`urllib`, `inspect`, `json`). No external dependencies. The OpenAI API is called via raw `urllib.request`.
- **Fix logging writes to `.utopia/fixes/`** as JSON files + a `FIXES.md` summary. The MCP server reads these via `get_pending_fixes` and `mark_fix_applied` tools.
- **Decorators preserve through fix logs.** When a fix is logged, `_preserve_decorators()` ensures `@utopia` (and any other decorators) are included in the fixed code so agents don't accidentally strip them.
- **The `ignore` parameter** lets functions declare which exception types are intentional (e.g. `@utopia(ignore=[ValueError])`). Only unexpected errors trigger self-healing.

### Modes

`utopia init` asks the user to choose a mode:

| Mode | What it enables |
|------|----------------|
| `instrument` | Production probes only |
| `heal` | Self-healing decorators only |
| `both` | Probes + self-healing |

The mode is stored in `.utopia/config.json` as `utopiaMode` and determines:
- Which questions `init` asks (data mode and probe goal are skipped for heal-only)
- What goes into CLAUDE.md / AGENTS.md
- What `destruct` removes

## Making Changes

1. Fork the repo
2. Create a branch: `git checkout -b my-feature`
3. Make changes
4. Type check: `npx tsc --noEmit`
5. Test locally: `npm run build && npm link`, then `utopia init` in a test project
6. Submit a PR

### Testing Self-Healing Changes

If you're modifying the Python runtime (`python/utopia_runtime/`):

```bash
# Install into a test project's venv
cd test-project
.venv/bin/pip install /path/to/utopia/python/

# Run and verify
.venv/bin/python3 your_script.py
```

## Publishing

The CLI and Python runtime are published separately:

```bash
# CLI (npm)
npm version patch
npm run build
npm publish --access public

# Python runtime (PyPI)
bash scripts/publish-pypi.sh
```

Version numbers should stay in sync between `package.json`, `src/cli/index.ts`, `python/pyproject.toml`, and `python/utopia_runtime/__init__.py`.

## Questions?

Open an issue at https://github.com/vaulpann/utopia/issues
