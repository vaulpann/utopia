// Utopia JS/TS probe runtime
// Lightweight, non-blocking probe reporter for instrumented applications.
// Import as: import { __utopia } from 'utopia-runtime'
//
// CRITICAL: Every public method is wrapped in try/catch. This runtime
// MUST NEVER crash the host application under any circumstances.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UtopiaConfig {
  endpoint: string;
  projectId: string;
}

interface ProbePayload {
  id: string;
  projectId: string;
  probeType: string;
  timestamp: string;
  file: string;
  line: number;
  functionName: string;
  data: Record<string, unknown>;
  metadata: {
    runtime: 'node';
    environment?: string;
    hostname?: string;
    pid?: number;
  };
}

interface ErrorProbeData {
  file: string;
  line: number;
  functionName: string;
  errorType: string;
  message: string;
  stack: string;
  inputData: Record<string, unknown>;
  codeLine: string;
}

interface DbProbeData {
  file: string;
  line: number;
  functionName: string;
  operation: string;
  query?: string;
  table?: string;
  duration: number;
  rowCount?: number;
  connectionInfo?: { type?: string; host?: string; database?: string };
  params?: unknown[];
  error?: string;
}

interface ApiProbeData {
  file: string;
  line: number;
  functionName: string;
  method: string;
  url: string;
  statusCode?: number;
  duration: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseBody?: unknown;
  error?: string;
}

interface InfraProbeData {
  file: string;
  line: number;
  provider: string;
  region?: string;
  serviceType?: string;
  instanceId?: string;
  containerInfo?: { containerId?: string; image?: string };
  envVars: Record<string, string>;
  memoryUsage: number;
}

interface FunctionProbeData {
  file: string;
  line: number;
  functionName: string;
  args: unknown[];
  returnValue?: unknown;
  duration: number;
  callStack: string[];
}

interface LlmContextProbeData {
  file: string;
  line: number;
  functionName: string;
  context: string;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _config: UtopiaConfig | null = null;
let _queue: ProbePayload[] = [];
let _flushTimer: ReturnType<typeof setInterval> | null = null;
let _consecutiveFailures = 0;
let _circuitOpen = false;
let _circuitOpenTime = 0;

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_BATCH_SIZE = 50;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a UUID v4 without external dependencies.
 * Uses crypto.randomUUID() when available, otherwise falls back to a
 * manual implementation using Math.random().
 */
function generateId(): string {
  try {
    // Node 19+ / modern runtimes
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to manual implementation
  }

  // Manual UUID v4 fallback
  const hex = '0123456789abcdef';
  let uuid = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      uuid += '-';
    } else if (i === 14) {
      uuid += '4'; // Version 4
    } else if (i === 19) {
      uuid += hex[(Math.random() * 4) | 8]; // Variant bits
    } else {
      uuid += hex[(Math.random() * 16) | 0];
    }
  }
  return uuid;
}

/**
 * Build metadata object for probe payloads.
 */
function buildMetadata(): ProbePayload['metadata'] {
  const meta: ProbePayload['metadata'] = { runtime: 'node' };
  try {
    if (typeof process !== 'undefined') {
      meta.environment = process.env.NODE_ENV || process.env.UTOPIA_ENV || undefined;
      meta.hostname = process.env.HOSTNAME || undefined;
      meta.pid = process.pid || undefined;
    }
  } catch {
    // Swallow — some environments restrict process access
  }
  return meta;
}

/**
 * Resolve configuration from explicit init or environment variables.
 * Returns null if not enough config is available.
 */
function resolveConfig(): UtopiaConfig | null {
  if (_config) return _config;
  try {
    if (typeof process === 'undefined' || !process.env) return null;
    // Check both standard and NEXT_PUBLIC_ prefixed env vars (for Next.js client components)
    const endpoint = process.env.UTOPIA_ENDPOINT || process.env.NEXT_PUBLIC_UTOPIA_ENDPOINT;
    const projectId = process.env.UTOPIA_PROJECT_ID || process.env.NEXT_PUBLIC_UTOPIA_PROJECT_ID;
    if (endpoint && projectId) {
      _config = { endpoint, projectId };
      return _config;
    }
  } catch {
    // Swallow
  }
  return null;
}

