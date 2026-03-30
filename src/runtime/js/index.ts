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
};

export default __utopia;
