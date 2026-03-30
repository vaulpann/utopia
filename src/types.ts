// Utopia shared types

export type CloudProvider = 'aws' | 'gcp' | 'vercel' | 'azure' | 'other';
export type DeploymentMethod = 'manual' | 'github-actions' | 'vercel-trigger' | 'other';
export type Language = 'javascript' | 'typescript' | 'python';
export type Framework = 'react' | 'nextjs' | 'express' | 'fastapi' | 'flask' | 'django' | 'other';

export interface UtopiaConfig {
  version: string;
  projectId: string;
  cloudProvider: CloudProvider;
  service: string;
  deploymentMethod: DeploymentMethod;
  isStandalone: boolean;
  dataEndpoint: string;
  language: Language[];
  framework: Framework;
}

export type ProbeType = 'error' | 'database' | 'api' | 'infra' | 'function';

export interface ProbeData {
  id: string;
  projectId: string;
  probeType: ProbeType;
  timestamp: string;
  file: string;
  line: number;
  functionName: string;
  data: Record<string, unknown>;
  metadata: ProbeMetadata;
}

export interface ProbeMetadata {
  runtime: 'node' | 'python';
  environment?: string;
  hostname?: string;
  pid?: number;
  version?: string;
}

export interface ErrorProbeData extends ProbeData {
  probeType: 'error';
  data: {
    errorType: string;
    message: string;
    stack: string;
    inputData: Record<string, unknown>;
    codeLine: string;
  };
}

export interface DatabaseProbeData extends ProbeData {
  probeType: 'database';
  data: {
    operation: string;
    query?: string;
    table?: string;
    duration: number;
    rowCount?: number;
    connectionInfo: {
      type: string;
      host?: string;
      database?: string;
    };
    params?: unknown[];
  };
}

export interface ApiProbeData extends ProbeData {
  probeType: 'api';
  data: {
    method: string;
    url: string;
    statusCode?: number;
    duration: number;
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
    requestBody?: unknown;
    responseBody?: unknown;
    error?: string;
  };
}

export interface InfraProbeData extends ProbeData {
  probeType: 'infra';
  data: {
    provider: CloudProvider;
    region?: string;
    serviceType?: string;
    instanceId?: string;
    containerInfo?: {
      containerId?: string;
      image?: string;
    };
    envVars: Record<string, string>;
    memoryUsage: number;
    cpuUsage?: number;
  };
}

export interface FunctionProbeData extends ProbeData {
  probeType: 'function';
  data: {
    args: unknown[];
    returnValue?: unknown;
    duration: number;
    llmContext?: string; // Utopia mode: LLM-generated context
    callStack: string[];
  };
}

// Impact Graph types
export interface GraphNode {
  id: string;
  type: 'function' | 'service' | 'database' | 'api' | 'file';
  name: string;
  file?: string;
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: 'calls' | 'queries' | 'serves' | 'depends_on';
  weight: number;
  lastSeen: string;
}

export interface ImpactGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// MCP tool types
export interface ContextQuery {
  prompt: string;
  file?: string;
  probeTypes?: ProbeType[];
  limit?: number;
}

export interface ContextResult {
  relevantProbes: ProbeData[];
  impactedNodes: GraphNode[];
  summary: string;
}
