// Utopia JS/TS AST Instrumenter
// Uses Babel to parse, traverse, and transform JS/TS source files,
// injecting lightweight probes for error tracking, database monitoring,
// API call tracing, infrastructure reporting, and function profiling.

import * as parser from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, extname, basename, dirname, join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';

// Handle default export interop for CommonJS/ESM compatibility
const traverse = (_traverse as any).default || _traverse;
const generate = (_generate as any).default || _generate;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InstrumentOptions {
  probeTypes: ('error' | 'database' | 'api' | 'infra' | 'function')[];
  utopiaMode: boolean;
  dryRun: boolean;
  entryPoints?: string[];
}

interface InstrumentResult {
  file: string;
  probesAdded: { type: string; line: number; functionName: string }[];
  success: boolean;
  error?: string;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '__tests__',
  '__mocks__',
  '.git',
  '.utopia',
  'coverage',
]);

const VALID_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx']);

const ENTRY_POINT_BASENAMES = new Set([
  'index.ts',
  'index.js',
  'index.tsx',
  'index.jsx',
  'main.ts',
  'main.js',
  'server.ts',
  'server.js',
  'app.ts',
  'app.js',
]);

const PRISMA_METHODS = new Set([
  'findMany',
  'findUnique',
  'findFirst',
  'findUniqueOrThrow',
  'findFirstOrThrow',
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

const MONGOOSE_METHODS = new Set([
  'find',
  'findOne',
  'findById',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'findByIdAndUpdate',
  'findByIdAndDelete',
  'create',
  'insertMany',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'countDocuments',
  'estimatedDocumentCount',
  'aggregate',
]);

const KNEX_QUERY_METHODS = new Set([
  'select',
  'insert',
  'update',
  'delete',
  'del',
  'where',
  'from',
  'into',
  'raw',
]);

const BABEL_PLUGINS: parser.ParserPlugin[] = [
  'typescript',
  'jsx',
  'decorators-legacy',
  'classProperties',
  'optionalChaining',
  'nullishCoalescingOperator',
  'dynamicImport',
  'exportDefaultFrom',
  'importMeta',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect Babel parser plugins to use based on file extension.
 */
function getParserPlugins(filePath: string): parser.ParserPlugin[] {
  const ext = extname(filePath).toLowerCase();
  // All files get the full plugin set; Babel is fine with unused plugins
  return [...BABEL_PLUGINS];
}

/**
 * Determine the source type for the parser.
 */
function getSourceType(filePath: string): 'module' | 'script' {
  // Default to module for all TS/modern JS
  return 'module';
}

/**
 * Get the enclosing function name from a Babel traversal path.
 */
function getEnclosingFunctionName(path: any): string {
  let current = path;
  while (current) {
    if (current.isFunctionDeclaration() && current.node.id) {
      return current.node.id.name;
    }
    if (current.isFunctionExpression() && current.node.id) {
      return current.node.id.name;
    }
    if (current.isClassMethod() || current.isObjectMethod()) {
      const key = current.node.key;
      if (t.isIdentifier(key)) return key.name;
      if (t.isStringLiteral(key)) return key.value;
    }
    if (
      current.isVariableDeclarator &&
      current.isVariableDeclarator() &&
      t.isIdentifier(current.node.id)
    ) {
      return current.node.id.name;
    }
    // Arrow function assigned to variable
    if (
      current.parentPath &&
      current.parentPath.isVariableDeclarator() &&
      t.isIdentifier(current.parentPath.node.id)
    ) {
      return current.parentPath.node.id.name;
    }
    // Object property
    if (
      current.parentPath &&
      current.parentPath.isObjectProperty() &&
      t.isIdentifier(current.parentPath.node.key)
    ) {
      return current.parentPath.node.key.name;
    }
    // Export default
    if (current.parentPath && current.parentPath.isExportDefaultDeclaration()) {
      return 'default';
    }
    current = current.parentPath;
  }
  return '<anonymous>';
}

/**
 * Given a CallExpression path, get enclosing function name by walking up.
 */
function getEnclosingFnName(path: any): string {
  let current = path.parentPath;
  while (current) {
    if (current.isFunctionDeclaration() && current.node.id) {
      return current.node.id.name;
    }
    if (current.isFunctionExpression() && current.node.id) {
      return current.node.id.name;
    }
    if (current.isArrowFunctionExpression()) {
      // Check if assigned to a variable
      if (
        current.parentPath &&
        current.parentPath.isVariableDeclarator() &&
        t.isIdentifier(current.parentPath.node.id)
      ) {
        return current.parentPath.node.id.name;
      }
      if (
        current.parentPath &&
        current.parentPath.isObjectProperty() &&
        t.isIdentifier(current.parentPath.node.key)
      ) {
        return current.parentPath.node.key.name;
      }
    }
    if (current.isClassMethod() || current.isObjectMethod()) {
      const key = current.node.key;
      if (t.isIdentifier(key)) return key.name;
      if (t.isStringLiteral(key)) return key.value;
    }
    current = current.parentPath;
  }
  return '<anonymous>';
}

/**
 * Read a specific line from source text. Returns empty string if out of range.
 */
function getSourceLine(source: string, lineNumber: number): string {
  const lines = source.split('\n');
  if (lineNumber < 1 || lineNumber > lines.length) return '';
  return lines[lineNumber - 1].trim();
}

/**
 * Get the function name from a function-like path node.
 */
function getFunctionName(path: any): string {
  const node = path.node;

  // FunctionDeclaration
  if (t.isFunctionDeclaration(node) && node.id) {
    return node.id.name;
  }

  // ClassMethod / ObjectMethod
  if (t.isClassMethod(node) || t.isObjectMethod(node)) {
    if (t.isIdentifier(node.key)) return node.key.name;
    if (t.isStringLiteral(node.key)) return node.key.value;
    return '<computed>';
  }

  // FunctionExpression with name
  if (t.isFunctionExpression(node) && node.id) {
    return node.id.name;
  }

  // Variable assignment: const foo = () => {} or const foo = function() {}
  if (
    path.parentPath &&
    path.parentPath.isVariableDeclarator() &&
    t.isIdentifier(path.parentPath.node.id)
  ) {
    return path.parentPath.node.id.name;
  }

  // Object property: { foo: () => {} }
  if (
    path.parentPath &&
    path.parentPath.isObjectProperty() &&
    t.isIdentifier(path.parentPath.node.key)
  ) {
    return path.parentPath.node.key.name;
  }

  // Export default
  if (path.parentPath && path.parentPath.isExportDefaultDeclaration()) {
    return 'default';
  }

  // Assignment expression: module.exports = function() {}
  if (
    path.parentPath &&
    path.parentPath.isAssignmentExpression() &&
    t.isMemberExpression(path.parentPath.node.left)
  ) {
    const left = path.parentPath.node.left;
    if (t.isIdentifier(left.property)) return left.property.name;
  }

  return '<anonymous>';
}

/**
 * Check if a function body is already wrapped in a utopia try/catch.
 */
function isAlreadyWrapped(body: t.BlockStatement): boolean {
  if (body.body.length === 0) return false;
  const first = body.body[0];
  if (!t.isTryStatement(first)) return false;
  // Check if there is a leading comment indicating utopia instrumentation
  const leadingComments = first.leadingComments;
  if (leadingComments && leadingComments.some((c: t.Comment) => c.value.includes('utopia:probe'))) {
    return true;
  }
  // Also check the try block covers the whole body
  if (body.body.length === 1 && t.isTryStatement(first)) {
    const catchClause = first.handler;
    if (catchClause && catchClause.param && t.isIdentifier(catchClause.param)) {
      if (catchClause.param.name === '__utopia_err') return true;
    }
  }
  return false;
}

/**
 * Check if a call expression is already wrapped in a utopia probe IIFE.
 */
function isInsideUtopiaIIFE(path: any): boolean {
  let current = path.parentPath;
  let depth = 0;
  while (current && depth < 10) {
    if (current.isCallExpression()) {
      const callee = current.node.callee;
      // Check for IIFE pattern: (async () => { ... })()
      if (
        t.isArrowFunctionExpression(callee) ||
        t.isFunctionExpression(callee)
      ) {
        // Check for utopia variable names in the body
        const body = callee.body;
        if (t.isBlockStatement(body)) {
          const bodySource = body.body.some(
            (stmt: t.Statement) =>
              t.isVariableDeclaration(stmt) &&
              stmt.declarations.some(
                (d: t.VariableDeclarator) =>
                  t.isIdentifier(d.id) &&
                  (d.id.name.startsWith('__utopia_db_') ||
                    d.id.name.startsWith('__utopia_api_'))
              )
          );
          if (bodySource) return true;
        }
      }
    }
    current = current.parentPath;
    depth++;
  }
  return false;
}

/**
 * Convert a CallExpression node to a readable string representation.
 */
function callExpressionToString(node: t.CallExpression): string {
  try {
    const result = generate(node, { concise: true });
    // Truncate very long call strings
    const str = result.code;
    if (str.length > 200) return str.slice(0, 200) + '...';
    return str;
  } catch {
    return '<unknown call>';
  }
}

// ---------------------------------------------------------------------------
// Detection helpers for DB / API patterns
// ---------------------------------------------------------------------------

interface DetectedDbCall {
  library: string;
  operation: string;
  table: string;
}

/**
 * Detect if a CallExpression is a database operation. Returns info or null.
 */
function detectDbCall(node: t.CallExpression): DetectedDbCall | null {
  const callee = node.callee;

  // Pattern: prisma.<model>.<method>()
  // e.g. prisma.user.findMany()
  if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) {
    const method = callee.property.name;
    if (PRISMA_METHODS.has(method)) {
      const obj = callee.object;
      if (t.isMemberExpression(obj) && t.isIdentifier(obj.property) && t.isIdentifier(obj.object)) {
        if (obj.object.name === 'prisma' || obj.object.name === 'db') {
          return { library: 'prisma', operation: method, table: obj.property.name };
        }
      }
    }
  }

  // Pattern: db.query(...), pool.query(...), connection.query(...)
  if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) {
    const method = callee.property.name;
    if (method === 'query' || method === 'execute') {
      const obj = callee.object;
      if (t.isIdentifier(obj)) {
        const name = obj.name.toLowerCase();
        if (
          name === 'db' ||
          name === 'pool' ||
          name === 'connection' ||
          name === 'client' ||
          name === 'conn' ||
          name === 'database' ||
          name === 'pg' ||
          name === 'mysql'
        ) {
          return { library: 'sql', operation: method, table: '<query>' };
        }
      }
    }
  }

  // Pattern: Model.find(...), Model.findOne(...), Model.create(...) (Mongoose)
  if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) {
    const method = callee.property.name;
    if (MONGOOSE_METHODS.has(method)) {
      const obj = callee.object;
      if (t.isIdentifier(obj)) {
        // Mongoose models are typically PascalCase
        const name = obj.name;
        if (name.length > 0 && name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase()) {
          return { library: 'mongoose', operation: method, table: name };
        }
      }
    }
  }

  // Pattern: knex('table').<method>() or knex.select()/knex.insert() etc.
  if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) {
    const method = callee.property.name;
    if (KNEX_QUERY_METHODS.has(method)) {
      const obj = callee.object;
      // knex('table').select()
      if (t.isCallExpression(obj) && t.isIdentifier(obj.callee)) {
        if (obj.callee.name === 'knex') {
          let table = '<table>';
          if (obj.arguments.length > 0 && t.isStringLiteral(obj.arguments[0])) {
            table = obj.arguments[0].value;
          }
          return { library: 'knex', operation: method, table };
        }
      }
      // knex.select()
      if (t.isIdentifier(obj) && obj.name === 'knex') {
        return { library: 'knex', operation: method, table: '<query>' };
      }
    }
  }

  return null;
}

