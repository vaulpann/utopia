/**
 * Utopia Mode — LLM-Enhanced Probes
 *
 * At runtime, probes capture function data and send it (async, non-blocking)
 * to an LLM that generates rich semantic context about what the code is doing.
 * This context is then stored in the data service for AI coding agents to query.
 *
 * The LLM call happens server-side (in the data service) to avoid adding
 * the Anthropic SDK as a dependency of the probe runtime.
 */

import Anthropic from '@anthropic-ai/sdk';

interface LlmContextRequest {
  file: string;
  line: number;
  functionName: string;
  args: unknown[];
  returnValue?: unknown;
  duration: number;
  probeType: string;
  additionalContext?: Record<string, unknown>;
}

interface LlmContextResult {
  summary: string;
  behavior: string;
  dataFlow: string;
  sideEffects: string[];
  dependencies: string[];
  risks: string[];
}

let client: Anthropic | null = null;
let processingQueue: LlmContextRequest[] = [];
let isProcessing = false;
const BATCH_SIZE = 5;
const FLUSH_INTERVAL = 10_000; // 10 seconds
let flushTimer: ReturnType<typeof setInterval> | null = null;

function getClient(): Anthropic | null {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.UTOPIA_LLM_API_KEY;
  if (!apiKey) return null;
  client = new Anthropic({ apiKey });
  return client;
}

function startFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    processQueue().catch(() => {});
  }, FLUSH_INTERVAL);
  if (flushTimer.unref) flushTimer.unref();
}

/**
 * Queue a function's runtime data for LLM context generation.
 * Called by the data service when it receives a function probe or llm_context probe.
 */
export function queueForLlmContext(request: LlmContextRequest): void {
  processingQueue.push(request);
  startFlushTimer();

  if (processingQueue.length >= BATCH_SIZE) {
    processQueue().catch(() => {});
  }
}

/**
 * Process queued requests — generate LLM context for each and return results.
 */
async function processQueue(): Promise<LlmContextResult[]> {
  if (isProcessing || processingQueue.length === 0) return [];
  isProcessing = true;

  const batch = processingQueue.splice(0, BATCH_SIZE);
  const results: LlmContextResult[] = [];

  try {
    const anthropic = getClient();
    if (!anthropic) {
      isProcessing = false;
      return [];
    }

    // Process each request concurrently but with a concurrency limit
    const promises = batch.map(req => generateContext(anthropic, req));
    const settled = await Promise.allSettled(promises);

    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) {
        results.push(result.value);
      }
    }
  } catch {
    // Silently fail — never impact the host application
  } finally {
    isProcessing = false;
  }

  return results;
}

/**
 * Generate semantic context for a single function invocation using Claude.
 */
async function generateContext(
  anthropic: Anthropic,
  request: LlmContextRequest
): Promise<LlmContextResult | null> {
  try {
    const prompt = buildPrompt(request);

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
      system: `You are analyzing runtime data from a production function invocation. Respond ONLY with valid JSON matching this schema:
{
  "summary": "one-line description of what this function call did",
  "behavior": "description of the function's runtime behavior based on inputs/outputs",
  "dataFlow": "how data flows through this function (inputs → transformations → outputs)",
  "sideEffects": ["list of side effects: DB writes, API calls, file I/O, etc."],
  "dependencies": ["list of external dependencies this function relies on"],
  "risks": ["potential issues: N+1 queries, slow calls, error-prone patterns"]
}`,
    });

    const content = message.content[0];
    if (content.type !== 'text') return null;

    const parsed = JSON.parse(content.text) as LlmContextResult;
    return parsed;
  } catch {
    return null;
  }
}

function buildPrompt(request: LlmContextRequest): string {
  const argsSummary = truncate(JSON.stringify(request.args), 500);
  const returnSummary = truncate(JSON.stringify(request.returnValue), 500);

  return `Analyze this production function invocation:

File: ${request.file}
Function: ${request.functionName}
Line: ${request.line}
Duration: ${request.duration}ms
Arguments: ${argsSummary}
Return Value: ${returnSummary}
${request.additionalContext ? `Additional Context: ${JSON.stringify(request.additionalContext)}` : ''}

Based on the function name, file path, arguments, return value, and duration, generate a semantic context summary.`;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + '...';
}

/**
 * Process a probe from the data service and generate LLM context.
 * Returns the context to be stored alongside the probe.
 */
export async function processProbeForLlmContext(probe: {
  file: string;
  line: number;
  function_name: string;
  probe_type: string;
  data: string;
}): Promise<LlmContextResult | null> {
  const anthropic = getClient();
  if (!anthropic) return null;

  let parsedData: Record<string, unknown> = {};
  try {
    parsedData = JSON.parse(probe.data);
  } catch {
    return null;
  }

  return generateContext(anthropic, {
    file: probe.file,
    line: probe.line,
    functionName: probe.function_name,
    args: (parsedData.args as unknown[]) || [],
    returnValue: parsedData.returnValue,
    duration: (parsedData.duration as number) || 0,
    probeType: probe.probe_type,
    additionalContext: parsedData,
  });
}

/**
 * Shutdown: flush remaining queue.
 */
export async function shutdown(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await processQueue();
}

export type { LlmContextRequest, LlmContextResult };
