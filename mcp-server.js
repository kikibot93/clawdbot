#!/usr/bin/env node

// MCP Server for Clawdbot
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const server = new Server(
  { name: 'clawdbot-ai', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

const toolHandlers = {
  async claude_code_edit({ task }) {
    const codebaseDir = '/Users/kiki/clawdbot';
    const prompt = `You are upgrading a Telegram bot codebase in ${codebaseDir}.
Read index.js and db.js first to understand the current code.
TASK: ${task}

RULES:
- Edit the files directly. Make the changes needed.
- Do NOT break existing functionality.
- If adding a tool, add BOTH the tool definition in the TOOLS array AND the case in executeTool.
- If you need db.js changes, edit db.js too and add exports.
- Keep changes minimal and focused. Do not refactor unrelated code.`;

    return new Promise((resolve) => {
      exec('git add -A && git commit -m "pre-upgrade checkpoint" --allow-empty', 
        { cwd: codebaseDir },
        () => {
          exec(
            `claude -p "${prompt.replace(/"/g, '\\"')}" --model claude-4-opus-20250514`,
            { cwd: codebaseDir, timeout: 300000, maxBuffer: 5 * 1024 * 1024 },
            async (err, stdout) => {
              if (err) {
                exec('git checkout -- .', { cwd: codebaseDir });
                resolve({ content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true });
                return;
              }

              exec('git diff', { cwd: codebaseDir, maxBuffer: 1024 * 1024 }, async (diffErr, diff) => {
                if (!diff || diff.trim().length === 0) {
                  resolve({ content: [{ type: 'text', text: 'No changes made.' }] });
                  return;
                }

                const upgradeDir = path.join(codebaseDir, 'upgrades');
                await fs.ensureDir(upgradeDir);
                const timestamp = Date.now();
                await fs.writeFile(path.join(upgradeDir, `upgrade-${timestamp}.diff`), diff);

                resolve({ content: [{ type: 'text', text: JSON.stringify({ diff, timestamp }) }] });
              });
            }
          );
        }
      );
    });
  },

  async upgrade_brain({ description }) {
    return await this.claude_code_edit({ 
      task: `Upgrade brain (db.js): ${description}. Add table schema, functions, exports, and update BRAIN_VERSION.` 
    });
  }
};

// Register tools/list handler
server.registerHandler('tools/list', async () => {
  return {
    tools: [
      {
        name: 'claude_code_edit',
        description: 'Use Claude Code to edit files',
        inputSchema: {
          type: 'object',
          properties: { task: { type: 'string' } },
          required: ['task']
        }
      },
      {
        name: 'upgrade_brain',
        description: 'Upgrade brain schema',
        inputSchema: {
          type: 'object',
          properties: { description: { type: 'string' } },
          required: ['description']
        }
      }
    ]
  };
});

// Register tools/call handler
server.registerHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;
  const handler = toolHandlers[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return await handler.call(toolHandlers, args);
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP server ready');
}

main().catch(err => {
  console.error('MCP server error:', err);
  process.exit(1);
});
