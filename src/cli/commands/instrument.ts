import { Command } from 'commander';
import chalk from 'chalk';
import { resolve, dirname } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, configExists } from '../utils/config.js';
import type { UtopiaConfig } from '../utils/config.js';

// ---------------------------------------------------------------------------
// Shared: runtime API docs (used by both instrument and reinstrument)
// ---------------------------------------------------------------------------

const RUNTIME_API_DOCS = `
## Utopia Runtime API

Import: \`import { __utopia } from 'utopia-runtime';\`
You MUST add this import to any file you add probes to.

All methods are async, non-blocking, and NEVER throw.

CRITICAL: Do NOT call \`__utopia()\` as a function. It is an OBJECT with methods. Always call \`__utopia.reportFunction()\`, \`__utopia.reportApi()\`, etc.

### Available methods with EXACT TypeScript signatures:

\`\`\`typescript
__utopia.reportFunction(data: {
  file: string;           // REQUIRED — the source file path
  line: number;           // REQUIRED — line number
  functionName: string;   // REQUIRED — name of the function
  args: unknown[];        // REQUIRED — MUST be an array, e.g. [{ key: "value" }]
  returnValue?: unknown;  // optional — what the function returned
  duration: number;       // REQUIRED — milliseconds
  callStack: string[];    // REQUIRED — can be empty array []
})

__utopia.reportApi(data: {
  file: string;           // REQUIRED
  line: number;           // REQUIRED
  functionName: string;   // REQUIRED
  method: string;         // REQUIRED — "GET", "POST", etc.
  url: string;            // REQUIRED — the URL called
  statusCode?: number;    // optional — HTTP status
  duration: number;       // REQUIRED — milliseconds
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseBody?: unknown;
  error?: string;
})

__utopia.reportError(data: {
  file: string;           // REQUIRED
  line: number;           // REQUIRED
  functionName: string;   // REQUIRED
  errorType: string;      // REQUIRED — e.g. "TypeError"
  message: string;        // REQUIRED — error message
  stack: string;          // REQUIRED — stack trace, use "" if unavailable
  inputData: Record<string, unknown>; // REQUIRED — what input caused the error
  codeLine: string;       // REQUIRED — the code that failed, use "" if unavailable
})

__utopia.reportInfra(data: {
  file: string;           // REQUIRED
  line: number;           // REQUIRED
  provider: string;       // REQUIRED — "vercel", "aws", "gcp", etc.
  region?: string;
  serviceType?: string;
  instanceId?: string;
  envVars: Record<string, string>; // REQUIRED — filtered env vars (no secrets!)
  memoryUsage: number;    // REQUIRED — bytes, use 0 if unavailable
})
\`\`\`

### EXACT code examples — copy these patterns:

**reportFunction (most common — use for data shapes, decisions, config):**
\`\`\`typescript
// utopia:probe
try {
  __utopia.reportFunction({
    file: 'lib/flags.ts', line: 10, functionName: 'isFeatureEnabled',
    args: [{ flagName, userId }],
    returnValue: { enabled: result, reason: error ? 'exception' : 'evaluated' },
    duration: Date.now() - __utopia_start,
    callStack: [],
  });
} catch { /* probe error — swallow silently */ }
\`\`\`

**reportApi (for HTTP calls):**
\`\`\`typescript
// utopia:probe
try {
  __utopia.reportApi({
    file: 'lib/api-client.ts', line: 25, functionName: 'customFetch',
    method: method || 'GET',
    url: urlString,
    statusCode: response.status,
    duration: Date.now() - __utopia_start,
  });
} catch { /* probe error — swallow silently */ }
\`\`\`

**reportError (for catch blocks):**
\`\`\`typescript
// utopia:probe
try {
  __utopia.reportError({
    file: 'app/layout.tsx', line: 50, functionName: 'AuthLayout',
    errorType: err instanceof Error ? err.constructor.name : 'UnknownError',
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack || '' : '',
    inputData: { userId, path },
    codeLine: '',
  });
} catch { /* probe error — swallow silently */ }
\`\`\`

**reportInfra (for entry points, once on startup):**
\`\`\`typescript
// utopia:probe
try {
  __utopia.reportInfra({
    file: 'app/layout.tsx', line: 5, provider: 'vercel',
    region: process.env.VERCEL_REGION,
    envVars: Object.fromEntries(
      Object.entries(process.env).filter(([k]) =>
        !k.includes('KEY') && !k.includes('SECRET') && !k.includes('TOKEN')
      ).map(([k, v]) => [k, String(v)])
    ),
    memoryUsage: typeof process !== 'undefined' && process.memoryUsage ? process.memoryUsage().heapUsed : 0,
  });
} catch { /* probe error — swallow silently */ }
\`\`\`
`;

