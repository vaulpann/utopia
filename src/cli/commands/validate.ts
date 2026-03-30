import { Command } from 'commander';
import chalk from 'chalk';
import { resolve, extname, relative } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { configExists } from '../utils/config.js';

interface ValidationResult {
  file: string;
  passed: boolean;
  probeCount: number;
  warnings: string[];
  errors: string[];
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.utopia', 'dist', 'build', '__pycache__',
  '.next', '.vercel', 'coverage', '.nyc_output', 'venv', '.venv', 'env',
]);

async function findInstrumentedFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      if (IGNORED_DIRS.has(entry.name)) continue;

      const fullPath = resolve(currentDir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if (['.js', '.jsx', '.ts', '.tsx', '.py'].includes(ext)) {
          try {
            const content = await readFile(fullPath, 'utf-8');
            if (content.includes('// utopia:probe') || content.includes('# utopia:probe')) {
              files.push(fullPath);
            }
          } catch {
            // Skip files that can't be read
          }
        }
      }
    }
  }

  await walk(dir);
  return files;
}

async function validateJavaScriptFile(filePath: string): Promise<ValidationResult> {
  const relPath = relative(process.cwd(), filePath);
  const warnings: string[] = [];
  const errors: string[] = [];
  let probeCount = 0;

  try {
    const content = await readFile(filePath, 'utf-8');

    // Count probes
    const probeMatches = content.match(/\/\/ utopia:probe/g);
    probeCount = probeMatches ? probeMatches.length : 0;

    // Check for probe imports (supports both 'utopia-runtime' and legacy '@utopia/runtime')
    const hasRuntimeImport =
      content.includes('utopia-runtime') ||
      content.includes('@utopia/runtime') ||
      content.includes('utopia/runtime');
    if (probeCount > 0 && !hasRuntimeImport) {
      warnings.push('File has probes but no Utopia runtime import detected');
    }

    // Parse with Babel to check syntax validity
    try {
      const babel = await import('@babel/parser');
      const isTypeScript = filePath.endsWith('.ts') || filePath.endsWith('.tsx');
      const isJSX = filePath.endsWith('.jsx') || filePath.endsWith('.tsx');

      const plugins: any[] = [];
      if (isTypeScript) plugins.push('typescript');
      if (isJSX) plugins.push('jsx');
      if (!isTypeScript && !isJSX) plugins.push('jsx'); // JS files might have JSX

      babel.parse(content, {
        sourceType: 'module',
        plugins,
        errorRecovery: true,
      });
    } catch (parseError) {
      errors.push(`Syntax error: ${(parseError as Error).message}`);
    }

    // Check for common probe issues
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('// utopia:probe')) {
        // Check that the next non-empty line looks like a probe call
        let nextLineIdx = i + 1;
        while (nextLineIdx < lines.length && lines[nextLineIdx].trim() === '') {
          nextLineIdx++;
        }

        if (nextLineIdx < lines.length) {
          const nextLine = lines[nextLineIdx].trim();
          if (!nextLine.includes('utopia') && !nextLine.includes('__utopia')) {
            warnings.push(`Line ${i + 1}: Probe marker found but next line doesn't appear to be a probe call`);
          }
        }
      }
    }

    return {
      file: relPath,
      passed: errors.length === 0,
      probeCount,
      warnings,
      errors,
    };
  } catch (err) {
    return {
      file: relPath,
      passed: false,
      probeCount: 0,
      warnings,
      errors: [`Failed to read or validate file: ${(err as Error).message}`],
    };
  }
}

