import { Command } from 'commander';

export const mcpCommand = new Command('mcp')
  .description('Start the Utopia MCP server (used by Claude Code)')
  .option('--endpoint <url>', 'Utopia data service endpoint', process.env.UTOPIA_ENDPOINT || 'http://localhost:7890')
  .option('--project-id <id>', 'Project ID', process.env.UTOPIA_PROJECT_ID || '')
  .action(async (options) => {
    // Set env vars for the MCP server
    process.env.UTOPIA_ENDPOINT = options.endpoint;
    if (options.projectId) {
      process.env.UTOPIA_PROJECT_ID = options.projectId;
    }

    // Import and start the MCP server
    await import('../../mcp/index.js');
  });