function buildProbeRules(config: UtopiaConfig): string {
  const base = `
## CRITICAL Rules — Follow Exactly

1. ALWAYS call \`__utopia.reportFunction()\`, \`__utopia.reportApi()\`, etc. — NEVER \`__utopia()\`
2. EVERY probe call MUST be wrapped in \`try { ... } catch { /* probe error */ }\`
3. Add \`// utopia:probe\` comment before each probe's try block
4. \`args\` MUST be an array: \`args: [{ key: value }]\` NOT \`args: { key: value }\`
5. \`callStack\` MUST be an array: \`callStack: []\`
6. \`duration\` MUST be a number (milliseconds). Use \`const __utopia_start = Date.now();\` before the operation
7. Never log passwords, tokens, API keys, or secrets
8. Never await a probe call — fire and forget
9. Get it right the first time — do NOT use incorrect API patterns and then fix them
`;

  const dataRules = config.dataMode === 'full' ? `
## Data Collection: FULL CONTEXT MODE

Capture REAL data in probes — actual inputs, outputs, DB results, request/response bodies. This gives maximum visibility.

- Capture actual function arguments and return values
- Capture real DB query results (row data, not just counts)
- Capture request/response bodies for API calls
- Capture real user inputs and form data
- Still NEVER log passwords, tokens, API keys, or secrets
- Truncate very large payloads (>1KB) to avoid bloating probe data
` : `
## Data Collection: SCHEMAS & SHAPES ONLY

Probes MUST anonymize all user/customer data. Capture structure, not content.

**NEVER capture:** actual names, emails, phones, addresses, PII, user-generated content, passwords, tokens, IPs, session IDs
**ALWAYS capture:** counts, field names/shapes, distributions as numbers, types, lengths, booleans, system IDs, enum values

Example — WRONG: \`args: [{ name: "Alice", email: "alice@example.com" }]\`
Example — RIGHT: \`args: [{ fields_present: ["name", "email"], has_notes: true }]\`, \`returnValue: { count: 8 }\`
`;

  const securityRules = (config.probeGoal === 'security' || config.probeGoal === 'both') ? `
## Security Probes

Add probes that detect insecure patterns at runtime. An AI agent reading this data should spot vulnerabilities immediately.

### What to probe for:

**SQL Injection:**
- Capture raw SQL queries being built — look for string concatenation/f-strings instead of parameterized queries
- Report when user input flows directly into a query without sanitization
- Capture the query pattern AND whether params were used: \`{ query: "SELECT...", parameterized: false, raw_input_in_query: true }\`

**Authentication & Authorization:**
- Capture auth check results: who was checked, what was the decision, was the token valid
- Report when endpoints are accessed WITHOUT auth checks
- Capture token validation: \`{ token_present: true, token_valid: false, expired: true, user_role: "admin" }\`
- Report permission escalation attempts: user trying to access admin routes

**Input Validation:**
- Capture when user input is used without validation/sanitization
- Report missing CSRF tokens on state-changing endpoints
- Capture Content-Type mismatches (expecting JSON, got something else)

**Insecure Patterns:**
- Report HTTP (not HTTPS) calls to external services
- Capture when sensitive data appears in URL query params instead of body/headers
- Report missing rate limiting on auth endpoints
- Capture CORS configuration: what origins are allowed
- Report when error messages expose internal details (stack traces, DB schemas) to users

**Dependency & Config:**
- Capture debug mode status in production
- Report when secrets are loaded from env vars that might be logged
- Capture TLS/SSL configuration for outbound connections

### Security probe example:
\`\`\`
// utopia:probe
try {
  __utopia.reportFunction({
    file: 'routes/users.ts', line: 45, functionName: 'getUserById',
    args: [{
      input_source: 'url_param',
      sanitized: false,
      used_in_query: true,
      query_parameterized: true
    }],
    returnValue: { auth_checked: true, role_verified: false },
    duration: Date.now() - __utopia_start,
    callStack: [],
  });
} catch { /* probe error */ }
\`\`\`
` : '';

  return base + dataRules + securityRules;
}


// ---------------------------------------------------------------------------
// Initial instrumentation prompt
// ---------------------------------------------------------------------------

