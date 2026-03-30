# Contributing to Utopia

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/vaulpann/utopia.git
cd utopia
npm install
npm link  # Makes `utopia` available globally from source
```

## Project Structure

```
utopia/
├── bin/                    # CLI entry point
├── src/
│   ├── cli/               # CLI commands (init, instrument, serve, etc.)
│   │   ├── commands/      # Each command is its own file
│   │   └── utils/         # Shared utilities (config, etc.)
│   ├── server/            # Express + SQLite data service
│   ├── mcp/               # MCP server for Claude Code / Codex
│   ├── runtime/js/        # JavaScript/TypeScript probe runtime (published to npm)
│   ├── instrumenter/      # AST-based instrumenter (legacy, not primary path)
│   └── graph/             # Impact graph engine
├── python/
│   └── utopia_runtime/    # Python probe runtime (published to PyPI)
└── scripts/               # Publish scripts
```

## Key Concepts

- **Probes are added by AI agents**, not by AST transforms. The `instrument` command spawns Claude Code or Codex with a detailed prompt.
- **The runtime is lightweight and never throws.** Every probe call is wrapped in try/catch. Background queue with circuit breaker.
- **The data service is local-only.** SQLite + Express on localhost. No auth, no cloud.
- **MCP tools are how agents query probe data.** The MCP server translates tool calls into data service API requests.

## Making Changes

1. Fork the repo
2. Create a branch: `git checkout -b my-feature`
3. Make changes
4. Type check: `npx tsc --noEmit`
5. Test locally: `npm link && utopia init` in a test project
6. Submit a PR

## Publishing

Runtime packages are published separately from the CLI:

```bash
# CLI
npm version patch && npm publish --access public

# JS runtime
cd src/runtime/js && npm version patch && npm publish

# Python runtime
cd python && ./scripts/publish-pypi.sh
```

## Questions?

Open an issue at https://github.com/vaulpann/utopia/issues
