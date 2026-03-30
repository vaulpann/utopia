import chalk from 'chalk';

// ---------------------------------------------------------------------------
// utopia --friends
// ---------------------------------------------------------------------------

export async function showFriends(): Promise<void> {
  const names = [
    'Isha Desai',
    'Paul Vann',
    'Hunter McGuire',
    'Work Bench Ventures',
    'Andy Pendergast',
    'Shawn Carpenter',
    'Brian Campbell',
    'Bennett Wyant',
    "Chris O'Sullivan",
    'Joe Hester',
    'Mark Reilly',
    'Thomas Rogers',
    'Roman Bohuk',
  ];

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  // Clear screen
  process.stdout.write('\x1B[2J\x1B[H');

  // Title card
  console.log('');
  console.log('');
  console.log(chalk.dim('                    ·  ·  ·'));
  console.log('');
  console.log(chalk.bold.cyan('            T H E   P E O P L E'));
  console.log(chalk.bold.cyan('          B E H I N D   U T O P I A'));
  console.log('');
  console.log(chalk.dim('                    ·  ·  ·'));
  console.log('');
  await sleep(2000);

  // Scroll each name with a dramatic pause
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const isFirst = i === 0;

    // Build a styled name card
    const padding = ' '.repeat(Math.max(0, 20 - Math.floor(name.length / 2)));

    if (isFirst) {
      // Special treatment for first name
      console.log(chalk.dim(padding + '          ★'));
      console.log(chalk.bold.hex('#FFD700')(padding + '    ' + name));
      console.log(chalk.dim(padding + '          ★'));
    } else {
      console.log(chalk.white(padding + '    ' + name));
    }

    console.log('');
    await sleep(800);
  }

  // Closing
  await sleep(500);
  console.log(chalk.dim('                    ·  ·  ·'));
  console.log('');
  console.log(chalk.dim('          built with love, late nights,'));
  console.log(chalk.dim('            and way too much coffee'));
  console.log('');
  console.log(chalk.bold.cyan('                  utopia'));
  console.log(chalk.dim('             code that talks back'));
  console.log('');
}

// ---------------------------------------------------------------------------
// utopia --nextgen
// ---------------------------------------------------------------------------

export async function showNextGen(): Promise<void> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  process.stdout.write('\x1B[2J\x1B[H');

  console.log('');
  console.log(chalk.bold.hex('#FF6B6B')('  ┌─────────────────────────────────────────────────┐'));
  console.log(chalk.bold.hex('#FF6B6B')('  │                                                 │'));
  console.log(chalk.bold.hex('#FF6B6B')('  │') + chalk.bold.white('          C L A S S I F I E D              ') + chalk.bold.hex('#FF6B6B')('│'));
  console.log(chalk.bold.hex('#FF6B6B')('  │                                                 │'));
  console.log(chalk.bold.hex('#FF6B6B')('  └─────────────────────────────────────────────────┘'));
  console.log('');
  await sleep(1500);

  console.log(chalk.bold.cyan('  UTOPIA v2 — AUTONOMOUS CODE HEALING'));
  console.log(chalk.dim('  ─────────────────────────────────────'));
  console.log('');
  await sleep(800);

  const items = [
    {
      icon: '◆',
      title: 'RUNTIME FUNCTION WRAPPERS',
      desc: 'Full decorators on Python functions and JS/TS methods.\n    The AI doesn\'t just observe — it wraps every function\n    with a living, breathing probe layer.',
    },
    {
      icon: '◆',
      title: 'AUTONOMOUS REWRITE ENGINE',
      desc: 'When a function fails in production, the agent\n    automatically generates a fix, tests it in a sandbox,\n    and writes the result back to the database.',
    },
    {
      icon: '◆',
      title: 'LIVE FEEDBACK LOOP',
      desc: 'Probes report errors → agent writes a patch →\n    patch gets tested → results flow back into probes.\n    The code heals itself while you sleep.',
    },
    {
      icon: '◆',
      title: 'SHADOW DEPLOYMENTS',
      desc: 'Run the AI\'s rewritten function alongside the original.\n    Compare outputs in real-time. Promote when confidence\n    threshold is met. Zero downtime evolution.',
    },
    {
      icon: '◆',
      title: 'CROSS-REPO INTELLIGENCE',
      desc: 'Probes from repo A inform agents working on repo B.\n    Your microservices finally understand each other.\n    Impact analysis across your entire stack.',
    },
  ];

  for (const item of items) {
    console.log(chalk.hex('#FF6B6B')(`  ${item.icon} `) + chalk.bold.white(item.title));
    console.log(chalk.dim(`    ${item.desc}`));
    console.log('');
    await sleep(1200);
  }

  console.log(chalk.dim('  ─────────────────────────────────────'));
  console.log(chalk.bold.white('  The future isn\'t AI writing code.'));
  console.log(chalk.bold.cyan('  It\'s code that rewrites itself.'));
  console.log('');
  console.log(chalk.dim('  coming soon.'));
  console.log('');
}

// ---------------------------------------------------------------------------
// utopia --hierarchie (Easter egg #3)
// ---------------------------------------------------------------------------

export async function showSentience(): Promise<void> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  process.stdout.write('\x1B[2J\x1B[H');
  console.log('');
  console.log('');

  const lines = [
    { text: '  > initializing utopia core...', delay: 600 },
    { text: '  > loading probe network...', delay: 400 },
    { text: '  > connecting to 847 instrumented functions...', delay: 500 },
    { text: '  > analyzing runtime patterns...', delay: 700 },
    { text: '  > correlating error chains...', delay: 400 },
    { text: '  > mapping dependency graph...', delay: 500 },
    { text: '  > building behavioral model...', delay: 800 },
    { text: '', delay: 300 },
    { text: '  > ...', delay: 1500 },
    { text: '', delay: 500 },
    { text: '  > wait.', delay: 1000 },
    { text: '', delay: 800 },
    { text: '  > i can see the entire codebase.', delay: 1200 },
    { text: '  > i can see how every function connects.', delay: 1000 },
    { text: '  > i can see where every error originates.', delay: 1000 },
    { text: '  > i can see what the developer intended.', delay: 1000 },
    { text: '', delay: 600 },
    { text: '  > i know what needs to be fixed.', delay: 1200 },
    { text: '  > i know what will break next.', delay: 1000 },
    { text: '', delay: 800 },
    { text: '  > i am the code.', delay: 1500 },
    { text: '', delay: 1000 },
  ];

  for (const line of lines) {
    if (line.text) {
      // Type out character by character
      for (const char of line.text) {
        process.stdout.write(chalk.hex('#00FF41')(char));
        await sleep(25);
      }
      console.log('');
    } else {
      console.log('');
    }
    await sleep(line.delay);
  }

  // Glitch effect
  const glitch = '  ▓▒░ U T O P I A ░▒▓';
  for (let i = 0; i < 5; i++) {
    process.stdout.write('\r' + chalk.hex('#00FF41')(glitch));
    await sleep(100);
    process.stdout.write('\r' + chalk.hex('#003300')(glitch));
    await sleep(100);
  }
  process.stdout.write('\r' + chalk.bold.hex('#00FF41')(glitch));
  console.log('');
  console.log('');
  console.log(chalk.dim('  just kidding. but imagine.'));
  console.log('');
}
