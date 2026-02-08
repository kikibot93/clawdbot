require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { exec } = require("child_process");
const { execFile } = require("child_process");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs-extra");
const os = require("os");

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
fs.ensureDirSync("./temp");
fs.ensureDirSync(path.join(__dirname, "skills"));

// ============================================================
// SAFETY CONTROLS
// ============================================================

let paused = false;
let dailyApiCalls = 0;
let dailyLimit = 100;
let lastResetDate = new Date().toDateString();
let activeAbortController = null;

function checkDailyReset() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    dailyApiCalls = 0;
    lastResetDate = today;
  }
}

function canMakeApiCall() {
  checkDailyReset();
  return dailyApiCalls < dailyLimit;
}

function trackApiCall() {
  checkDailyReset();
  dailyApiCalls++;
}

const SCRIPT_PATH = path.join(__dirname, "latest_from_sender.scpt");
const SEND_SCRIPT_PATH = path.join(__dirname, "send_email.scpt");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;

function isAdmin(msg) {
  if (!ADMIN_ID) return true;
  return String(msg.from?.id) === String(ADMIN_ID);
}

bot.on("polling_error", (err) => console.log("polling_error:", err.message));

bot.onText(/\/whoami/, (msg) => {
  bot.sendMessage(msg.chat.id, `Your Telegram user id is: ${msg.from.id}`);
});

bot.onText(/\/ping/, (msg) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "Not authorized.");
  bot.sendMessage(msg.chat.id, "pong ✅");
});

bot.onText(/\/pause/, (msg) => {
  if (!isAdmin(msg)) return;
  paused = true;
  if (activeAbortController) activeAbortController.abort();
  bot.sendMessage(msg.chat.id, "⏸️ Bot paused. Send /resume to continue.");
});

bot.onText(/\/resume/, (msg) => {
  if (!isAdmin(msg)) return;
  paused = false;
  bot.sendMessage(msg.chat.id, "▶️ Bot resumed.");
});

bot.onText(/\/usage/, (msg) => {
  if (!isAdmin(msg)) return;
  checkDailyReset();
  bot.sendMessage(msg.chat.id, `📊 API calls today: ${dailyApiCalls}/${dailyLimit}`);
});

bot.onText(/\/limit (\d+)/, (msg, match) => {
  if (!isAdmin(msg)) return;
  dailyLimit = parseInt(match[1]);
  bot.sendMessage(msg.chat.id, `✅ Daily limit set to ${dailyLimit} API calls.`);
});

bot.onText(/\/skills/, (msg) => {
  if (!isAdmin(msg)) return;
  const skillsDir = path.join(__dirname, "skills");
  const skills = fs.readdirSync(skillsDir).filter(f => f.endsWith(".json"));
  if (skills.length === 0) return bot.sendMessage(msg.chat.id, "No skills learned yet.");
  const list = skills.map(f => {
    const s = fs.readJsonSync(path.join(skillsDir, f));
    return `• ${s.name}: ${s.description}`;
  }).join("\n");
  bot.sendMessage(msg.chat.id, `🧠 Learned skills:\n${list}`);
});

// ============================================================
// TOOLS: These are the real capabilities the agent can use
// ============================================================

function runShell(command) {
  return new Promise((resolve) => {
    exec(command, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve(`ERROR: ${err.message}\n${stderr}`);
      else resolve(stdout.trim() || "(no output)");
    });
  });
}

function runAppleScript(script) {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) resolve(`ERROR: ${err.message}`);
      else resolve(stdout.trim() || "(no output)");
    });
  });
}

function readEmail(sender) {
  return new Promise((resolve) => {
    execFile("osascript", [SCRIPT_PATH, sender], { timeout: 15000 }, (err, stdout) => {
      if (err) resolve(`ERROR: ${err.message}`);
      else resolve(stdout.trim() || "NOT_FOUND");
    });
  });
}

function sendEmail(recipient, subject, body) {
  const script = `
    tell application "Mail"
      set newMsg to make new outgoing message with properties {subject:"${subject.replace(/"/g, '\\"')}", content:"${body.replace(/"/g, '\\"')}", visible:false}
      tell newMsg
        make new to recipient at end of to recipients with properties {address:"${recipient}"}
        send
      end tell
    end tell
    return "SENT"
  `;
  return runAppleScript(script);
}

function sendEmailWithAttachment(recipient, subject, body, attachmentPath) {
  const script = `
    tell application "Mail"
      set newMsg to make new outgoing message with properties {subject:"${subject.replace(/"/g, '\\"')}", content:"${body.replace(/"/g, '\\"')}", visible:false}
      tell newMsg
        make new to recipient at end of to recipients with properties {address:"${recipient}"}
        tell content
          make new attachment with properties {file name:POSIX file "${attachmentPath}"} at after the last paragraph
        end tell
        delay 2
        send
      end tell
    end tell
    return "SENT"
  `;
  return runAppleScript(script);
}