/**
 * Ensure the periodic flush timer is running.
 */
function startFlushTimer(): void {
  try {
    if (_flushTimer) return;
    _flushTimer = setInterval(() => {
      flush();
    }, FLUSH_INTERVAL_MS);
    // Unref so the timer does not prevent process exit
    if (_flushTimer && typeof _flushTimer === 'object' && 'unref' in _flushTimer) {
      (_flushTimer as { unref: () => void }).unref();
    }
  } catch {
    // Never throw
  }
}

/**
 * Create a ProbePayload from probe data and enqueue it.
 */
function enqueue(
  probeType: string,
  file: string,
  line: number,
  functionName: string,
  data: Record<string, unknown>
): void {
  try {
    const cfg = resolveConfig();
    const payload: ProbePayload = {
      id: generateId(),
      projectId: cfg?.projectId || '',
      probeType,
      timestamp: new Date().toISOString(),
      file,
      line,
      functionName,
      data,
      metadata: buildMetadata(),
    };
    _queue.push(payload);
    // Flush immediately if batch is full
    if (_queue.length >= FLUSH_BATCH_SIZE) {
      flush();
    }
  } catch {
    // Never throw
  }
}

/**
 * Flush queued probe payloads to the Utopia endpoint.
 * Respects circuit breaker state.
 */
