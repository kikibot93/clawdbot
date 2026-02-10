#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const server = new Server(
  {
    name: 'clawdbot-ai',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Claude Code edit tool
server.setRequestHandler('tools/list', async () => {
  return {
    tools: [
      {
        name: 'claude_code_edit',
        description: 'Use Claude Code (Opus) to edit files in the clawdbot codebase. Commits a checkpoint, makes changes, returns diff for review.',
        inputSchema: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: 'What to build or fix. Be very specific about what to change.',
            },
          },
          required: ['task'],
        },
      },
      {
        name: 'upgrade_brain',
        description: 'Upgrade the brain schema (add tables, fields, functions to db.js). Use when bot needs new data storage capabilities.',
        inputSchema: {
          type: 'object',
          properties: {
            description: {
              type: 'string',
              description: 'What brain capability to add (e.g., "Add skills table to store learned skills")',
            },
          },
          required: ['description'],
        },
      },
    ],
  };
});

server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'claude_code_edit') {
    return await claudeCodeEdit(args.task);
  }

  if (name === 'upgrade_brain') {
    return await upgradeBrain(args.description);
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function claudeCodeEdit(task) {
  const codebaseDir = '/Users/kiki/clawdbot';
  const prompt = `You are upgrading a Telegram bot codebase in ${codebaseDir}.
Read index.js and db.js first to understand the current code.
TASK: ${task}

RULES:
- Edit the files directly. Make the changes needed.
- Do NOT break existing functionality.
- If adding a tool, add BOTH the tool definition in the TOOLS array AND the case in executeTool.
- If you need db.js changes, edit db.js too and add exports.
- If you need new npm packages, create a file /tmp/upgrade-deps.txt listing them.
- Keep changes minimal and focused. Do not refactor unrelated code.
- Test your logic mentally before writing.`;

  return new Promise((resolve) => {
    // Step 1: Git checkpoint
    exec('git add -A && git commit -m "pre-upgrade checkpoint" --allow-empty', 
      { cwd: codebaseDir },
      (commitErr) => {
        // Step 2: Run Claude Code to edit files directly
        exec(
          `claude -p "${prompt.replace(/"/g, '\\"')}" --model claude-4-opus-20250514`,
          { cwd: codebaseDir, timeout: 300000, maxBuffer: 5 * 1024 * 1024 },
          async (err, stdout, stderr) => {
            if (err) {
              // Revert on failure
              exec('git checkout -- .', { cwd: codebaseDir });
              resolve({
                content: [
                  {
                    type: 'text',
                    text: `ERROR: Claude Code failed: ${err.message}`,
                  },
                ],
              });
              return;
            }

            // Step 3: Get the diff
            exec('git diff', { cwd: codebaseDir, maxBuffer: 1024 * 1024 }, async (diffErr, diff) => {
              if (!diff || diff.trim().length === 0) {
                resolve({
                  content: [
                    {
                      type: 'text',
                      text: 'Claude Code ran but made no changes. The task may already be done or wasn\'t clear enough.',
                    },
                  ],
                });
                return;
              }

              // Save diff for reference
              const upgradeDir = path.join(codebaseDir, 'upgrades');
              await fs.ensureDir(upgradeDir);
              const timestamp = Date.now();
              await fs.writeFile(path.join(upgradeDir, `upgrade-${timestamp}.diff`), diff);

              // Install any new deps
              try {
                const depsFile = '/tmp/upgrade-deps.txt';
                if (await fs.pathExists(depsFile)) {
                  const deps = (await fs.readFile(depsFile, 'utf8')).trim();
                  if (deps) {
                    exec(`npm install ${deps}`, { cwd: codebaseDir });
                  }
                  await fs.remove(depsFile);
                }
              } catch (e) { /* ignore */ }

              resolve({
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({ diff, timestamp }),
                  },
                ],
              });
            });
          }
        );
      }
    );
  });
}

async function upgradeBrain(description) {
  const task = `Upgrade the brain (db.js) to add new capabilities: ${description}

Add the necessary:
1. Table schema in the CREATE TABLE section
2. Functions to interact with the new table
3. Export the new functions at the bottom of db.js
4. Update BRAIN_VERSION constant

Follow the existing patterns in db.js. Keep it clean and consistent.`;

  return await claudeCodeEdit(task);
}

// Start server
const transport = new StdioServerTransport();
server.connect(transport);

console.error('MCP server running on stdio');
