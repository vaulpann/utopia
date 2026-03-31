import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { configExists, loadConfig } from '../utils/config.js';
import type { UtopiaConfig } from '../utils/config.js';

const SNAPSHOT_DIR = '.utopia/snapshots';

/**
 * Collect all snapshot files with their relative paths.
 */
function collectSnapshots(snapshotBase: string): { rel: string; snapPath: string }[] {
  const results: { rel: string; snapPath: string }[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = resolve(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (st.isFile()) {
          const rel = full.substring(snapshotBase.length + 1);
          results.push({ rel, snapPath: full });
        }
      } catch { /* skip */ }
    }
  }

  walk(snapshotBase);
  return results;
}

/**
 * Apply the user's post-instrument changes on top of the snapshot.
 *
 * Strategy:
 *   1. Take the snapshot (original pre-probe file)
 *   2. Take the current file (has probes + maybe user changes)
 *   3. Remove probe blocks from the current file
 *   4. Diff the stripped-current vs snapshot — the diff is the user's changes
 *   5. Return the snapshot if no user changes, or the stripped-current if there are user changes
 *
 * "Probe block" = a `// utopia:probe` (or `# utopia:probe`) comment followed by
 * its try/catch (or try/except) block, plus any `__utopia_start` timing line above,
 * plus the utopia import if no other probes remain.
 */
function stripProbesFromContent(content: string, isPython: boolean): string {
  const marker = isPython ? '# utopia:probe' : '// utopia:probe';
  const lines = content.split('\n');
  const linesToRemove = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== marker) continue;
    linesToRemove.add(i);

    // Check for __utopia_start timing line above
    let above = i - 1;
    while (above >= 0 && lines[above].trim() === '') above--;
    if (above >= 0 && (lines[above].trim().startsWith('const __utopia_start') || lines[above].trim().startsWith('_utopia_start'))) {
      linesToRemove.add(above);
    }

    // Remove the try block that follows
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;

    if (isPython) {
      // Python: try: ... except ...: pass
      if (j < lines.length && lines[j].trim().startsWith('try:')) {
        const tryIndent = lines[j].length - lines[j].trimStart().length;
        linesToRemove.add(j);
        let k = j + 1;
        while (k < lines.length) {
          const line = lines[k];
          if (line.trim() === '') { linesToRemove.add(k); k++; continue; }
          const indent = line.length - line.trimStart().length;
          if (indent <= tryIndent && line.trim() !== '') {
            if (line.trim().startsWith('except')) {
              linesToRemove.add(k);
              k++;
              while (k < lines.length) {
                const eline = lines[k];
                if (eline.trim() === '') { linesToRemove.add(k); k++; continue; }
                if ((eline.length - eline.trimStart().length) <= tryIndent) break;
                linesToRemove.add(k); k++;
              }
              break;
            }
            break;
          }
          linesToRemove.add(k); k++;
        }
      }
    } else {
      // JS/TS: try { ... } catch { ... }
      if (j < lines.length && lines[j].trim().startsWith('try {')) {
        let braceDepth = 0;
        let inCatch = false;
        for (let k = j; k < lines.length; k++) {
          for (const ch of lines[k]) {
            if (ch === '{') braceDepth++;
            if (ch === '}') braceDepth--;
          }
          linesToRemove.add(k);
          if (lines[k].includes('catch')) inCatch = true;
          if (braceDepth === 0 && (inCatch || k > j)) break;
        }
      }
    }
  }

  let result = lines.filter((_line, idx) => !linesToRemove.has(idx)).join('\n');

  // Remove utopia import if no probes remain
  if (isPython) {
    if (!result.includes('utopia_runtime.report')) {
      result = result.replace(/^import utopia_runtime\s*\n?/gm, '');
    }
  } else {
    if (!result.includes('__utopia.report') && !result.includes('__utopia.init')) {
      result = result.replace(/import\s*\{[^}]*__utopia[^}]*\}\s*from\s*['"]utopia-runtime['"];?\s*\n?/g, '');
    }
  }

  // Remove leftover timing vars
  result = result.replace(/^\s*const\s+__utopia_start\s*=\s*Date\.now\(\);?\s*\n/gm, '');
  result = result.replace(/^\s*_utopia_start\s*=\s*time\.time\(\)\s*\n/gm, '');

  // Clean up consecutive blank lines
  result = result.replace(/\n{3,}/g, '\n\n');
  result = result.replace(/[ \t]+$/gm, '');

  return result;
}