async function flush(): Promise<void> {
  try {
    const cfg = resolveConfig();
    if (!cfg) return;
    if (_queue.length === 0) return;

    // Circuit breaker: if open, check cooldown
    if (_circuitOpen) {
      if (Date.now() < _circuitOpenTime + CIRCUIT_BREAKER_COOLDOWN_MS) {
        return;
      }
      // Cooldown has elapsed — allow a single retry
      _circuitOpen = false;
      _consecutiveFailures = 0;
    }

    const batch = _queue.splice(0, FLUSH_BATCH_SIZE);

    const body = JSON.stringify(batch);

    const response = await fetch(`${cfg.endpoint}/api/v1/probes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      _consecutiveFailures++;
      if (_consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        _circuitOpen = true;
        _circuitOpenTime = Date.now();
      }
      // Put items back at front of queue so they are not lost
      _queue.unshift(...batch);
      return;
    }

    // Success — reset failure tracking
    _consecutiveFailures = 0;
  } catch {
    _consecutiveFailures++;
    if (_consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      _circuitOpen = true;
      _circuitOpenTime = Date.now();
    }
    // Never throw
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Explicitly initialise the Utopia runtime with connection details.
 * If not called, the runtime will auto-initialise from environment variables
 * on the first probe report.
 */
function init(config: { endpoint: string; projectId: string }): void {
  try {
    _config = {
      endpoint: config.endpoint,
      projectId: config.projectId,
    };
    startFlushTimer();
  } catch {
    // Never throw
  }
}

/**
 * Report an error caught by an instrumented function.
 */
function reportError(probeData: ErrorProbeData): void {
  try {
    startFlushTimer();
    enqueue(
      'error',
      probeData.file,
      probeData.line,
      probeData.functionName,
      {
        errorType: probeData.errorType,
        message: probeData.message,
        stack: probeData.stack,
        inputData: probeData.inputData,
        codeLine: probeData.codeLine,
      }
    );
  } catch {
    // Never throw
  }
}

/**
 * Report a database operation observed by an instrumented call site.
 */
function reportDb(probeData: DbProbeData): void {
  try {
    startFlushTimer();
    enqueue(
      'database',
      probeData.file,
      probeData.line,
      probeData.functionName,
      {
        operation: probeData.operation,
        query: probeData.query,
        table: probeData.table,
        duration: probeData.duration,
        rowCount: probeData.rowCount,
        connectionInfo: probeData.connectionInfo,
        params: probeData.params,
        error: probeData.error,
      }
    );
  } catch {
    // Never throw
  }
}

/**
 * Report an HTTP API call observed by an instrumented call site.
 */
function reportApi(probeData: ApiProbeData): void {
  try {
    startFlushTimer();
    enqueue(
      'api',
      probeData.file,
      probeData.line,
      probeData.functionName,
      {
        method: probeData.method,
        url: probeData.url,
        statusCode: probeData.statusCode,
        duration: probeData.duration,
        requestHeaders: probeData.requestHeaders,
        responseHeaders: probeData.responseHeaders,
        requestBody: probeData.requestBody,
        responseBody: probeData.responseBody,
        error: probeData.error,
      }
    );
  } catch {
    // Never throw
  }
}

/**
 * Report infrastructure / deployment context from an entry point file.
 */
function reportInfra(probeData: InfraProbeData): void {
  try {
    startFlushTimer();
    enqueue(
      'infra',
      probeData.file,
      probeData.line,
      '<module>',
      {
        provider: probeData.provider,
        region: probeData.region,
        serviceType: probeData.serviceType,
        instanceId: probeData.instanceId,
        containerInfo: probeData.containerInfo,
        envVars: probeData.envVars,
        memoryUsage: probeData.memoryUsage,
      }
    );
  } catch {
    // Never throw
  }
}

/**
 * Report function-level profiling data.
 */
function reportFunction(probeData: FunctionProbeData): void {
  try {
    startFlushTimer();
    enqueue(
      'function',
      probeData.file,
      probeData.line,
      probeData.functionName,
      {
        args: probeData.args,
        returnValue: probeData.returnValue,
        duration: probeData.duration,
        callStack: probeData.callStack,
      }
    );
  } catch {
    // Never throw
  }
}

/**
 * Report LLM-generated context about a function (Utopia mode).
 */
function reportLlmContext(probeData: LlmContextProbeData): void {
  try {
    startFlushTimer();
    enqueue(
      'llm_context',
      probeData.file,
      probeData.line,
      probeData.functionName,
      {
        context: probeData.context,
      }
    );
  } catch {
    // Never throw
  }
}

/**
 * Force an immediate flush of all queued probes.
 * Useful before process exit.
 */
async function shutdown(): Promise<void> {
  try {
    if (_flushTimer) {
      clearInterval(_flushTimer);
      _flushTimer = null;
    }
    // Flush remaining items in batches
    while (_queue.length > 0) {
      await flush();
    }
  } catch {
    // Never throw
  }
}

// ---------------------------------------------------------------------------
// Self-healing wrapper
// ---------------------------------------------------------------------------

interface HealConfig {
  apiKey?: string;
  anthropicApiKey?: string;
  model?: string;
  baseUrl?: string;
  provider?: 'openai' | 'anthropic';
}

interface UtopiaWrapOptions {
  ignore?: Array<new (...args: unknown[]) => Error>;
  name?: string;
}

let _healConfig: HealConfig = {};

/**
 * Configure the self-healing provider.
 * Falls back to environment variables if not set.
 */
function configureHeal(config: HealConfig): void {
  _healConfig = { ..._healConfig, ...config };
}

function _resolveHealProvider(): 'openai' | 'anthropic' {
  if (_healConfig.provider) return _healConfig.provider;
  const env = typeof process !== 'undefined' ? process.env : ({} as Record<string, string | undefined>);
  if (env.UTOPIA_PROVIDER) return env.UTOPIA_PROVIDER as 'openai' | 'anthropic';
  const hasAnthropic = _healConfig.anthropicApiKey || env.ANTHROPIC_API_KEY;
  const hasOpenAI = _healConfig.apiKey || env.OPENAI_API_KEY;
  if (hasAnthropic && !hasOpenAI) return 'anthropic';
  return 'openai';
}

function _resolveHealApiKey(provider: string): string {
  const env = typeof process !== 'undefined' ? process.env : ({} as Record<string, string | undefined>);
  if (provider === 'anthropic') {
    return _healConfig.anthropicApiKey || env.ANTHROPIC_API_KEY || '';
  }
  return _healConfig.apiKey || env.OPENAI_API_KEY || '';
}

function _resolveHealModel(provider: string): string {
  const env = typeof process !== 'undefined' ? process.env : ({} as Record<string, string | undefined>);
  if (_healConfig.model) return _healConfig.model;
  if (env.UTOPIA_MODEL) return env.UTOPIA_MODEL;
  return provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o';
}

function _resolveHealBaseUrl(provider: string): string {
  const env = typeof process !== 'undefined' ? process.env : ({} as Record<string, string | undefined>);
  if (_healConfig.baseUrl) return _healConfig.baseUrl;
  if (env.UTOPIA_BASE_URL) return env.UTOPIA_BASE_URL;
  return provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com';
}

function _buildHealPrompt(
  funcName: string,
  sourceCode: string,
  errorType: string,
  errorMessage: string,
  errorStack: string,
  argsRepr: string,
): string {
  return `You are a JavaScript/TypeScript debugging expert. A function crashed at runtime and you need to fix it.

## Function Name
${funcName}

## Original Source Code
\`\`\`javascript
${sourceCode}
\`\`\`

## Error
${errorType}: ${errorMessage}

## Stack Trace
${errorStack}

## Arguments That Caused The Error
${argsRepr}

## Instructions
1. Analyze the error and the code.
2. Write a FIXED version of the function that handles this error case correctly.
3. The fixed function MUST be a valid JavaScript function expression assigned to a variable called \`fixed\`. Example: \`const fixed = function(x, y) { ... }\` or \`const fixed = async function(x, y) { ... }\`
4. The fixed function MUST have the same parameters.
5. The fix should be minimal — only change what is needed to fix the bug.
6. Do NOT use import/export/require. If you need a module, assume it is available in scope.

Respond with ONLY a JSON object (no markdown fences, no extra text):
{"fixed_code": "const fixed = function(...) { ... }", "explanation": "one sentence explaining the fix"}`;
}

async function _callHealAPI(prompt: string): Promise<{ fixed_code: string; explanation: string } | null> {
  const provider = _resolveHealProvider();
  const apiKey = _resolveHealApiKey(provider);
  if (!apiKey) return null;

  const model = _resolveHealModel(provider);
  const baseUrl = _resolveHealBaseUrl(provider).replace(/\/$/, '');

  try {
    let responseText: string;

    if (provider === 'anthropic') {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
      const textBlocks = (data.content || []).filter((b: { type: string }) => b.type === 'text');
      responseText = textBlocks.map((b: { text?: string }) => b.text || '').join('\n');
    } else {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      responseText = data.choices?.[0]?.message?.content || '';
    }

    // Parse JSON, stripping markdown fences if present
    let cleaned = responseText.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) cleaned = fenceMatch[1].trim();

    const parsed = JSON.parse(cleaned);
    if (parsed.fixed_code && parsed.explanation) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Log a fix to `.utopia/fixes/` (Node.js only).
 */
function _logFix(entry: {
  functionName: string;
  sourceCode: string;
  fixedCode: string;
  errorType: string;
  errorMessage: string;
  errorStack: string;
  explanation: string;
  hotPatchSuccess: boolean;
  patchError?: string;
}): void {
  try {
    if (typeof process === 'undefined') return;
    // Dynamic import to avoid breaking browser bundles
    const fs = require('fs');
    const path = require('path');

    // Find .utopia dir
    let dir = process.cwd();
    let utopiaDir = '';
    for (let i = 0; i < 10; i++) {
      const candidate = path.join(dir, '.utopia');
      if (fs.existsSync(candidate)) { utopiaDir = candidate; break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!utopiaDir) {
      utopiaDir = path.join(process.cwd(), '.utopia');
      fs.mkdirSync(utopiaDir, { recursive: true });
    }

    const fixesDir = path.join(utopiaDir, 'fixes');
    fs.mkdirSync(fixesDir, { recursive: true });

    const ts = new Date().toISOString();
    const slug = ts.replace(/[-:T]/g, '').replace(/\..+/, '');
    const fixId = `${entry.functionName}_${slug}`;

    const record = {
      id: fixId,
      timestamp: ts,
      function_name: entry.functionName,
      source_file: '<js>',
      error: {
        type: entry.errorType,
        message: entry.errorMessage,
        traceback: entry.errorStack,
      },
      original_code: entry.sourceCode,
      fixed_code: entry.fixedCode,
      explanation: entry.explanation,
      hot_patch_success: entry.hotPatchSuccess,
      patch_error: entry.patchError || null,
      status: 'pending_review',
    };

    fs.writeFileSync(
      path.join(fixesDir, `${fixId}.json`),
      JSON.stringify(record, null, 2),
    );

    const label = entry.hotPatchSuccess ? 'healed' : 'fix generated (hot-patch failed)';
    process.stderr.write(
      `[utopia] ${label}: ${entry.functionName} -- ${entry.errorType}: ${entry.errorMessage}\n` +
      `[utopia] fix logged to ${path.join(fixesDir, fixId + '.json')}\n`,
    );
  } catch {
    // Never crash
  }
}

/**
 * Wrap a function with self-healing. When the function throws an unexpected
 * error, Utopia sends the source + error to OpenAI/Anthropic, gets a fix,
 * hot-patches it at runtime, and logs everything.
 *
 * @example
 * ```ts
 * import { utopia } from 'utopia-runtime';
 *
 * const processOrder = utopia(async (orderId: string) => {
 *   const order = await db.orders.find(orderId);
 *   return order.total * 1.08; // tax
 * });
 *
 * // With ignore:
 * const strictParse = utopia((data: string) => {
 *   if (!data) throw new TypeError('data required'); // intentional
 *   return JSON.parse(data);
 * }, { ignore: [TypeError] });
 * ```
 */
function utopia<T extends (...args: unknown[]) => unknown>(
  fn: T,
  options?: UtopiaWrapOptions,
): T {
  const ignoredErrors = options?.ignore || [];
  const funcName = options?.name || fn.name || '<anonymous>';
  const sourceCode = fn.toString();

  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    try {
      const result = fn.apply(this, args);

      // Handle async functions
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return (result as Promise<unknown>).catch(async (err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));

          if (ignoredErrors.some(E => error instanceof E)) throw error;

          const fix = await _callHealAPI(_buildHealPrompt(
            funcName, sourceCode, error.constructor.name,
            error.message, error.stack || '', JSON.stringify(args),
          ));

          if (!fix) throw error;

          // Attempt hot-patch
          try {
            // eslint-disable-next-line no-eval
            const evalResult = eval(`(function() { ${fix.fixed_code}; return fixed; })()`);
            const patchedResult = evalResult.apply(this, args);
            const awaited = (patchedResult && typeof patchedResult.then === 'function')
              ? await patchedResult : patchedResult;

            _logFix({
              functionName: funcName, sourceCode, fixedCode: fix.fixed_code,
              errorType: error.constructor.name, errorMessage: error.message,
              errorStack: error.stack || '', explanation: fix.explanation,
              hotPatchSuccess: true,
            });
            return awaited;
          } catch (patchErr) {
            _logFix({
              functionName: funcName, sourceCode, fixedCode: fix.fixed_code,
              errorType: error.constructor.name, errorMessage: error.message,
              errorStack: error.stack || '', explanation: fix.explanation,
              hotPatchSuccess: false,
              patchError: patchErr instanceof Error ? patchErr.message : String(patchErr),
            });
            throw error;
          }
        });
      }

      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      if (ignoredErrors.some(E => error instanceof E)) throw error;

      // Sync functions: can't await the heal call, so we log and rethrow.
      // The fix will be available for the next run via .utopia/fixes/.
      _callHealAPI(_buildHealPrompt(
        funcName, sourceCode, error.constructor.name,
        error.message, error.stack || '', JSON.stringify(args),
      )).then(fix => {
        if (fix) {
          _logFix({
            functionName: funcName, sourceCode, fixedCode: fix.fixed_code,
            errorType: error.constructor.name, errorMessage: error.message,
            errorStack: error.stack || '', explanation: fix.explanation,
            hotPatchSuccess: false, patchError: 'sync function — fix logged for next run',
          });
        }
      }).catch(() => { /* never crash */ });

      throw error;
    }
  };

  // Preserve function name
  Object.defineProperty(wrapper, 'name', { value: funcName });
  return wrapper as T;
}

// ---------------------------------------------------------------------------
// Exported object and named exports
// ---------------------------------------------------------------------------

export const __utopia = {
  init,
  reportError,
  reportDb,
  reportApi,
  reportInfra,
  reportFunction,
  reportLlmContext,
  flush,
  shutdown,
  generateId,
  utopia,
  configureHeal,
};

export {
  init,
  reportError,
  reportDb,
  reportApi,
  reportInfra,
  reportFunction,
  reportLlmContext,
  flush,
  shutdown,
  generateId,
  utopia,
  configureHeal,
};

export default __utopia;