function frameworkRuntimeDocs(config: UtopiaConfig): string {
  if (config.framework === 'python') {
    return `
## Utopia Runtime API (Python)

Import: \`import utopia_runtime\`
You MUST add this import to any file you add probes to.

All functions are non-blocking and NEVER raise. Every probe call MUST be wrapped in try/except.

CRITICAL: Call \`utopia_runtime.report_function(...)\`, NOT \`utopia_runtime(...)\`.

### Available functions:

\`\`\`python
utopia_runtime.report_function(
    file="path/to/file.py",       # REQUIRED
    line=10,                       # REQUIRED
    function_name="my_func",       # REQUIRED
    args=[{"key": "value"}],       # REQUIRED — must be a list
    return_value={"result": True}, # optional
    duration=150,                  # REQUIRED — milliseconds
    call_stack=[],                 # REQUIRED — can be empty list
)

utopia_runtime.report_api(
    file="path/to/file.py",       # REQUIRED
    line=10,                       # REQUIRED
    function_name="fetch_users",   # REQUIRED
    method="GET",                  # REQUIRED
    url="https://api.example.com", # REQUIRED
    status_code=200,               # optional
    duration=150,                  # REQUIRED
)

utopia_runtime.report_error(
    file="path/to/file.py",       # REQUIRED
    line=10,                       # REQUIRED
    function_name="my_func",       # REQUIRED
    error_type="ValueError",       # REQUIRED
    message="invalid input",       # REQUIRED
    stack=traceback.format_exc(),  # REQUIRED — use "" if unavailable
    input_data={"arg1": repr(x)},  # REQUIRED
)

utopia_runtime.report_db(
    file="path/to/file.py",       # REQUIRED
    line=10,                       # REQUIRED
    function_name="get_users",     # REQUIRED
    operation="SELECT",            # REQUIRED
    query="SELECT * FROM users",   # optional
    table="users",                 # optional
    duration=50,                   # REQUIRED
)

utopia_runtime.report_infra(
    file="path/to/file.py",       # REQUIRED
    line=1,                        # REQUIRED
    provider="aws",                # REQUIRED
    env_vars={k: v for k, v in os.environ.items() if "KEY" not in k and "SECRET" not in k},  # REQUIRED
)
\`\`\`

### EXACT code example — copy this pattern:

\`\`\`python
# utopia:probe
try:
    utopia_runtime.report_function(
        file="app/routes.py", line=25, function_name="get_user",
        args=[{"user_id": user_id}],
        return_value={"found": user is not None, "role": getattr(user, "role", None)},
        duration=int((time.time() - _utopia_start) * 1000),
        call_stack=[],
    )
except Exception:
    pass  # probe error — swallow silently
\`\`\`
`;
  }

  // JS/TS (nextjs, react)
  return RUNTIME_API_DOCS;
}

function frameworkProbeRules(config: UtopiaConfig): string {
  if (config.framework === 'python') {
    // Python-specific syntax rules + shared data/security rules
    const pyBase = `
## CRITICAL Rules — Follow Exactly

1. ALWAYS call \`utopia_runtime.report_function()\`, \`utopia_runtime.report_api()\`, etc. — NEVER \`utopia_runtime()\`
2. EVERY probe call MUST be wrapped in \`try: ... except Exception: pass\`
3. Add \`# utopia:probe\` comment before each probe's try block
4. \`args\` MUST be a list: \`args=[{"key": value}]\` NOT \`args={"key": value}\`
5. \`call_stack\` MUST be a list: \`call_stack=[]\`
6. \`duration\` MUST be an int (milliseconds). Use \`_utopia_start = time.time()\` before the operation
7. Never log passwords, tokens, API keys, or secrets
8. Never await a probe call — fire and forget
9. Get it right the first time
`;
    // Get the shared data mode + security rules (these are language-agnostic)
    const sharedRules = buildProbeRules(config);
    // Extract just the data and security sections (skip the JS-specific base rules)
    const dataAndSecurity = sharedRules.substring(sharedRules.indexOf('## Data Collection'));
    return pyBase + (dataAndSecurity || '');
  }
  return buildProbeRules(config);
}

