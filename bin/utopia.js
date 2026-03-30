#!/usr/bin/env node
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, '..', 'src', 'cli', 'index.ts');

// Use tsx to run the TypeScript entry point directly
try {
  execFileSync(
    resolve(__dirname, '..', 'node_modules', '.bin', 'tsx'),
    [entry, ...process.argv.slice(2)],
    { stdio: 'inherit', cwd: process.cwd() }
  );
} catch (err) {
  process.exit(err.status || 1);
}