/**
 * Strip @utopia decorators and utopia_runtime self-healing imports from Python content.
 * Handles: @utopia, @utopia(), @utopia(ignore=[...]), multi-line decorator args.
 */
function stripHealFromContent(content: string): string {
  let result = content;

  // Remove @utopia decorators — bare, with empty parens, or with args (possibly multi-line)
  // Single-line: @utopia, @utopia(), @utopia(ignore=[ValueError])
  result = result.replace(/^\s*@utopia\b[^\n]*\n/gm, '');

  // Remove "from utopia_runtime import utopia" style imports
  // But preserve "import utopia_runtime" (used by probes) — only strip the "from ... import utopia" form
  result = result.replace(/^\s*from\s+utopia_runtime\s+import\s+utopia\b[^\n]*\n/gm, '');
  // Also handle legacy utopia_sdk imports if present
  result = result.replace(/^\s*from\s+utopia_sdk\s+import\s+[^\n]+\n/gm, '');

  // Clean up consecutive blank lines
  result = result.replace(/\n{3,}/g, '\n\n');
  result = result.replace(/[ \t]+$/gm, '');

  return result;
}

/**
 * Walk a directory and collect all .py files (for heal-mode stripping
 * when no snapshots exist).
 */
function collectPythonFiles(dir: string, skipDirs: Set<string>): string[] {
  const results: string[] = [];

  function walk(d: string): void {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith('.') || skipDirs.has(entry)) continue;
      const full = resolve(d, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (st.isFile() && full.endsWith('.py')) results.push(full);
      } catch { /* skip */ }
    }
  }

  walk(dir);
  return results;
}