function buildInstrumentationPrompt(config: UtopiaConfig): string {
  return `You are giving a codebase the ability to speak. You're adding Utopia probes — these aren't logs. They're the code's voice, telling AI agents what's actually happening at runtime so those agents can write better code.

## Project Context
- Provider: ${config.cloudProvider} / ${config.service}
- Deployment: ${config.deploymentMethod}
- Languages: ${config.language.join(', ')}
- Framework: ${config.framework}
- Standalone: ${config.isStandalone}
- Data mode: ${config.dataMode === 'full' ? 'FULL DATA — capture real inputs/outputs/data' : 'SCHEMAS ONLY — capture shapes, counts, types, never real user data'}
- Probe goal: ${config.probeGoal === 'both' ? 'DEBUGGING + SECURITY' : config.probeGoal === 'security' ? 'SECURITY FOCUS' : 'DEBUGGING FOCUS'}

${frameworkRuntimeDocs(config)}

${frameworkProbeRules(config)}

## How to Think About Probes

You are NOT a logger. You are building a bridge between production and the AI agent that will work on this code next.

Ask yourself for every function: "If an AI agent needed to modify this code, what would it need to know about how it actually behaves in production?"

### Deep probes — capture CONTEXT, not just events:

**Instead of:** "API call to /users returned 200 in 150ms"
**Do this:** Capture the response shape, how many items came back, what query params were used, whether pagination was involved, what the auth context was.

**Instead of:** "Error in processOrder"
**Do this:** Capture what the order data looked like, what validation failed, what the user state was, what upstream call triggered this.

**Instead of:** "Database query took 50ms"
**Do this:** Capture the query pattern, number of rows, whether it was cached, what triggered the query, the data shape returned.

### What makes a great probe:

1. **Data shape capture** — When a function receives or returns data, capture the SHAPE (keys, array lengths, types) not raw data. Use: \`{ shape: Object.keys(data), count: Array.isArray(data) ? data.length : 1 }\`

2. **Decision point capture** — At every if/else or switch that matters, report which path was taken and why: \`{ branch: 'premium_user', reason: 'subscription.tier === premium', userId: user.id }\`

3. **Integration context** — For every external call, capture not just timing but the full context: what triggered it, what was the input shape, what came back, how does the response get used downstream.

4. **Error context that enables fixing** — Don't just capture the error. Capture the full state that led to it: function inputs, relevant config, upstream data, the exact data that violated the expectation.

5. **Runtime configuration** — Capture feature flags, environment variables, SDK versions, tenant/user context that affects behavior. An agent needs to know the runtime environment to write correct code.

6. **Relationship mapping** — When function A calls function B, capture that chain. Use reportFunction to show how data flows: what goes in, what comes out, what transforms happen.

## Your Task

1. **Explore the codebase deeply.** Understand the architecture, data flow, entry points, integrations, business logic. Read key files thoroughly.

2. **Instrument comprehensively.** Add probes to:
   - Every API route / server action / endpoint handler — capture request shape, response shape, auth context, timing
   - Every external API call — capture full integration context (what triggers it, input/output shapes, error patterns)
   - Every database interaction — capture query patterns, data shapes, performance
   - Authentication/authorization — capture auth state, token validation, permission checks
   - Business logic — capture decision points, data transformations, validation results
   - Error boundaries — capture the FULL state that led to the error
   - Entry points — capture infrastructure context (provider, region, memory, config)
   - Feature flags / config — capture what features are active and their values
   - Data transformations — capture input shape → output shape for key transforms

3. **For each probe, think:** What would an AI agent building a new feature here need to know? What would an AI agent debugging a production issue need to see? Add THAT data.

${config.probeGoal === 'security' || config.probeGoal === 'both' ? `4. **Add security probes.** Beyond debugging, actively look for:
   - SQL queries built with string concatenation — capture whether parameterized
   - Auth checks — capture every auth decision point, who was checked, what passed/failed
   - Input validation — capture where user input enters the system and whether it's sanitized
   - Insecure HTTP calls, exposed error details, missing rate limiting, CORS config
   - Report these with clear flags: \`{ parameterized: false, raw_input_in_query: true }\`
` : ''}
${config.probeGoal === 'security' || config.probeGoal === 'both' ? '5' : '4'}. **Add the import to every file you add probes to.** ${config.framework === 'python' ? '`import utopia_runtime`' : '`import { __utopia } from \'utopia-runtime\';`'}

${config.probeGoal === 'security' || config.probeGoal === 'both' ? '6' : '5'}. Give a summary of what you instrumented and why.

Remember: These probes are how the code talks back to the agent. Make them rich, contextual, and useful.`;
}

// ---------------------------------------------------------------------------
// Reinstrument prompt (targeted, context-driven)
// ---------------------------------------------------------------------------

function buildReinstrumentPrompt(config: UtopiaConfig, purpose: string): string {
  return `You are adding targeted Utopia probes to this codebase for a specific purpose. The codebase already has some Utopia probes from initial instrumentation. You are adding MORE probes in areas relevant to the task at hand.

## Your Purpose
${purpose}

## Project Context
- Provider: ${config.cloudProvider} / ${config.service}
- Framework: ${config.framework}
- Languages: ${config.language.join(', ')}

${frameworkRuntimeDocs(config)}