interface DetectedApiCall {
  library: string;
  method: string;
}

/**
 * Detect if a CallExpression is an HTTP API call. Returns info or null.
 */
function detectApiCall(node: t.CallExpression): DetectedApiCall | null {
  const callee = node.callee;

  // Pattern: fetch(url, opts)
  if (t.isIdentifier(callee) && callee.name === 'fetch') {
    return { library: 'fetch', method: 'GET' };
  }

  // Pattern: axios.get(), axios.post(), axios.put(), axios.delete(), axios.patch()
  if (t.isMemberExpression(callee) && t.isIdentifier(callee.property) && t.isIdentifier(callee.object)) {
    if (callee.object.name === 'axios') {
      const method = callee.property.name.toUpperCase();
      if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'REQUEST'].includes(method)) {
        return { library: 'axios', method: method === 'REQUEST' ? 'UNKNOWN' : method };
      }
    }
  }

  // Pattern: axios(config)
  if (t.isIdentifier(callee) && callee.name === 'axios') {
    return { library: 'axios', method: 'UNKNOWN' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// AST builder helpers
// ---------------------------------------------------------------------------

/**
 * Build the utopia:probe comment node.
 */
function makeProbeComment(): t.CommentLine {
  return { type: 'CommentLine', value: ' utopia:probe' } as t.CommentLine;
}

/**
 * Add a leading comment to a node.
 */
function addProbeComment(node: t.Node): void {
  if (!node.leadingComments) {
    node.leadingComments = [];
  }
  node.leadingComments.push(makeProbeComment());
}

/**
 * Build the error probe try/catch wrapper.
 */
function buildErrorTryCatch(
  originalBody: t.Statement[],
  filePath: string,
  line: number,
  functionName: string,
  codeLine: string
): t.TryStatement {
  const catchParam = t.identifier('__utopia_err');

  const reportCall = t.expressionStatement(
    t.callExpression(
      t.memberExpression(t.identifier('__utopia'), t.identifier('reportError')),
      [
        t.objectExpression([
          t.objectProperty(t.identifier('file'), t.stringLiteral(filePath)),
          t.objectProperty(t.identifier('line'), t.numericLiteral(line)),
          t.objectProperty(t.identifier('functionName'), t.stringLiteral(functionName)),
          t.objectProperty(
            t.identifier('errorType'),
            t.logicalExpression(
              '||',
              t.optionalMemberExpression(
                t.optionalMemberExpression(
                  t.identifier('__utopia_err'),
                  t.identifier('constructor'),
                  false,
                  true
                ),
                t.identifier('name'),
                false,
                true
              ),
              t.stringLiteral('Error')
            )
          ),
          t.objectProperty(
            t.identifier('message'),
            t.logicalExpression(
              '||',
              t.optionalMemberExpression(
                t.identifier('__utopia_err'),
                t.identifier('message'),
                false,
                true
              ),
              t.callExpression(t.identifier('String'), [t.identifier('__utopia_err')])
            )
          ),
          t.objectProperty(
            t.identifier('stack'),
            t.logicalExpression(
              '||',
              t.optionalMemberExpression(
                t.identifier('__utopia_err'),
                t.identifier('stack'),
                false,
                true
              ),
              t.stringLiteral('')
            )
          ),
          t.objectProperty(t.identifier('inputData'), t.objectExpression([])),
          t.objectProperty(t.identifier('codeLine'), t.stringLiteral(codeLine)),
        ]),
      ]
    )
  );

  const rethrow = t.throwStatement(t.identifier('__utopia_err'));

  const catchBlock = t.blockStatement([reportCall, rethrow]);
  const catchClause = t.catchClause(catchParam, catchBlock);

  const tryBlock = t.blockStatement([...originalBody]);
  const tryStatement = t.tryStatement(tryBlock, catchClause);

  addProbeComment(tryStatement);
  return tryStatement;
}

/**
 * Build a database probe wrapper IIFE for a call expression.
 */
function buildDbProbeIIFE(
  originalCall: t.Expression,
  filePath: string,
  line: number,
  functionName: string,
  operation: string,
  callString: string,
  table: string,
  library: string
): t.CallExpression {
  const startVar = t.variableDeclaration('const', [
    t.variableDeclarator(
      t.identifier('__utopia_db_start'),
      t.callExpression(t.memberExpression(t.identifier('Date'), t.identifier('now')), [])
    ),
  ]);

  const resultVar = t.variableDeclaration('const', [
    t.variableDeclarator(
      t.identifier('__utopia_db_result'),
      t.awaitExpression(originalCall)
    ),
  ]);

  const durationExpr = t.binaryExpression(
    '-',
    t.callExpression(t.memberExpression(t.identifier('Date'), t.identifier('now')), []),
    t.identifier('__utopia_db_start')
  );

  const successReport = t.expressionStatement(
    t.callExpression(
      t.memberExpression(t.identifier('__utopia'), t.identifier('reportDb')),
      [
        t.objectExpression([
          t.objectProperty(t.identifier('file'), t.stringLiteral(filePath)),
          t.objectProperty(t.identifier('line'), t.numericLiteral(line)),
          t.objectProperty(t.identifier('functionName'), t.stringLiteral(functionName)),
          t.objectProperty(t.identifier('operation'), t.stringLiteral(operation)),
          t.objectProperty(t.identifier('query'), t.stringLiteral(callString)),
          t.objectProperty(t.identifier('table'), t.stringLiteral(table)),
          t.objectProperty(t.identifier('duration'), durationExpr),
          t.objectProperty(
            t.identifier('rowCount'),
            t.conditionalExpression(
              t.callExpression(
                t.memberExpression(t.identifier('Array'), t.identifier('isArray')),
                [t.identifier('__utopia_db_result')]
              ),
              t.memberExpression(t.identifier('__utopia_db_result'), t.identifier('length')),
              t.identifier('undefined')
            )
          ),
          t.objectProperty(
            t.identifier('connectionInfo'),
            t.objectExpression([
              t.objectProperty(t.identifier('type'), t.stringLiteral(library)),
            ])
          ),
        ]),
      ]
    )
  );

  const returnResult = t.returnStatement(t.identifier('__utopia_db_result'));

  const catchParam = t.identifier('__utopia_db_err');

  const errorDurationExpr = t.binaryExpression(
    '-',
    t.callExpression(t.memberExpression(t.identifier('Date'), t.identifier('now')), []),
    t.identifier('__utopia_db_start')
  );

  const errorReport = t.expressionStatement(
    t.callExpression(
      t.memberExpression(t.identifier('__utopia'), t.identifier('reportDb')),
      [
        t.objectExpression([
          t.objectProperty(t.identifier('file'), t.stringLiteral(filePath)),
          t.objectProperty(t.identifier('line'), t.numericLiteral(line)),
          t.objectProperty(t.identifier('functionName'), t.stringLiteral(functionName)),
          t.objectProperty(t.identifier('operation'), t.stringLiteral(operation)),
          t.objectProperty(t.identifier('query'), t.stringLiteral(callString)),
          t.objectProperty(t.identifier('duration'), errorDurationExpr),
          t.objectProperty(
            t.identifier('connectionInfo'),
            t.objectExpression([
              t.objectProperty(t.identifier('type'), t.stringLiteral(library)),
            ])
          ),
          t.objectProperty(
            t.identifier('error'),
            t.optionalMemberExpression(
              t.identifier('__utopia_db_err'),
              t.identifier('message'),
              false,
              true
            )
          ),
        ]),
      ]
    )
  );

  const rethrow = t.throwStatement(t.identifier('__utopia_db_err'));

  const tryStatement = t.tryStatement(
    t.blockStatement([resultVar, successReport, returnResult]),
    t.catchClause(catchParam, t.blockStatement([errorReport, rethrow]))
  );

  const arrowBody = t.blockStatement([startVar, tryStatement]);
  const arrow = t.arrowFunctionExpression([], arrowBody, true);

  const iife = t.callExpression(arrow, []);
  const awaitedIife = t.awaitExpression(iife);

  // We return the call expression (the IIFE call), the await is handled by placement
  return iife;
}

/**
 * Build an API probe wrapper IIFE for a call expression.
 */
function buildApiProbeIIFE(
  originalCall: t.Expression,
  filePath: string,
  line: number,
  functionName: string,
  method: string,
  library: string
): t.CallExpression {
  const startVar = t.variableDeclaration('const', [
    t.variableDeclarator(
      t.identifier('__utopia_api_start'),
      t.callExpression(t.memberExpression(t.identifier('Date'), t.identifier('now')), [])
    ),
  ]);

  const resultVar = t.variableDeclaration('const', [
    t.variableDeclarator(
      t.identifier('__utopia_api_result'),
      t.awaitExpression(originalCall)
    ),
  ]);

  const durationExpr = t.binaryExpression(
    '-',
    t.callExpression(t.memberExpression(t.identifier('Date'), t.identifier('now')), []),
    t.identifier('__utopia_api_start')
  );

  // Build URL extraction depending on library
  let urlExpr: t.Expression;
  let methodExpr: t.Expression;
  let statusCodeExpr: t.Expression;

  if (library === 'fetch') {
    // For fetch: first arg is the URL, response has .status
    urlExpr = t.callExpression(t.identifier('String'), [
      t.logicalExpression(
        '||',
        t.optionalMemberExpression(
          t.identifier('__utopia_api_result'),
          t.identifier('url'),
          false,
          true
        ),
        t.stringLiteral('')
      ),
    ]);
    statusCodeExpr = t.logicalExpression(
      '||',
      t.optionalMemberExpression(
        t.identifier('__utopia_api_result'),
        t.identifier('status'),
        false,
        true
      ),
      t.numericLiteral(0)
    );
    methodExpr = t.stringLiteral(method);
  } else {
    // For axios: response has .status, .config.url, .config.method
    urlExpr = t.logicalExpression(
      '||',
      t.optionalMemberExpression(
        t.optionalMemberExpression(
          t.identifier('__utopia_api_result'),
          t.identifier('config'),
          false,
          true
        ),
        t.identifier('url'),
        false,
        true
      ),
      t.stringLiteral('')
    );
    statusCodeExpr = t.logicalExpression(
      '||',
      t.optionalMemberExpression(
        t.identifier('__utopia_api_result'),
        t.identifier('status'),
        false,
        true
      ),
      t.numericLiteral(0)
    );
    methodExpr = t.logicalExpression(
      '||',
      t.optionalMemberExpression(
        t.optionalMemberExpression(
          t.identifier('__utopia_api_result'),
          t.identifier('config'),
          false,
          true
        ),
        t.identifier('method'),
        false,
        true
      ),
      t.stringLiteral(method)
    );
  }

  const successReport = t.expressionStatement(
    t.callExpression(
      t.memberExpression(t.identifier('__utopia'), t.identifier('reportApi')),
      [
        t.objectExpression([
          t.objectProperty(t.identifier('file'), t.stringLiteral(filePath)),
          t.objectProperty(t.identifier('line'), t.numericLiteral(line)),
          t.objectProperty(t.identifier('functionName'), t.stringLiteral(functionName)),
          t.objectProperty(t.identifier('method'), methodExpr),
          t.objectProperty(t.identifier('url'), urlExpr),
          t.objectProperty(t.identifier('statusCode'), statusCodeExpr),
          t.objectProperty(t.identifier('duration'), durationExpr),
        ]),
      ]
    )
  );

  const returnResult = t.returnStatement(t.identifier('__utopia_api_result'));

  const catchParam = t.identifier('__utopia_api_err');

  const errorDurationExpr = t.binaryExpression(
    '-',
    t.callExpression(t.memberExpression(t.identifier('Date'), t.identifier('now')), []),
    t.identifier('__utopia_api_start')
  );

  const errorReport = t.expressionStatement(
    t.callExpression(
      t.memberExpression(t.identifier('__utopia'), t.identifier('reportApi')),
      [
        t.objectExpression([
          t.objectProperty(t.identifier('file'), t.stringLiteral(filePath)),
          t.objectProperty(t.identifier('line'), t.numericLiteral(line)),
          t.objectProperty(t.identifier('functionName'), t.stringLiteral(functionName)),
          t.objectProperty(t.identifier('method'), t.stringLiteral(method)),
          t.objectProperty(t.identifier('url'), t.stringLiteral('')),
          t.objectProperty(t.identifier('statusCode'), t.numericLiteral(0)),
          t.objectProperty(t.identifier('duration'), errorDurationExpr),
          t.objectProperty(
            t.identifier('error'),
            t.optionalMemberExpression(
              t.identifier('__utopia_api_err'),
              t.identifier('message'),
              false,
              true
            )
          ),
        ]),
      ]
    )
  );

  const rethrow = t.throwStatement(t.identifier('__utopia_api_err'));

  const tryStatement = t.tryStatement(
    t.blockStatement([resultVar, successReport, returnResult]),
    t.catchClause(catchParam, t.blockStatement([errorReport, rethrow]))
  );

  const arrowBody = t.blockStatement([startVar, tryStatement]);
  const arrow = t.arrowFunctionExpression([], arrowBody, true);

  return t.callExpression(arrow, []);
}

/**
 * Build the infra probe report statement for entry point files.
 */
function buildInfraProbeStatement(filePath: string): t.ExpressionStatement {
  // Build: process.env.AWS_REGION ? 'aws' : process.env.GOOGLE_CLOUD_PROJECT ? 'gcp' : process.env.VERCEL ? 'vercel' : 'other'
  const envAccess = (key: string) =>
    t.memberExpression(
      t.memberExpression(t.identifier('process'), t.identifier('env')),
      t.identifier(key)
    );

  const providerExpr = t.conditionalExpression(
    envAccess('AWS_REGION'),
    t.stringLiteral('aws'),
    t.conditionalExpression(
      envAccess('GOOGLE_CLOUD_PROJECT'),
      t.stringLiteral('gcp'),
      t.conditionalExpression(
        envAccess('VERCEL'),
        t.stringLiteral('vercel'),
        t.stringLiteral('other')
      )
    )
  );

  const regionExpr = t.logicalExpression(
    '||',
    t.logicalExpression(
      '||',
      t.logicalExpression(
        '||',
        envAccess('AWS_REGION'),
        envAccess('GOOGLE_CLOUD_REGION')
      ),
      envAccess('VERCEL_REGION')
    ),
    t.identifier('undefined')
  );

  const serviceTypeExpr = t.conditionalExpression(
    envAccess('AWS_LAMBDA_FUNCTION_NAME'),
    t.stringLiteral('lambda'),
    t.conditionalExpression(
      envAccess('K_SERVICE'),
      t.stringLiteral('cloud-run'),
      t.conditionalExpression(
        envAccess('VERCEL'),
        t.stringLiteral('vercel'),
        t.identifier('undefined')
      )
    )
  );

  const instanceIdExpr = t.logicalExpression(
    '||',
    envAccess('HOSTNAME'),
    t.identifier('undefined')
  );

  // Filter env vars to exclude secrets:
  // Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.includes('KEY') && ...))
  const filterExpr = t.callExpression(
    t.memberExpression(t.identifier('Object'), t.identifier('fromEntries')),
    [
      t.callExpression(
        t.memberExpression(
          t.callExpression(
            t.memberExpression(t.identifier('Object'), t.identifier('entries')),
            [t.memberExpression(t.identifier('process'), t.identifier('env'))]
          ),
          t.identifier('filter')
        ),
        [
          t.arrowFunctionExpression(
            [t.arrayPattern([t.identifier('k')])],
            t.logicalExpression(
              '&&',
              t.logicalExpression(
                '&&',
                t.logicalExpression(
                  '&&',
                  t.unaryExpression(
                    '!',
                    t.callExpression(
                      t.memberExpression(t.identifier('k'), t.identifier('includes')),
                      [t.stringLiteral('KEY')]
                    )
                  ),
                  t.unaryExpression(
                    '!',
                    t.callExpression(
                      t.memberExpression(t.identifier('k'), t.identifier('includes')),
                      [t.stringLiteral('SECRET')]
                    )
                  )
                ),
                t.unaryExpression(
                  '!',
                  t.callExpression(
                    t.memberExpression(t.identifier('k'), t.identifier('includes')),
                    [t.stringLiteral('TOKEN')]
                  )
                )
              ),
              t.unaryExpression(
                '!',
                t.callExpression(
                  t.memberExpression(t.identifier('k'), t.identifier('includes')),
                  [t.stringLiteral('PASSWORD')]
                )
              )
            )
          ),
        ]
      ),
    ]
  );

  // process.memoryUsage?.()?.heapUsed || 0
  const memoryExpr = t.logicalExpression(
    '||',
    t.optionalMemberExpression(
      t.optionalCallExpression(
        t.optionalMemberExpression(
          t.identifier('process'),
          t.identifier('memoryUsage'),
          false,
          true
        ),
        [],
        true
      ),
      t.identifier('heapUsed'),
      false,
      true
    ),
    t.numericLiteral(0)
  );

  const reportCall = t.expressionStatement(
    t.callExpression(
      t.memberExpression(t.identifier('__utopia'), t.identifier('reportInfra')),
      [
        t.objectExpression([
          t.objectProperty(t.identifier('file'), t.stringLiteral(filePath)),
          t.objectProperty(t.identifier('line'), t.numericLiteral(1)),
          t.objectProperty(t.identifier('provider'), providerExpr),
          t.objectProperty(t.identifier('region'), regionExpr),
          t.objectProperty(t.identifier('serviceType'), serviceTypeExpr),
          t.objectProperty(t.identifier('instanceId'), instanceIdExpr),
          t.objectProperty(t.identifier('envVars'), filterExpr),
          t.objectProperty(t.identifier('memoryUsage'), memoryExpr),
        ]),
      ]
    )
  );

  addProbeComment(reportCall);
  return reportCall;
}

/**
 * Build a function probe wrapper for Utopia mode.
 * Wraps function body with timing + arg capture + reportFunction call.
 * For Utopia mode, also calls reportLlmContext with function source context.
 */
function buildFunctionProbeWrapper(
  originalBody: t.Statement[],
  filePath: string,
  line: number,
  functionName: string,
  paramNames: string[],
  utopiaMode: boolean
): t.Statement[] {
  // const __utopia_fn_start = Date.now();
  const startDecl = t.variableDeclaration('const', [
    t.variableDeclarator(
      t.identifier('__utopia_fn_start'),
      t.callExpression(
        t.memberExpression(t.identifier('Date'), t.identifier('now')),
        []
      )
    ),
  ]);
  addProbeComment(startDecl);

  // Build args capture: { param1: param1, param2: param2 }
  const argsCapture = t.arrayExpression(
    paramNames.map(name => {
      try {
        return t.identifier(name);
      } catch {
        return t.stringLiteral(`<${name}>`);
      }
    })
  );

  // __utopia.reportFunction({ file, line, functionName, args, duration, callStack })
  const reportFnCall = t.expressionStatement(
    t.callExpression(
      t.memberExpression(t.identifier('__utopia'), t.identifier('reportFunction')),
      [
        t.objectExpression([
          t.objectProperty(t.identifier('file'), t.stringLiteral(filePath)),
          t.objectProperty(t.identifier('line'), t.numericLiteral(line)),
          t.objectProperty(t.identifier('functionName'), t.stringLiteral(functionName)),
          t.objectProperty(t.identifier('args'), argsCapture),
          t.objectProperty(
            t.identifier('returnValue'),
            t.identifier('__utopia_fn_result')
          ),
          t.objectProperty(
            t.identifier('duration'),
            t.binaryExpression(
              '-',
              t.callExpression(
                t.memberExpression(t.identifier('Date'), t.identifier('now')),
                []
              ),
              t.identifier('__utopia_fn_start')
            )
          ),
          t.objectProperty(
            t.identifier('callStack'),
            t.callExpression(
              t.memberExpression(
                t.logicalExpression(
                  '||',
                  t.optionalMemberExpression(
                    t.newExpression(t.identifier('Error'), []),
                    t.identifier('stack'),
                    false,
                    true
                  ),
                  t.stringLiteral('')
                ),
                t.identifier('split')
              ),
              [t.stringLiteral('\n')]
            )
          ),
        ]),
      ]
    )
  );

  // Build the utopia mode LLM context call if enabled
  const llmReportStmts: t.Statement[] = [];
  if (utopiaMode) {
    // __utopia.reportLlmContext({ file, line, functionName, context: JSON.stringify({ functionName, args, returnValue, duration }) })
    const llmCall = t.expressionStatement(
      t.callExpression(
        t.memberExpression(t.identifier('__utopia'), t.identifier('reportLlmContext')),
        [
          t.objectExpression([
            t.objectProperty(t.identifier('file'), t.stringLiteral(filePath)),
            t.objectProperty(t.identifier('line'), t.numericLiteral(line)),
            t.objectProperty(t.identifier('functionName'), t.stringLiteral(functionName)),
            t.objectProperty(
              t.identifier('context'),
              t.callExpression(
                t.memberExpression(t.identifier('JSON'), t.identifier('stringify')),
                [
                  t.objectExpression([
                    t.objectProperty(t.identifier('function'), t.stringLiteral(functionName)),
                    t.objectProperty(t.identifier('file'), t.stringLiteral(filePath)),
                    t.objectProperty(t.identifier('args'), argsCapture),
                    t.objectProperty(t.identifier('returnValue'), t.identifier('__utopia_fn_result')),
                    t.objectProperty(
                      t.identifier('duration'),
                      t.binaryExpression(
                        '-',
                        t.callExpression(
                          t.memberExpression(t.identifier('Date'), t.identifier('now')),
                          []
                        ),
                        t.identifier('__utopia_fn_start')
                      )
                    ),
                  ]),
                ]
              )
            ),
          ]),
        ]
      )
    );
    llmReportStmts.push(llmCall);
  }

  // let __utopia_fn_result;
  const resultDecl = t.variableDeclaration('let', [
    t.variableDeclarator(t.identifier('__utopia_fn_result'), t.identifier('undefined')),
  ]);

  // try { <original body with result capture> } finally { report }
  // We need to capture the return value. Wrap in try/finally:
  // try { __utopia_fn_result = (() => { <original body> })(); } finally { reportFunction(); }
  // Simpler approach: just wrap and report in finally block
  const finallyBlock = t.blockStatement([reportFnCall, ...llmReportStmts]);

  const tryStatement = t.tryStatement(
    t.blockStatement([...originalBody]),
    null,
    finallyBlock
  );

  return [startDecl, resultDecl, tryStatement];
}

/**
 * Build the utopia runtime import declaration.
 */
function buildUtopiaImport(): t.ImportDeclaration {
  return t.importDeclaration(
    [t.importSpecifier(t.identifier('__utopia'), t.identifier('__utopia'))],
    t.stringLiteral('utopia-runtime')
  );
}

/**
 * Check if the AST already has an import from 'utopia-runtime'.
 */
function hasUtopiaImport(ast: t.File): boolean {
  for (const node of ast.program.body) {
    if (
      t.isImportDeclaration(node) &&
      node.source.value === 'utopia-runtime'
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Core instrumenter
// ---------------------------------------------------------------------------

/**
 * Instrument a single JavaScript/TypeScript file.
 */
export async function instrumentFile(
  filePath: string,
  options: InstrumentOptions
): Promise<InstrumentResult> {
  const absolutePath = resolve(filePath);
  const probesAdded: { type: string; line: number; functionName: string }[] = [];

  try {
    const source = await readFile(absolutePath, 'utf-8');
    const relPath = relative(process.cwd(), absolutePath);
    const plugins = getParserPlugins(absolutePath);

    let ast: t.File;
    try {
      ast = parser.parse(source, {
        sourceType: getSourceType(absolutePath),
        plugins,
        errorRecovery: true,
      });
    } catch (parseError: any) {
      return {
        file: relPath,
        probesAdded: [],
        success: false,
        error: `Parse error: ${parseError.message}`,
      };
    }

    const shouldInstrument = {
      error: options.probeTypes.includes('error'),
      database: options.probeTypes.includes('database'),
      api: options.probeTypes.includes('api'),
      infra: options.probeTypes.includes('infra'),
      function: options.probeTypes.includes('function'),
    };

    const isEntry = isEntryPoint(absolutePath, options.entryPoints);

    // -----------------------------------------------------------------------
    // Traverse the AST and inject probes
    // -----------------------------------------------------------------------

    traverse(ast, {
      // ---- Error probes: wrap function bodies in try/catch ----
      'FunctionDeclaration|ArrowFunctionExpression|FunctionExpression|ClassMethod'(
        path: any
      ) {
        if (!shouldInstrument.error) return;

        const node = path.node;
        let body: t.BlockStatement | null = null;

        if (t.isArrowFunctionExpression(node)) {
          if (t.isBlockStatement(node.body)) {
            body = node.body;
          } else {
            // Expression body arrow: () => expr
            // Convert to block: () => { return expr; }
            const returnStmt = t.returnStatement(node.body as t.Expression);
            body = t.blockStatement([returnStmt]);
            node.body = body;
          }
        } else if (
          t.isFunctionDeclaration(node) ||
          t.isFunctionExpression(node) ||
          t.isClassMethod(node)
        ) {
          body = node.body;
        }

        if (!body || body.body.length === 0) return;
        if (isAlreadyWrapped(body)) return;

        const fnName = getFunctionName(path);
        const line = node.loc?.start?.line ?? 0;
        const codeLine = getSourceLine(source, line);

        const tryCatch = buildErrorTryCatch(
          [...body.body],
          relPath,
          line,
          fnName,
          codeLine
        );

        body.body = [tryCatch];

        probesAdded.push({ type: 'error', line, functionName: fnName });
      },

      // ---- Database and API probes: wrap call expressions ----
      CallExpression(path: any) {
        if (!shouldInstrument.database && !shouldInstrument.api) return;

        const node = path.node as t.CallExpression;
        const line = node.loc?.start?.line ?? 0;

        // Skip if already inside a utopia IIFE
        if (isInsideUtopiaIIFE(path)) return;

        // ---- Database probes ----
        if (shouldInstrument.database) {
          const dbInfo = detectDbCall(node);
          if (dbInfo) {
            const fnName = getEnclosingFnName(path);
            const callStr = callExpressionToString(node);

            const iife = buildDbProbeIIFE(
              t.cloneNode(node, true),
              relPath,
              line,
              fnName,
              dbInfo.operation,
              callStr,
              dbInfo.table,
              dbInfo.library
            );

            // Replace the call expression with an awaited IIFE
            path.replaceWith(t.awaitExpression(iife));
            path.skip(); // Don't re-traverse the replacement

            probesAdded.push({
              type: 'database',
              line,
              functionName: fnName,
            });
            return;
          }
        }

        // ---- API probes ----
        if (shouldInstrument.api) {
          const apiInfo = detectApiCall(node);
          if (apiInfo) {
            const fnName = getEnclosingFnName(path);

            const iife = buildApiProbeIIFE(
              t.cloneNode(node, true),
              relPath,
              line,
              fnName,
              apiInfo.method,
              apiInfo.library
            );

            path.replaceWith(t.awaitExpression(iife));
            path.skip();

            probesAdded.push({
              type: 'api',
              line,
              functionName: fnName,
            });
            return;
          }
        }
      },
    });

    // ---- Function probes (Utopia mode): wrap functions with timing + reporting ----
    if (shouldInstrument.function) {
      traverse(ast, {
        'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ClassMethod'(
          path: any
        ) {
          const node = path.node;
          let body: t.BlockStatement | null = null;

          if (t.isArrowFunctionExpression(node)) {
            if (t.isBlockStatement(node.body)) {
              body = node.body;
            } else {
              const returnStmt = t.returnStatement(node.body as t.Expression);
              body = t.blockStatement([returnStmt]);
              node.body = body;
            }
          } else if (
            t.isFunctionDeclaration(node) ||
            t.isFunctionExpression(node) ||
            t.isClassMethod(node)
          ) {
            body = node.body;
          }

          if (!body || body.body.length === 0) return;

          // Skip if already has function probe (check for __utopia_fn_start)
          const hasProbe = body.body.some(
            (s: t.Statement) =>
              t.isVariableDeclaration(s) &&
              s.declarations.some(
                (d: t.VariableDeclarator) =>
                  t.isIdentifier(d.id) && d.id.name === '__utopia_fn_start'
              )
          );
          if (hasProbe) return;

          // Only instrument "interesting" functions for now:
          // - DB call handlers, API handlers, exported functions, named functions > 3 statements
          const fnName = getFunctionName(path);
          if (!fnName || fnName === '<anonymous>') return;
          if (body.body.length < 2) return; // Skip trivial functions

          const line = node.loc?.start?.line ?? 0;

          // Extract parameter names
          const params: string[] = (node.params || [])
            .map((p: t.Node) => {
              if (t.isIdentifier(p)) return p.name;
              if (t.isAssignmentPattern(p) && t.isIdentifier(p.left)) return p.left.name;
              if (t.isRestElement(p) && t.isIdentifier(p.argument)) return p.argument.name;
              return null;
            })
            .filter(Boolean) as string[];

          const wrappedBody = buildFunctionProbeWrapper(
            [...body.body],
            relPath,
            line,
            fnName,
            params,
            options.utopiaMode
          );

          body.body = wrappedBody;
          probesAdded.push({ type: 'function', line, functionName: fnName });
        },
      });
    }

    // ---- Infra probe: add at module level for entry points ----
    if (shouldInstrument.infra && isEntry) {
      const infraStmt = buildInfraProbeStatement(relPath);

      // Insert after all imports
      let insertIndex = 0;
      for (let i = 0; i < ast.program.body.length; i++) {
        const stmt = ast.program.body[i];
        if (t.isImportDeclaration(stmt)) {
          insertIndex = i + 1;
        }
      }

      ast.program.body.splice(insertIndex, 0, infraStmt);
      probesAdded.push({ type: 'infra', line: 1, functionName: '<module>' });
    }

    // ---- Add utopia runtime import if probes were added ----
    if (probesAdded.length > 0 && !hasUtopiaImport(ast)) {
      const importDecl = buildUtopiaImport();
      // Insert at very top (before other imports)
      ast.program.body.unshift(importDecl);
    }

    // ---- Generate output ----
    const output = generate(ast, {
      retainLines: true,
      comments: true,
    });

    if (!options.dryRun) {
      await writeFile(absolutePath, output.code, 'utf-8');
    }

    return {
      file: relPath,
      probesAdded,
      success: true,
    };
  } catch (error: any) {
    return {
      file: relative(process.cwd(), absolutePath),
      probesAdded: [],
      success: false,
      error: error.message,
    };
  }
}

// ---------------------------------------------------------------------------
// Directory instrumenter
// ---------------------------------------------------------------------------

/**
 * Recursively collect all instrumentable files in a directory.
 */
async function collectFiles(dirPath: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);

      // Skip hidden directories and known non-source dirs
      if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;

      let stats;
      try {
        stats = await stat(fullPath);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        await walk(fullPath);
      } else if (stats.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (!VALID_EXTENSIONS.has(ext)) continue;

        // Skip test files, spec files, and declaration files
        const name = entry.toLowerCase();
        if (name.endsWith('.test.ts') || name.endsWith('.test.js')) continue;
        if (name.endsWith('.test.tsx') || name.endsWith('.test.jsx')) continue;
        if (name.endsWith('.spec.ts') || name.endsWith('.spec.js')) continue;
        if (name.endsWith('.spec.tsx') || name.endsWith('.spec.jsx')) continue;
        if (name.endsWith('.d.ts')) continue;

        results.push(fullPath);
      }
    }
  }

  await walk(dirPath);
  return results;
}

/**
 * Instrument all eligible files in a directory recursively.
 */
export async function instrumentDirectory(
  dirPath: string,
  options: InstrumentOptions
): Promise<InstrumentResult[]> {
  const absoluteDir = resolve(dirPath);
  const files = await collectFiles(absoluteDir);
  const results: InstrumentResult[] = [];

  for (const file of files) {
    const result = await instrumentFile(file, options);
    results.push(result);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that instrumentation was applied correctly to a file.
 * Parses the file, checks for syntax errors, and verifies probe markers.
 */
export async function validateInstrumentation(
  filePath: string
): Promise<ValidationResult> {
  const absolutePath = resolve(filePath);
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const source = await readFile(absolutePath, 'utf-8');
    const plugins = getParserPlugins(absolutePath);

    let ast: t.File;
    try {
      ast = parser.parse(source, {
        sourceType: getSourceType(absolutePath),
        plugins,
        errorRecovery: true,
      });
    } catch (parseError: any) {
      return {
        valid: false,
        errors: [`Syntax error after instrumentation: ${parseError.message}`],
        warnings: [],
      };
    }

    // Check for parser errors stored in the AST
    const astAny = ast as any;
    if (astAny.errors && astAny.errors.length > 0) {
      for (const err of astAny.errors) {
        errors.push(`Parser error: ${err?.message || String(err)}`);
      }
    }

    // Check that utopia:probe comments exist and are followed by valid code
    let probeCommentCount = 0;
    let validProbeCount = 0;

    traverse(ast, {
      enter(path: any) {
        const node = path.node;
        if (!node.leadingComments) return;

        for (const comment of node.leadingComments) {
          if (comment.value.includes('utopia:probe')) {
            probeCommentCount++;

            // Verify the node after the comment is a valid probe construct
            if (t.isTryStatement(node)) {
              // Error probe: check catch param is __utopia_err
              if (
                node.handler &&
                node.handler.param &&
                t.isIdentifier(node.handler.param) &&
                node.handler.param.name === '__utopia_err'
              ) {
                validProbeCount++;
              } else {
                warnings.push(
                  `Probe comment at line ${node.loc?.start?.line ?? '?'} followed by try/catch without expected __utopia_err parameter`
                );
              }
            } else if (t.isExpressionStatement(node)) {
              // Could be infra probe or other report call
              const expr = node.expression;
              if (
                t.isCallExpression(expr) &&
                t.isMemberExpression(expr.callee) &&
                t.isIdentifier(expr.callee.object) &&
                expr.callee.object.name === '__utopia'
              ) {
                validProbeCount++;
              } else {
                warnings.push(
                  `Probe comment at line ${node.loc?.start?.line ?? '?'} not followed by expected __utopia call`
                );
              }
            } else {
              warnings.push(
                `Probe comment at line ${node.loc?.start?.line ?? '?'} followed by unexpected node type: ${node.type}`
              );
            }
          }
        }
      },
    });

    if (probeCommentCount === 0) {
      warnings.push('No utopia:probe markers found in file');
    }

    // Verify utopia-runtime import exists if probes are present
    if (probeCommentCount > 0 && !hasUtopiaImport(ast)) {
      errors.push(
        'File has utopia:probe markers but is missing "utopia-runtime" import'
      );
    }

    // Check for unmatched __utopia references (should all be guarded by import)
    let hasUtopiaRef = false;
    traverse(ast, {
      Identifier(path: any) {
        if (path.node.name === '__utopia') {
          hasUtopiaRef = true;
          path.stop();
        }
      },
    });

    if (hasUtopiaRef && !hasUtopiaImport(ast)) {
      errors.push(
        'File references __utopia but does not import from utopia-runtime'
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  } catch (error: any) {
    return {
      valid: false,
      errors: [`Validation failed: ${error.message}`],
      warnings: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Entry point detection
// ---------------------------------------------------------------------------

/**
 * Determine if a file is considered an entry point.
 */
export function isEntryPoint(
  filePath: string,
  customEntryPoints?: string[]
): boolean {
  const absolutePath = resolve(filePath);
  const base = basename(absolutePath);
  const normalizedPath = absolutePath.replace(/\\/g, '/');

  // Check against well-known entry point basenames
  if (ENTRY_POINT_BASENAMES.has(base)) {
    return true;
  }

  // Check Next.js API route patterns
  if (
    normalizedPath.includes('/pages/api/') ||
    normalizedPath.includes('/src/pages/api/') ||
    normalizedPath.includes('/app/api/')
  ) {
    return true;
  }

  // Check custom entry points
  if (customEntryPoints) {
    for (const pattern of customEntryPoints) {
      const resolvedPattern = resolve(pattern);
      if (absolutePath === resolvedPattern) {
        return true;
      }
      // Support glob-like suffix matching: if pattern ends with **, treat as directory prefix
      if (pattern.endsWith('**')) {
        const prefix = resolve(pattern.slice(0, -2));
        if (absolutePath.startsWith(prefix)) {
          return true;
        }
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type { InstrumentOptions, InstrumentResult, ValidationResult };
