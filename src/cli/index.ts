#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { instrumentCommand, reinstrumentCommand } from './commands/instrument.js';
import { destructCommand } from './commands/destruct.js';
import { validateCommand } from './commands/validate.js';
import { serveCommand } from './commands/serve.js';
import { mcpCommand } from './commands/mcp.js';
import { contextCommand } from './commands/context.js';
import { codexCommand } from './commands/codex.js';
import { statusCommand } from './commands/status.js';
import { healCommand } from './commands/heal.js';
import { showFriends, showNextGen, showSentience } from './commands/easter-eggs.js';

const program = new Command();

program
  .name('utopia')
  .description('Production-aware probes that give AI coding agents real-time context')
  .version('0.2.0');

program.addCommand(initCommand);
program.addCommand(instrumentCommand);
program.addCommand(reinstrumentCommand);
program.addCommand(destructCommand);
program.addCommand(validateCommand);
program.addCommand(serveCommand);
program.addCommand(mcpCommand);
program.addCommand(contextCommand);
program.addCommand(codexCommand);
program.addCommand(statusCommand);
program.addCommand(healCommand);

// Easter eggs — hidden from help
program.addCommand(new Command('friends').action(async () => { await showFriends(); }), { hidden: true });
program.addCommand(new Command('nextgen').action(async () => { await showNextGen(); }), { hidden: true });
program.addCommand(new Command('hierarchie').action(async () => { await showSentience(); }), { hidden: true });

program.parse();