${frameworkProbeRules(config)}

## Important Rules for Reinstrumentation

1. **DO NOT remove or modify existing probes** (look for \`// utopia:probe\` markers)
2. **Add probes specifically relevant to the purpose above** — don't re-instrument the whole codebase
3. **Go deep** — since this is targeted, add very detailed probes that capture everything relevant to the stated purpose
4. **Think about what the AI agent working on "${purpose}" would need to see from production**

## What to do

1. Understand the purpose above. What part of the codebase is involved?
2. Find the relevant files and functions
3. Add rich, contextual probes that capture everything an AI agent would need for this task
4. Add the import to any new files (check if it's already imported first): ${config.framework === 'python' ? '`import utopia_runtime`' : '`import { __utopia } from \'utopia-runtime\';`'}
5. Summarize what you added and why it's relevant to the purpose

Be thorough in the targeted area. These probes should give deep insight into the specific area of interest.`;
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

function findUtopiaRoot(): string | null {
  // Walk up from this file to find the utopia project root (has src/runtime/js/index.ts)
  const __filename = fileURLToPath(import.meta.url);
  let dir = dirname(__filename);
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'src', 'runtime', 'js', 'index.ts'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Also check the npm global link target
  try {
    const binPath = execSync('which utopia', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    // Follow symlinks: bin/utopia.js -> utopia project root
    const realBin = readFileSync(binPath, 'utf-8'); // Read to check, but we need the dir
    let linkDir = dirname(binPath);
    for (let i = 0; i < 10; i++) {
      if (existsSync(resolve(linkDir, 'src', 'runtime', 'js', 'index.ts'))) return linkDir;
      const parent = dirname(linkDir);
      if (parent === linkDir) break;
      linkDir = parent;
    }
  } catch { /* ignore */ }
  return null;
}

function installJsRuntime(cwd: string): { ok: boolean; error?: string } {
  let pm = 'npm';
  if (existsSync(resolve(cwd, 'pnpm-lock.yaml'))) pm = 'pnpm';
  else if (existsSync(resolve(cwd, 'yarn.lock'))) pm = 'yarn';

  try {
    execSync(`${pm} add utopia-runtime 2>&1`, { cwd, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `${pm} add utopia-runtime failed: ${(err as Error).message}` };
  }
}

function installPythonRuntime(cwd: string): { ok: boolean; error?: string } {
  const venvDirs = ['.venv', 'venv', 'env', '.env'];
  let pip = '';
  for (const vdir of venvDirs) {
    const pipPath = resolve(cwd, vdir, 'bin', 'pip');
    if (existsSync(pipPath)) { pip = pipPath; break; }
  }
  if (!pip && process.env.VIRTUAL_ENV) {
    const venvPip = resolve(process.env.VIRTUAL_ENV, 'bin', 'pip');
    if (existsSync(venvPip)) pip = venvPip;
  }
  if (!pip) pip = 'pip3';

  try {
    execSync(`${pip} install utopia-runtime --quiet 2>&1`, { cwd, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `pip install utopia-runtime failed: ${(err as Error).message}` };
  }
}

function installRuntime(cwd: string, framework: string): { ok: boolean; error?: string } {
  if (framework === 'python') {
    return installPythonRuntime(cwd);
  }
  return installJsRuntime(cwd);
}

function ensureEnvVars(cwd: string, config: UtopiaConfig): void {
  // Python projects read from .utopia/config.json directly — no env vars needed
  // (avoids conflicts with Pydantic Settings and other strict env parsers)
  if (config.framework === 'python') {
    console.log(chalk.dim('  Python project — config read from .utopia/config.json (no env vars needed)'));
    return;
  }

  const isNextJs = config.framework === 'nextjs';
  const envFileName = isNextJs ? '.env.local' : '.env';
  const envFilePath = resolve(cwd, envFileName);

  const envVars: string[] = [
    `UTOPIA_ENDPOINT=${config.dataEndpoint}`,
    `UTOPIA_PROJECT_ID=${config.projectId}`,
  ];
  if (isNextJs) {
    envVars.push(
      `NEXT_PUBLIC_UTOPIA_ENDPOINT=${config.dataEndpoint}`,
      `NEXT_PUBLIC_UTOPIA_PROJECT_ID=${config.projectId}`,
    );
  }

  let existingEnv = '';
  try { existingEnv = readFileSync(envFilePath, 'utf-8'); } catch { /* doesn't exist */ }

  let updatedEnv = existingEnv;
  for (const envVar of envVars) {
    const key = envVar.split('=')[0];
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(updatedEnv)) {
      updatedEnv = updatedEnv.replace(regex, envVar);
    }
  }

  const missing = envVars.filter(v => !updatedEnv.includes(v.split('=')[0] + '='));
  if (missing.length > 0) {
    updatedEnv += '\n# Utopia probe configuration\n' + missing.join('\n') + '\n';
  }

  if (updatedEnv !== existingEnv) {
    writeFileSync(envFilePath, updatedEnv || missing.join('\n') + '\n');
    console.log(chalk.green(`  Environment variables updated in ${envFileName}`));
  } else {
    console.log(chalk.dim(`  Environment variables up to date in ${envFileName}`));
  }
}

const SNAPSHOT_DIR = '.utopia/snapshots';
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.utopia', '.git', '__pycache__', 'venv', '.venv', 'coverage']);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py']);

/**
 * Snapshot all source files before instrumentation.
 * Only snapshots files that don't already have a snapshot (so reinstrument
 * preserves the original pre-instrument state).
 */
function snapshotFiles(cwd: string): number {
  const snapshotBase = resolve(cwd, SNAPSHOT_DIR);
  let count = 0;

  function walk(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
      const full = resolve(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (st.isFile()) {
          const ext = full.substring(full.lastIndexOf('.'));
          if (!SOURCE_EXTS.has(ext)) continue;
          const rel = full.substring(cwd.length + 1);
          const snapPath = resolve(snapshotBase, rel);
          // Only snapshot if we don't already have one (preserve original)
          if (!existsSync(snapPath)) {
            mkdirSync(dirname(snapPath), { recursive: true });
            writeFileSync(snapPath, readFileSync(full));
            count++;
          }
        }
      } catch { /* skip unreadable */ }
    }
  }

  walk(cwd);
  return count;
}

/**
 * After instrumentation, remove snapshots for files that weren't actually modified.
 * This keeps the snapshot dir lean.
 */
function pruneUnchangedSnapshots(cwd: string): void {
  const snapshotBase = resolve(cwd, SNAPSHOT_DIR);
  if (!existsSync(snapshotBase)) return;

  function walk(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = resolve(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
          // Remove empty dirs
          try {
            const remaining = readdirSync(full);
            if (remaining.length === 0) rmSync(full, { recursive: true });
          } catch { /* ignore */ }
        } else if (st.isFile()) {
          const rel = full.substring(snapshotBase.length + 1);
          const sourcePath = resolve(cwd, rel);
          if (!existsSync(sourcePath)) {
            // Source file was deleted — remove snapshot
            unlinkSync(full);
            continue;
          }
          // Compare snapshot to current file
          const snapshot = readFileSync(full);
          const current = readFileSync(sourcePath);
          if (snapshot.equals(current)) {
            // File wasn't modified — remove snapshot
            unlinkSync(full);
          }
        }
      } catch { /* skip */ }
    }
  }

  walk(snapshotBase);
}

function isAlreadyInstrumented(cwd: string): boolean {
  try {
    const result = execSync(
      `grep -rl "utopia:probe" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" . 2>/dev/null | head -1`,
      { cwd, stdio: 'pipe', encoding: 'utf-8' }
    );
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