function validatePythonFile(filePath: string): Promise<ValidationResult> {
  const relPath = relative(process.cwd(), filePath);

  return new Promise((resolvePromise) => {
    const child = spawn('python3', [
      resolve(process.cwd(), 'python/instrumenter/instrument.py'),
      'validate',
      filePath,
    ], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', async (code) => {
      if (code === 0) {
        try {
          const output = JSON.parse(stdout.trim());
          resolvePromise({
            file: relPath,
            passed: output.passed ?? true,
            probeCount: output.probe_count ?? 0,
            warnings: output.warnings ?? [],
            errors: output.errors ?? [],
          });
          return;
        } catch {
          // If can't parse output, fall through to manual validation
        }
      }

      // Fallback: do basic validation manually
      try {
        const content = await readFile(filePath, 'utf-8');
        const probeMatches = content.match(/# utopia:probe/g);
        const probeCount = probeMatches ? probeMatches.length : 0;
        const warnings: string[] = [];
        const errors: string[] = [];

        // Check for import
        const hasImport = content.includes('from utopia') || content.includes('import utopia');
        if (probeCount > 0 && !hasImport) {
          warnings.push('File has probes but no Utopia import detected');
        }

        // Check Python syntax using python3 -c "compile(...)"
        const syntaxCheck = spawn('python3', ['-c', `compile(open("${filePath}").read(), "${filePath}", "exec")`]);
        let syntaxErr = '';
        syntaxCheck.stderr.on('data', (data: Buffer) => { syntaxErr += data.toString(); });

        syntaxCheck.on('close', (syntaxCode) => {
          if (syntaxCode !== 0) {
            errors.push(`Python syntax error: ${syntaxErr.trim()}`);
          }
          resolvePromise({
            file: relPath,
            passed: errors.length === 0,
            probeCount,
            warnings,
            errors,
          });
        });

        syntaxCheck.on('error', () => {
          warnings.push('Could not verify Python syntax (python3 not found)');
          resolvePromise({
            file: relPath,
            passed: true,
            probeCount,
            warnings,
            errors,
          });
        });
      } catch (err) {
        resolvePromise({
          file: relPath,
          passed: false,
          probeCount: 0,
          warnings: [],
          errors: [`Failed to validate: ${(err as Error).message}`],
        });
      }
    });

    child.on('error', async () => {
      // Python instrumenter not available, do manual validation
      try {
        const content = await readFile(filePath, 'utf-8');
        const probeMatches = content.match(/# utopia:probe/g);
        const probeCount = probeMatches ? probeMatches.length : 0;
        const warnings: string[] = ['Python instrumenter not available, performed basic validation only'];

        resolvePromise({
          file: relPath,
          passed: true,
          probeCount,
          warnings,
          errors: [],
        });
      } catch (err) {
        resolvePromise({
          file: relPath,
          passed: false,
          probeCount: 0,
          warnings: [],
          errors: [`Failed to read file: ${(err as Error).message}`],
        });
      }
    });
  });
}

export const validateCommand = new Command('validate')
  .description('Validate instrumented probes in your codebase')
  .action(async () => {
    const cwd = process.cwd();

    if (!configExists(cwd)) {
      console.log(chalk.red('\n  Error: No .utopia/config.json found.'));
      console.log(chalk.dim('  Run "utopia init" first to set up your project.\n'));
      process.exit(1);
    }

    console.log(chalk.bold.cyan('\n  Validating instrumented probes...\n'));

    const files = await findInstrumentedFiles(cwd);

    if (files.length === 0) {
      console.log(chalk.yellow('  No instrumented files found.'));
      console.log(chalk.dim('  Run "utopia instrument" to add probes to your codebase.\n'));
      return;
    }

    console.log(chalk.dim(`  Found ${files.length} instrumented file(s)\n`));

    const results: ValidationResult[] = [];

    for (const file of files) {
      const ext = extname(file);
      let result: ValidationResult;

      if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
        result = await validateJavaScriptFile(file);
      } else if (ext === '.py') {
        result = await validatePythonFile(file);
      } else {
        continue;
      }

      results.push(result);

      // Print result for this file
      const icon = result.passed ? chalk.green('[PASS]') : chalk.red('[FAIL]');
      const probeInfo = chalk.dim(`(${result.probeCount} probe${result.probeCount !== 1 ? 's' : ''})`);
      console.log(`  ${icon} ${result.file} ${probeInfo}`);

      for (const warning of result.warnings) {
        console.log(chalk.yellow(`         Warning: ${warning}`));
      }
      for (const error of result.errors) {
        console.log(chalk.red(`         Error: ${error}`));
      }
    }

    // Summary
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;
    const totalProbes = results.reduce((sum, r) => sum + r.probeCount, 0);
    const totalWarnings = results.reduce((sum, r) => sum + r.warnings.length, 0);

    console.log(chalk.bold('\n  Summary:'));
    console.log(`    Files validated:  ${chalk.cyan(String(results.length))}`);
    console.log(`    Passed:           ${chalk.green(String(passed))}`);
    console.log(`    Failed:           ${failed > 0 ? chalk.red(String(failed)) : chalk.green(String(failed))}`);
    console.log(`    Total probes:     ${chalk.cyan(String(totalProbes))}`);
    console.log(`    Warnings:         ${totalWarnings > 0 ? chalk.yellow(String(totalWarnings)) : chalk.green(String(totalWarnings))}`);

    if (failed > 0) {
      console.log(chalk.red('\n  Some files failed validation. Fix the errors above and run again.\n'));
      process.exit(1);
    } else {
      console.log(chalk.green('\n  All files passed validation!\n'));
    }
  });