export const destructCommand = new Command('destruct')
  .description('Remove all Utopia probes and self-healing decorators from the codebase')
  .option('--dry-run', 'Show what would be restored without changing files', false)
  .action(async (options) => {
    const cwd = process.cwd();

    if (!configExists(cwd)) {
      console.log(chalk.red('\n  Error: No .utopia/config.json found.\n'));
      process.exit(1);
    }

    const config: UtopiaConfig = await loadConfig(cwd);
    const mode = config.utopiaMode || 'instrument';
    const hasProbes = mode === 'instrument' || mode === 'both';
    const hasHeal = mode === 'heal' || mode === 'both';

    const snapshotBase = resolve(cwd, SNAPSHOT_DIR);
    const hasSnapshots = existsSync(snapshotBase);
    const snapshots = hasSnapshots ? collectSnapshots(snapshotBase) : [];

    console.log(chalk.bold.cyan('\n  Utopia Destruct\n'));

    if (options.dryRun) {
      console.log(chalk.yellow('  Dry run — no files will be modified.\n'));
    }

    if (hasProbes) console.log(chalk.dim('  Mode: removing production probes'));
    if (hasHeal) console.log(chalk.dim('  Mode: removing @utopia self-healing decorators'));
    console.log('');

    let restored = 0;
    let merged = 0;
    let skipped = 0;

    // --- Phase 1: Snapshot-based restoration (works for both probes and heal) ---

    if (snapshots.length > 0) {
      console.log(chalk.dim(`  Found ${snapshots.length} file snapshot(s)\n`));

      for (const { rel, snapPath } of snapshots) {
        const targetPath = resolve(cwd, rel);

        if (!existsSync(targetPath)) { skipped++; continue; }

        const snapshot = readFileSync(snapPath, 'utf-8');
        const current = readFileSync(targetPath, 'utf-8');

        if (current === snapshot) { skipped++; continue; }

        const isPython = rel.endsWith('.py');
        let strippedCurrent = current;

        // Strip probes if in instrument/both mode
        if (hasProbes) {
          strippedCurrent = stripProbesFromContent(strippedCurrent, isPython);
        }

        // Strip @utopia decorators if in heal/both mode and file is Python
        if (hasHeal && isPython) {
          strippedCurrent = stripHealFromContent(strippedCurrent);
        }

        const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

        if (normalize(strippedCurrent) === normalize(snapshot)) {
          if (options.dryRun) {
            console.log(chalk.dim(`  [dry-run] Restore: ${rel}`));
          } else {
            writeFileSync(targetPath, snapshot);
            console.log(chalk.green(`  Restored: ${rel}`));
          }
          restored++;
        } else {
          if (options.dryRun) {
            console.log(chalk.dim(`  [dry-run] Strip (user changes preserved): ${rel}`));
          } else {
            writeFileSync(targetPath, strippedCurrent);
            console.log(chalk.yellow(`  Stripped (user changes preserved): ${rel}`));
          }
          merged++;
        }
      }
    }

    // --- Phase 2: Heal-only cleanup for files without snapshots ---
    // This handles the case where @utopia decorators were added to files
    // that weren't captured in snapshots (e.g. new files created after heal)

    if (hasHeal) {
      const skipDirs = new Set(['node_modules', '.next', 'dist', 'build', '.utopia', '.git', '__pycache__', 'venv', '.venv', 'coverage', '.env', 'env']);
      const snapshotRels = new Set(snapshots.map(s => s.rel));
      const pyFiles = collectPythonFiles(cwd, skipDirs);
      let healStripped = 0;

      for (const pyFile of pyFiles) {
        const rel = pyFile.substring(cwd.length + 1);
        if (snapshotRels.has(rel)) continue; // already handled above

        const content = readFileSync(pyFile, 'utf-8');
        if (!content.includes('@utopia') && !content.includes('from utopia_runtime import utopia') && !content.includes('from utopia_sdk')) continue;

        const stripped = stripHealFromContent(content);
        if (stripped !== content) {
          if (options.dryRun) {
            console.log(chalk.dim(`  [dry-run] Strip @utopia: ${rel}`));
          } else {
            writeFileSync(pyFile, stripped);
            console.log(chalk.yellow(`  Stripped @utopia: ${rel}`));
          }
          healStripped++;
        }
      }

      if (healStripped > 0) merged += healStripped;
    }

    console.log('');
    if (options.dryRun) {
      console.log(chalk.yellow(`  Would restore ${restored}, strip ${merged}, skip ${skipped} file(s).\n`));
    } else {
      // Clean up snapshots
      if (hasSnapshots) {
        try {
          rmSync(snapshotBase, { recursive: true, force: true });
        } catch { /* ignore */ }
      }

      // Clean up copied Python runtime if it exists
      if (hasProbes) {
        const pythonRuntimeDir = resolve(cwd, 'utopia_runtime');
        if (existsSync(pythonRuntimeDir)) {
          try {
            rmSync(pythonRuntimeDir, { recursive: true, force: true });
            console.log(chalk.dim('  Removed utopia_runtime/ directory.'));
          } catch { /* ignore */ }
        }
      }

      // Clean up self-healing artifacts
      if (hasHeal) {
        const fixesDir = resolve(cwd, '.utopia', 'fixes');
        if (existsSync(fixesDir)) {
          if (options.dryRun) {
            console.log(chalk.dim('  [dry-run] Would remove .utopia/fixes/'));
          } else {
            try {
              rmSync(fixesDir, { recursive: true, force: true });
              console.log(chalk.dim('  Removed .utopia/fixes/ directory.'));
            } catch { /* ignore */ }
          }
        }

        const fixesMd = resolve(cwd, '.utopia', 'FIXES.md');
        if (existsSync(fixesMd)) {
          if (options.dryRun) {
            console.log(chalk.dim('  [dry-run] Would remove .utopia/FIXES.md'));
          } else {
            try {
              rmSync(fixesMd, { force: true });
              console.log(chalk.dim('  Removed .utopia/FIXES.md'));
            } catch { /* ignore */ }
          }
        }
      }

      if (restored > 0) console.log(chalk.bold.green(`\n  ${restored} file(s) restored to exact pre-instrument state.`));
      if (merged > 0) console.log(chalk.yellow(`  ${merged} file(s) had user changes — probes/decorators stripped, your changes preserved.`));
      if (skipped > 0) console.log(chalk.dim(`  ${skipped} file(s) unchanged.`));
      console.log('');
    }
  });