function spawnAgentSession(cwd: string, prompt: string, agent: string): Promise<number> {
  return new Promise<number>((resolvePromise) => {
    let child: ReturnType<typeof spawn>;

    // Write prompt to temp file to avoid shell argument length limits
    const tmpPromptFile = resolve(cwd, '.utopia', '.prompt.tmp');
    mkdirSync(dirname(tmpPromptFile), { recursive: true });
    writeFileSync(tmpPromptFile, prompt);

    if (agent === 'codex') {
      child = spawn('codex', [
        'exec', readFileSync(tmpPromptFile, 'utf-8'),
        '--full-auto',
      ], {
        cwd,
        stdio: ['ignore', 'inherit', 'pipe'],
        env: { ...process.env },
      });

      // Codex doesn't stream structured output, so show a spinner
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let frame = 0;
      const startTime = Date.now();
      const spinner = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const min = Math.floor(elapsed / 60);
        const sec = elapsed % 60;
        const timeStr = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
        process.stdout.write(`\r  ${frames[frame % frames.length]} Codex is instrumenting... (${timeStr})  `);
        frame++;
      }, 100);
      child.on('close', () => { clearInterval(spinner); process.stdout.write('\r' + ' '.repeat(60) + '\r'); });
    } else {
      child = spawn('claude', [
        '-p', prompt,
        '--allowedTools', 'Edit,Read,Grep,Glob,Bash,Write',
        '--permission-mode', 'acceptEdits',
        '--output-format', 'stream-json',
        '--verbose',
      ], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    }

    // Clean up temp file
    try { unlinkSync(tmpPromptFile); } catch { /* ignore */ }

    let errorOutput = '';
    let filesEdited = 0;
    let filesRead = 0;

    child.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);

          // Claude Code streaming format
          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) {
                process.stdout.write(chalk.dim(block.text));
              }
              if (block.type === 'tool_use') {
                if (block.name === 'Edit' || block.name === 'Write') {
                  filesEdited++;
                  const fp = (block.input?.file_path || '').split('/').slice(-2).join('/');
                  console.log(chalk.green(`  [${filesEdited}] Edited: ${fp}`));
                } else if (block.name === 'Read') {
                  filesRead++;
                  const fp = (block.input?.file_path || '').split('/').slice(-2).join('/');
                  if (filesRead <= 20 || filesRead % 10 === 0) {
                    console.log(chalk.dim(`  Reading: ${fp}`));
                  }
                } else if (block.name === 'Grep' || block.name === 'Glob') {
                  console.log(chalk.dim(`  Searching: ${block.input?.pattern || '...'}`));
                }
              }
            }
          }
          if (msg.type === 'result' && msg.result) {
            console.log('\n' + chalk.white(msg.result));
          }

          // Codex streaming format (JSONL events)
          if (msg.type === 'message' && msg.content) {
            process.stdout.write(chalk.dim(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)));
          }
          if (msg.type === 'tool_call' || msg.type === 'function_call') {
            const name = msg.name || msg.function?.name || '';
            if (name.includes('edit') || name.includes('write') || name.includes('patch')) {
              filesEdited++;
              console.log(chalk.green(`  [${filesEdited}] Edited: ${msg.arguments?.path || msg.arguments?.file || '...'}`));
            } else if (name.includes('read')) {
              filesRead++;
              if (filesRead <= 20 || filesRead % 10 === 0) {
                console.log(chalk.dim(`  Reading: ${msg.arguments?.path || msg.arguments?.file || '...'}`));
              }
            }
          }
        } catch { /* partial JSON line */ }
      }
    });

    child.stderr?.on('data', (data: Buffer) => { errorOutput += data.toString(); });

    child.on('close', (code) => {
      if (code !== 0 && errorOutput) {
        console.log(chalk.dim(`  ${errorOutput.trim()}`));
      }
      resolvePromise(code ?? 1);
    });

    child.on('error', (err) => {
      const agentName = agent === 'codex' ? 'Codex' : 'Claude Code';
      console.log(chalk.red(`\n  Error spawning ${agentName}: ${err.message}`));
      resolvePromise(1);
    });
  });
}