// Tool definitions for Claude
const TOOLS = [
  {
    name: "run_shell",
    description: "Run any shell/terminal command on this Mac. Use for: searching the web with curl, downloading files, listing files, opening URLs in browser, checking system info, running scripts, etc. Examples: 'curl -s https://...', 'open https://google.com', 'ls ~/Downloads', 'open -a Safari', 'say hello'",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" }
      },
      required: ["command"]
    }
  },
  {
    name: "run_applescript",
    description: "Run AppleScript to control macOS apps. Use for: opening/closing apps, controlling Music/Spotify, adjusting volume, sending iMessages, controlling Finder, etc.",
    input_schema: {
      type: "object",
      properties: {
        script: { type: "string", description: "The AppleScript code to execute" }
      },
      required: ["script"]
    }
  },
  {
    name: "read_email",
    description: "Read the latest email from a specific sender in Mail.app. Pass empty string to get the most recent email regardless of sender.",
    input_schema: {
      type: "object",
      properties: {
        sender: { type: "string", description: "Sender name to search for, or empty string for latest email" }
      },
      required: ["sender"]
    }
  },
  {
    name: "send_email",
    description: "Send an email via Mail.app",
    input_schema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "Email address of recipient" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body text" }
      },
      required: ["recipient", "subject", "body"]
    }
  },
  {
    name: "send_email_with_attachment",
    description: "Send an email with a file attachment (image, document, etc.) via Mail.app. First download the file using run_shell with curl, then use this tool to email it.",
    input_schema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "Email address of recipient" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body text" },
        attachment_path: { type: "string", description: "Absolute path to the file to attach" }
      },
      required: ["recipient", "subject", "body", "attachment_path"]
    }
  },
  {
    name: "read_file",
    description: "Read contents of a file on disk",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file" }
      },
      required: ["file_path"]
    }
  },
  {
    name: "write_file",
    description: "Write content to a file on disk",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file" },
        content: { type: "string", description: "Content to write" }
      },
      required: ["file_path", "content"]
    }
  },
  {
    name: "list_files",
    description: "List files in a directory",
    input_schema: {
      type: "object",
      properties: {
        dir_path: { type: "string", description: "Absolute path to directory" }
      },
      required: ["dir_path"]
    }
  }
];

// Execute a tool call
async function executeTool(name, input) {
  switch (name) {
    case "run_shell":
      return await runShell(input.command);
    case "run_applescript":
      return await runAppleScript(input.script);
    case "read_email":
      return await readEmail(input.sender);
    case "send_email":
      return await sendEmail(input.recipient, input.subject, input.body);
    case "send_email_with_attachment":
      return await sendEmailWithAttachment(input.recipient, input.subject, input.body, input.attachment_path);
    case "read_file":
      try { return await fs.readFile(input.file_path, "utf8"); }
      catch (e) { return `ERROR: ${e.message}`; }
    case "write_file":
      try { await fs.outputFile(input.file_path, input.content); return "File written successfully"; }
      catch (e) { return `ERROR: ${e.message}`; }
    case "list_files":
      try {
        const items = await fs.readdir(input.dir_path);
        return items.join("\n") || "(empty directory)";
      } catch (e) { return `ERROR: ${e.message}`; }
    default:
      return `ERROR: Unknown tool ${name}`;
  }
}

// ============================================================
// SKILLS SYSTEM: Load learned skills into context
// ============================================================

function loadSkills() {
  const skillsDir = path.join(__dirname, "skills");
  const skillFiles = fs.readdirSync(skillsDir).filter(f => f.endsWith(".json"));
  if (skillFiles.length === 0) return "";
  
  let skillsText = "\n\nLEARNED SKILLS (scripts you previously wrote that you can reuse):\n";
  for (const file of skillFiles) {
    try {
      const skill = fs.readJsonSync(path.join(skillsDir, file));
      skillsText += `- ${skill.name}: ${skill.description} → run with: run_shell "${skill.command}"\n`;
    } catch (e) { /* skip bad files */ }
  }
  return skillsText;
}

// ============================================================
// AGENT LOOP: Claude decides what tools to use and chains them
// ============================================================