function checkAgentAvailable(agent: string): boolean {
  const cmd = agent === 'codex' ? 'codex' : 'claude';
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// instrument command — initial, full-codebase instrumentation
// ---------------------------------------------------------------------------

export const instrumentCommand = new Command('instrument')
  .description('Add production probes to your codebase via Claude Code (initial instrumentation)')
  .action(async () => {
    const cwd = process.cwd();

    if (!configExists(cwd)) {
      console.log(chalk.red('\n  Error: No .utopia/config.json found.'));
      console.log(chalk.dim('  Run "utopia init" first.\n'));
      process.exit(1);
    }

    // Check if already instrumented
    if (isAlreadyInstrumented(cwd)) {
      console.log(chalk.yellow('\n  This codebase already has Utopia probes.'));
      console.log(chalk.dim('  Use "utopia reinstrument -p <purpose>" to add targeted probes.'));
      console.log(chalk.dim('  Or remove existing probes first (search for "utopia:probe" markers).\n'));
      process.exit(1);
    }

    const config = await loadConfig(cwd);
    console.log(chalk.bold.cyan('\n  Utopia Instrumentation\n'));

    // Install runtime
    console.log(chalk.dim('  Installing utopia-runtime...'));
    const rtResult = installRuntime(cwd, config.framework);
    if (rtResult.ok) {
      console.log(chalk.green('  utopia-runtime installed.'));
    } else {
      console.log(chalk.red(`  Error installing utopia-runtime: ${rtResult.error}`));
      console.log(chalk.dim('  Your app will fail to resolve "utopia-runtime" until this is fixed.'));
    }

    // Env vars
    console.log(chalk.dim('  Verifying environment variables...'));
    try { ensureEnvVars(cwd, config); } catch { /* non-fatal */ }
    console.log('');

    // Check agent CLI
    const agentName = config.agent === 'codex' ? 'Codex' : 'Claude Code';
    if (!checkAgentAvailable(config.agent)) {
      console.log(chalk.red(`  Error: ${agentName} CLI not found.`));
      if (config.agent === 'codex') {
        console.log(chalk.dim('  Install: npm install -g @openai/codex\n'));
      } else {
        console.log(chalk.dim('  Install from: https://docs.anthropic.com/en/docs/claude-code\n'));
      }
      process.exit(1);
    }

    // Snapshot all source files before agent modifies them
    console.log(chalk.dim('  Snapshotting source files...'));
    const snapshotCount = snapshotFiles(cwd);
    console.log(chalk.dim(`  Snapshotted ${snapshotCount} file(s).\n`));

    console.log(chalk.dim(`  Launching ${agentName} for initial instrumentation...`));
    console.log(chalk.dim(`  ${agentName} will analyze your codebase and add deep, contextual probes.\n`));
    console.log(chalk.bold.white(`  --- ${agentName} Session ---\n`));

    const code = await spawnAgentSession(cwd, buildInstrumentationPrompt(config), config.agent);

    console.log(chalk.bold.white(`\n  --- End ${agentName} Session ---\n`));

    // Prune snapshots for files that weren't modified
    pruneUnchangedSnapshots(cwd);

    if (code === 0) {
      console.log(chalk.bold.green('  Instrumentation complete!\n'));
    } else {
      console.log(chalk.yellow(`  ${agentName} exited with code ${code}.\n`));
    }

    console.log(chalk.dim('  Next steps:'));
    console.log(chalk.dim('    1. utopia validate   — Verify probe syntax'));
    console.log(chalk.dim('    2. utopia serve      — Start the data service'));
    console.log(chalk.dim('    3. Run your app and watch probe data flow in\n'));
  });

// ---------------------------------------------------------------------------
// reinstrument command — targeted, purpose-driven probe addition
// ---------------------------------------------------------------------------

export const reinstrumentCommand = new Command('reinstrument')
  .description('Add targeted probes for a specific task or area')
  .requiredOption('-p, --purpose <purpose>', 'What the probes are for (e.g. "debugging auth flow", "preparing to refactor billing")')
  .action(async (options) => {
    const cwd = process.cwd();

    if (!configExists(cwd)) {
      console.log(chalk.red('\n  Error: No .utopia/config.json found.'));
      console.log(chalk.dim('  Run "utopia init" first.\n'));
      process.exit(1);
    }

    const config = await loadConfig(cwd);
    const purpose = options.purpose as string;

    console.log(chalk.bold.cyan('\n  Utopia Reinstrumentation\n'));
    console.log(chalk.white(`  Purpose: ${purpose}\n`));

    // Ensure runtime is present
    const runtimeExists = config.framework === 'python'
      ? existsSync(resolve(cwd, 'utopia_runtime', '__init__.py')) || existsSync(resolve(cwd, '.venv', 'lib'))
      : existsSync(resolve(cwd, 'node_modules', 'utopia-runtime', 'index.js'));
    if (!runtimeExists) {
      console.log(chalk.dim('  Installing utopia-runtime...'));
      const rtResult = installRuntime(cwd, config.framework);
      if (rtResult.ok) {
        console.log(chalk.green('  utopia-runtime installed.'));
      } else {
        console.log(chalk.red(`  Error: ${rtResult.error}`));
      }
    }

    // Env vars
    try { ensureEnvVars(cwd, config); } catch { /* non-fatal */ }

    const agentName = config.agent === 'codex' ? 'Codex' : 'Claude Code';
    if (!checkAgentAvailable(config.agent)) {
      console.log(chalk.red(`  Error: ${agentName} CLI not found.\n`));
      process.exit(1);
    }

    // Snapshot files before agent modifies them (preserves original pre-instrument state)
    console.log(chalk.dim('  Snapshotting source files...'));
    snapshotFiles(cwd);

    console.log(chalk.dim(`  Launching ${agentName} for targeted instrumentation...\n`));
    console.log(chalk.bold.white(`  --- ${agentName} Session ---\n`));

    const code = await spawnAgentSession(cwd, buildReinstrumentPrompt(config, purpose), config.agent);

    console.log(chalk.bold.white(`\n  --- End ${agentName} Session ---\n`));

    pruneUnchangedSnapshots(cwd);

    if (code === 0) {
      console.log(chalk.bold.green('  Reinstrumentation complete!\n'));
    } else {
      console.log(chalk.yellow(`  ${agentName} exited with code ${code}.\n`));
    }

    console.log(chalk.dim('  Restart your app to activate the new probes.\n'));
  });