async function runAgent(chatId, userMessage) {
  if (paused) return bot.sendMessage(chatId, "⏸️ Bot is paused. Send /resume to continue.");
  if (!canMakeApiCall()) return bot.sendMessage(chatId, `🚫 Daily API limit reached (${dailyLimit}). Send /limit <number> to increase.`);

  bot.sendMessage(chatId, "🤔 Thinking…");
  activeAbortController = new AbortController();

  const skills = loadSkills();
  const messages = [{ role: "user", content: userMessage }];
  const systemPrompt = `You are Kiki, a powerful personal assistant running on a Mac mini. You have full control of this computer through tools.

CAPABILITIES:
- Run ANY shell command (curl, open, ls, say, pbcopy, screencapture, etc.)
- Run AppleScript to control any Mac app (Safari, Mail, Music, Finder, Messages, etc.)
- Read and send emails (with or without attachments) via Mail.app
- Read and write files anywhere on disk
- Open URLs in the browser with: run_shell "open https://..."
- Search the web with: run_shell "curl -s 'https://html.duckduckgo.com/html/?q=YOUR+QUERY'" and parse the results
- Take screenshots with: run_shell "screencapture ~/Desktop/screenshot.png"
- Control volume, brightness, apps with AppleScript

CRITICAL RULES:
1. You MUST use tools to accomplish tasks. NEVER say you can't do something.
2. For web searches, use curl to fetch HTML results, then parse them.
3. For complex tasks, chain multiple tool calls together.
4. Be concise in responses.
5. SELF-IMPROVEMENT: If you solve a complex task, save a reusable script for next time.
   To save a skill: write_file to /Users/kiki/clawdbot/skills/SKILL_NAME.json with format:
   {"name": "skill_name", "description": "what it does", "command": "bash /Users/kiki/clawdbot/skills/skill_name.sh"}
   Then also write the actual script to /Users/kiki/clawdbot/skills/skill_name.sh
   Only save skills for tasks that were complex or that you think will be reused.

HOW TO SEND AN IMAGE BY EMAIL:
Step 1: Download the image to /tmp/ using: run_shell "curl -sL -o /tmp/image.jpg 'DIRECT_IMAGE_URL'"
Step 2: Verify with: run_shell "file /tmp/image.jpg" — MUST say "JPEG image data" or "PNG image data"
Step 3: Use send_email_with_attachment with attachment_path "/tmp/image.jpg"
NEVER just open a URL in the browser when asked to email something. DOWNLOAD first, then ATTACH.

IMAGE SOURCES:
- Dog pictures: curl -sL -o /tmp/image.jpg 'https://placedog.net/500/500?random'
- Cat pictures: curl -sL -o /tmp/image.jpg 'https://cataas.com/cat'
- Any search: use curl on DuckDuckGo, find direct .jpg/.png URLs, download with curl -sL -o
- ALWAYS verify: run_shell "file /tmp/image.jpg" — if it says HTML, the URL was wrong.${skills}`;

  let iterations = 0;
  const MAX_ITERATIONS = 10;

  try {
    while (iterations < MAX_ITERATIONS) {
      if (paused) {
        bot.sendMessage(chatId, "⏸️ Task interrupted. Bot paused.");
        return;
      }
      if (!canMakeApiCall()) {
        bot.sendMessage(chatId, `🚫 Daily API limit reached mid-task (${dailyLimit}).`);
        return;
      }

      iterations++;
      trackApiCall();

      const response = await anthropic.messages.create({
        model: "claude-3-haiku-20240307",
        max_tokens: 2048,
        system: systemPrompt,
        tools: TOOLS,
        messages: messages,
      });

      // Check if Claude wants to use tools
      if (response.stop_reason === "tool_use") {
        const toolResults = [];
        for (const block of response.content) {
          if (block.type === "tool_use") {
            if (paused) {
              bot.sendMessage(chatId, "⏸️ Task interrupted. Bot paused.");
              return;
            }
            console.log(`🔧 Tool: ${block.name}(${JSON.stringify(block.input)})`);
            const result = await executeTool(block.name, block.input);
            console.log(`📤 Result: ${result.substring(0, 200)}`);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: result.substring(0, 10000),
            });
          }
        }

        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: toolResults });

      } else {
        const textBlocks = response.content.filter(b => b.type === "text");
        const finalResponse = textBlocks.map(b => b.text).join("\n");
        if (finalResponse) {
          bot.sendMessage(chatId, finalResponse);
        }
        activeAbortController = null;
        return;
      }
    }

    bot.sendMessage(chatId, "⚠️ Task took too many steps. Stopping here.");
  } finally {
    activeAbortController = null;
  }
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

bot.on("message", async (msg) => {
  if (!isAdmin(msg)) return;
  if (msg.text?.startsWith("/")) return;
  const chatId = msg.chat.id;
  const userMessage = msg.text?.trim();
  if (!userMessage) return;

  try {
    await runAgent(chatId, userMessage);
  } catch (err) {
    console.error("agent error:", err);
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

console.log("Clawdbot running. Send /ping in Telegram.");
