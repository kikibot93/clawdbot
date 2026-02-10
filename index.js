require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { exec } = require("child_process");
const { execFile } = require("child_process");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs-extra");
const os = require("os");

const brain = require("./db");
const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilio = require("twilio");
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
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

const bot = new TelegramBot(token, {
  polling: {
    interval: 1000,
    autoStart: true,
    params: { timeout: 30 }
  }
});
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
const ALLOWED_USERS = new Set([
  String(process.env.TELEGRAM_ADMIN_ID),  // you (full access)
  "1764499257",                            // dad (limited access)
]);

function isAdmin(msg) {
  if (!ADMIN_ID) return true;
  return String(msg.from?.id) === String(ADMIN_ID);
}

function isAllowed(msg) {
  return ALLOWED_USERS.has(String(msg.from?.id));
}

bot.on("polling_error", (err) => {
  // Only log non-ECONNRESET errors to reduce noise
  if (!err.message?.includes("ECONNRESET") && !err.message?.includes("ETIMEDOUT")) {
    console.log("polling_error:", err.message);
  }
});

bot.onText(/\/whoami/, (msg) => {
  bot.sendMessage(msg.chat.id, `Your Telegram user id is: ${msg.from.id}`);
});

bot.onText(/\/ping/, (msg) => {
  if (!isAdmin(msg) && !isAllowed(msg)) return bot.sendMessage(msg.chat.id, "Not authorized.");
  bot.sendMessage(msg.chat.id, "pong ✅");
});

bot.onText(/\/help/, (msg) => {
  if (!isAdmin(msg) && !isAllowed(msg)) return;
  bot.sendMessage(msg.chat.id,
`🤖 *Clawdbot Commands*

⚙️ *System*
/ping — Check if bot is alive
/pause — Pause the bot (kill switch)
/resume — Resume the bot
/usage — API calls today
/limit <n> — Set daily API limit
/whoami — Show your Telegram ID

🧠 *Brain & Memory*
/brain — Memory stats (counts, DB size)
/memories — View recent memories
/memories <query> — Search memories
/forget <query> — Archive matching memories
/export — Export entire brain to JSON
/cleanup <days> — Archive old data (default 90)
/purge — Permanently delete archived memories

📋 *Capability Gaps & Wishlist*
/wishlist — View open gaps
/wishlist <feature> — Add a feature request
/gaps — View all gaps
/gaps open|done|building — Filter by status
/gapdone <id> <note> — Mark gap as resolved
/gapdel <id> — Delete a gap

🔧 *Self-Upgrade (Claude Code)*
/upgrades — List drafted upgrades
/review — View latest upgrade draft
/review <file> — View specific draft
/apply <file> — Apply upgrade + restart

📧 *Email*
/emailmon — Toggle email notifications
/emailmon on|off — Set explicitly

💬 *Just Talk*
Send any message without / to chat with the AI.
It can: run shell commands, control Mac apps, send emails, make calls, read files, search the web, run scrapers, and remember things.`,
    { parse_mode: "Markdown" }
  );
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

async function speakWithAIVoice(text) {
  try {
    const mp3Path = path.join(__dirname, "temp", "speech.mp3");
    
    const response = await openai.audio.speech.create({
      model: "tts-1",
      voice: "nova", // or "alloy", "echo", "fable", "onyx", "shimmer"
      input: text,
    });
    
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(mp3Path, buffer);
    
    // Play the audio file
    await runShell(`afplay "${mp3Path}"`);
    
    // Clean up
    await fs.remove(mp3Path);
    
    return "Spoken with AI voice";
  } catch (error) {
    // Fallback to Mac voice if OpenAI fails
    console.log("OpenAI TTS failed, using Mac voice:", error.message);
    const script = `tell application "System Events" to say "${text.replace(/"/g, '\"')}"`;
    return runAppleScript(script);
  }
}

async function makePhoneCall(contact, message) {
  // DISABLED - Use simple_call instead
  return "ERROR: This function is disabled. Use 'simple_call' instead.";
}

let activeCallSid = null;
let activeCallInstructions = null;

async function makeSimpleCall(phoneNumber, message) {
  try {
    // Prevent overlapping calls
    if (activeCallSid) {
      return `⚠️ A call is already in progress (${activeCallSid}). Wait for it to finish or hang up first.`;
    }

    // Store instructions for the voice server to use
    activeCallInstructions = message || null;

    // Ensure voice server + ngrok are running
    const publicUrl = await ensureVoiceServerRunning();
    
    // Make the call - Twilio calls the number, when they answer it hits our webhook
    const call = await twilioClient.calls.create({
      url: `${publicUrl}/voice`,
      to: phoneNumber,
      from: process.env.TWILIO_PHONE_NUMBER,
      method: "POST",
      statusCallback: `${publicUrl}/call-status`,
      statusCallbackEvent: ["completed", "busy", "no-answer", "failed", "canceled"],
    });

    activeCallSid = call.sid;
    console.log("Call initiated:", call.sid, "Instructions:", activeCallInstructions);
    return `✅ Calling ${phoneNumber}... AI will wait for them to answer, then have a real conversation! Call SID: ${call.sid}`;
  } catch (error) {
    activeCallSid = null;
    activeCallInstructions = null;
    console.error("Call error:", error.message);
    return "❌ Error: " + error.message;
  }
}

async function makeRealCall(phoneNumber, initialMessage) {
  // Same as simple_call now
  return await makeSimpleCall(phoneNumber, initialMessage);
}

async function startAIPhoneLine() {
  try {
    const publicUrl = await ensureVoiceServerRunning();
    return `🤖 AI Phone Line running at ${publicUrl}/voice\n\nTo receive incoming calls, set this URL as your Twilio phone number webhook in the Twilio console.`;
  } catch (error) {
    return `❌ Error: ${error.message}`;
  }
}

// Voice server + ngrok state
let voiceServerRunning = false;
let ngrokPublicUrl = null;

async function ensureVoiceServerRunning() {
  if (voiceServerRunning && ngrokPublicUrl) return ngrokPublicUrl;

  const express = require("express");
  const ngrok = require("@ngrok/ngrok");
  const { VoiceResponse } = require("twilio").twiml;

  const voiceApp = express();
  voiceApp.use(express.urlencoded({ extended: true }));
  voiceApp.use(express.json());

  const conversations = new Map();

  // Skip ngrok browser warning for all requests
  voiceApp.use((req, res, next) => {
    res.setHeader("ngrok-skip-browser-warning", "true");
    console.log(`📨 ${req.method} ${req.path}`, JSON.stringify(req.body || {}));
    next();
  });

  // When call connects - say the initial message, then listen
  voiceApp.post("/voice", (req, res) => {
    try {
      const response = new VoiceResponse();
      const baseUrl = ngrokPublicUrl || "";

      // If there are instructions, say them first
      if (activeCallInstructions) {
        response.say({ voice: "Polly.Joanna" }, activeCallInstructions);
      }

      // Then listen for the person's response
      const gather = response.gather({
        input: "speech",
        action: `${baseUrl}/respond`,
        language: "en-US",
        timeout: 7,
        speechTimeout: "auto",
      });
      const xml = response.toString();
      console.log("📤 /voice TwiML:", xml);
      res.type("text/xml");
      res.send(xml);
    } catch (err) {
      console.error("❌ /voice error:", err);
      const r = new VoiceResponse();
      r.say("Sorry, something went wrong.");
      res.type("text/xml");
      res.send(r.toString());
    }
  });

  // After person speaks - AI responds then listens again
  voiceApp.post("/respond", async (req, res) => {
    const twiml = new VoiceResponse();
    const baseUrl = ngrokPublicUrl || "";
    try {
      const callSid = req.body.CallSid || "unknown";
      const userSpeech = req.body.SpeechResult || "";

      console.log(`📞 [${callSid}] Person said: "${userSpeech}"`);

      if (!userSpeech) {
        const gather = twiml.gather({
          input: "speech",
          action: `${baseUrl}/respond`,
          language: "en-US",
          timeout: 3,
          speechTimeout: "auto",
        });
        gather.say({ voice: "Polly.Joanna" }, "Hello? Are you there?");
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      // Build conversation history
      if (!conversations.has(callSid)) {
        conversations.set(callSid, []);
      }
      const history = conversations.get(callSid);
      history.push({ role: "user", content: userSpeech });

      // Build system prompt with call instructions
      let sysPrompt = "You are Kiki, a friendly AI assistant on a phone call. Be natural and concise. Keep responses under 2 sentences. Never use emojis or special characters.";
      if (activeCallInstructions) {
        sysPrompt += ` Your task for this call: ${activeCallInstructions}. Follow these instructions exactly.`;
      }

      // Get AI response with timeout
      const aiReply = await Promise.race([
        anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 150,
          system: sysPrompt,
          messages: history,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000))
      ]);

      const aiText = aiReply.content[0].text;
      history.push({ role: "assistant", content: aiText });
      console.log(`🤖 [${callSid}] AI said: "${aiText}"`);

      // Check for goodbye
      const lower = (userSpeech + " " + aiText).toLowerCase();
      if (["goodbye", "bye", "hang up", "gotta go"].some(p => lower.includes(p))) {
        twiml.say({ voice: "Polly.Joanna" }, aiText);
        twiml.say({ voice: "Polly.Joanna" }, "Goodbye!");
        twiml.hangup();
        conversations.delete(callSid);
      } else {
        twiml.say({ voice: "Polly.Joanna" }, aiText);
        const gather = twiml.gather({
          input: "speech",
          action: `${baseUrl}/respond`,
          language: "en-US",
          timeout: 7,
          speechTimeout: "auto",
        });
      }
    } catch (error) {
      console.error("❌ /respond error:", error.message);
      twiml.say({ voice: "Polly.Joanna" }, "Sorry, could you say that again?");
      const gather = twiml.gather({
        input: "speech",
        action: `${baseUrl}/respond`,
        language: "en-US",
        timeout: 7,
        speechTimeout: "auto",
      });
    }

    const xml = twiml.toString();
    console.log(`📤 /respond TwiML:`, xml);
    res.type("text/xml");
    res.send(xml);
  });

  // Call status callback - clears active call when done
  voiceApp.post("/call-status", (req, res) => {
    const status = req.body.CallStatus;
    console.log(`📞 Call ended: ${status}`);
    activeCallSid = null;
    activeCallInstructions = null;
    res.sendStatus(200);
  });

  // Catch-all error handler
  voiceApp.use((err, req, res, next) => {
    console.error("❌ Server error:", err);
    const r = new VoiceResponse();
    r.say("Sorry, something went wrong.");
    res.type("text/xml");
    res.send(r.toString());
  });

  // ---- WhatsApp Route ----
  voiceApp.post("/whatsapp", async (req, res) => {
    res.type("text/xml");
    res.send("<Response></Response>");

    const from = req.body.From;
    const body = req.body.Body;
    const whatsappFrom = process.env.TWILIO_WHATSAPP_NUMBER || "whatsapp:+14155238886";
    const adminNumber = process.env.WHATSAPP_ADMIN_NUMBER;

    if (!body || !from) return;

    // Optional: restrict to admin number
    if (adminNumber && from !== `whatsapp:${adminNumber}`) {
      console.log(`📱 Ignoring WhatsApp from unauthorized ${from}`);
      return;
    }

    console.log(`📱 WhatsApp from ${from}: ${body}`);

    const replyFn = async (text) => {
      try {
        await twilioClient.messages.create({
          from: whatsappFrom,
          to: from,
          body: text,
        });
      } catch (err) {
        console.error("WhatsApp send error:", err.message);
      }
    };

    try {
      await runAgent(body, replyFn);
    } catch (err) {
      console.error("WhatsApp agent error:", err);
      await replyFn(`❌ Error: ${err.message}`);
    }
  });

  // Start express server
  const server = voiceApp.listen(3001, () => {
    console.log("📞 Server running on port 3001 (Voice + WhatsApp)");
  });

  // Start ngrok tunnel
  const listener = await ngrok.forward({ addr: 3001, authtoken_from_env: true });
  ngrokPublicUrl = listener.url();
  console.log(`🌐 Ngrok tunnel: ${ngrokPublicUrl}`);
  console.log(`📱 WhatsApp webhook: ${ngrokPublicUrl}/whatsapp`);

  voiceServerRunning = true;
  return ngrokPublicUrl;
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
  },
  {
    name: "make_phone_call",
    description: "Make a phone call using Mac's FaceTime app. Optionally speak a message first using AI voice. Contact can be a name or phone number.",
    input_schema: {
      type: "object",
      properties: {
        contact: { type: "string", description: "Contact name or phone number to call" },
        message: { type: "string", description: "Optional message to speak before calling (e.g., 'Hey, I'm calling to say...')" }
      },
      required: ["contact"]
    }
  },
  {
    name: "speak",
    description: "Speak text aloud using AI voice (OpenAI TTS). Falls back to Mac voice if OpenAI fails.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to speak aloud" }
      },
      required: ["text"]
    }
  },
  {
    name: "make_real_call",
    description: "Make a real AI phone call using Twilio. The AI will have a full conversation with the person who answers. Provide a phone number and initial message.",
    input_schema: {
      type: "object",
      properties: {
        phone_number: { type: "string", description: "Phone number to call (include country code, e.g., +1234567890)" },
        initial_message: { type: "string", description: "What the AI should say first (e.g., 'Hi, this is Kiki calling to...')" }
      },
      required: ["phone_number"]
    }
  },
  {
    name: "start_ai_phone_line",
    description: "Start the AI phone server so people can call YOU. Returns a URL to configure in Twilio. Keep this running to receive calls.",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "simple_call",
    description: "Make a simple Twilio call that waits 2 seconds, says hello, delivers your message, then hangs up. No ngrok needed!",
    input_schema: {
      type: "object",
      properties: {
        phone_number: { type: "string", description: "Phone number to call (include + and country code)" },
        message: { type: "string", description: "Message to say after hello" }
      },
      required: ["phone_number"]
    }
  },
  // ---- BRAIN / MEMORY TOOLS ----
  {
    name: "remember",
    description: "Store a fact, preference, correction, or anything important in long-term memory. Use this whenever the user tells you something worth remembering (preferences, names, facts, corrections). Types: 'fact', 'preference', 'correction', 'error', 'person', 'task'.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Memory type: fact, preference, correction, error, person, task" },
        content: { type: "string", description: "The thing to remember" },
        tags: { type: "string", description: "Comma-separated tags for easier search (e.g. 'food,allergy,health')" },
        importance: { type: "integer", description: "1-10 scale. 10 = critical (allergies, passwords), 5 = normal, 1 = trivial" }
      },
      required: ["type", "content"]
    }
  },
  {
    name: "recall",
    description: "Search long-term memory for stored facts, preferences, corrections, etc. Use this when the user asks 'do you remember...', 'what do I like', or when you need context about the user.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for in memory" },
        type: { type: "string", description: "Optional: filter by type (fact, preference, correction, error, person, task)" }
      },
      required: ["query"]
    }
  },
  {
    name: "forget",
    description: "Archive/remove memories matching a query. Use when the user says 'forget that', 'delete that memory', 'that's not true anymore'.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What memories to archive/remove" }
      },
      required: ["query"]
    }
  },
  {
    name: "brain_stats",
    description: "Get statistics about the brain: total memories, conversation count, errors, database size. Use when user asks about the brain or memory system.",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  // ---- SELF-UPGRADE ----
  {
    name: "self_upgrade",
    description: "Use Claude Code to draft a code upgrade for yourself. This writes a proposed patch to a staging file for the developer to review. Use this when the user says 'upgrade yourself', 'fix that gap', or 'build that feature'. The developer must approve before it goes live.",
    input_schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What to build or fix. Be very specific." }
      },
      required: ["task"]
    }
  },
  // ---- CAPABILITY GAPS ----
  {
    name: "log_capability_gap",
    description: "Log something you CANNOT do or a feature that's missing. Use this whenever you hit a wall, lack a tool, or the user asks for something you can't accomplish. This helps the developer know what to build next. Categories: 'integration', 'tool', 'knowledge', 'permission', 'api'.",
    input_schema: {
      type: "object",
      properties: {
        request: { type: "string", description: "What the user asked for that you couldn't do" },
        reason: { type: "string", description: "Why you couldn't do it (missing tool, no API, etc)" },
        category: { type: "string", description: "Category: integration, tool, knowledge, permission, api" },
        priority: { type: "string", description: "low, medium, or high based on how useful this would be" }
      },
      required: ["request", "reason"]
    }
  },
  {
    name: "apify_run_task",
    description: "WARNING: This STARTS a NEW scraper run and costs money! Only use when the user explicitly says 'run' or 'start' the scraper. NEVER use this to check status. For checking status use apify_check_run instead.",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "apify_check_run",
    description: "Check the status of Apify scraper runs. Use this when user asks about status, progress, history, or if the scraper is done. NEVER use apify_run_task for status checks.",
    input_schema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "'last' for most recent run, 'list' to show last 10 runs, or a specific run ID" }
      },
      required: ["run_id"]
    }
  },
  {
    name: "apify_download_csv",
    description: "Download CSV results from an Apify scraper run. Use run_id to pick a specific run (get IDs from apify_check_run with 'list'). If no run_id given, downloads from the last SUCCEEDED run.",
    input_schema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Specific run ID to download from. Leave empty for last succeeded run." },
        filename: { type: "string", description: "Optional filename for the CSV" }
      },
      required: []
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
    case "make_phone_call":
      return await makePhoneCall(input.contact, input.message || "");
    case "speak":
      return await speakWithAIVoice(input.text);
    case "make_real_call":
      return await makeRealCall(input.phone_number, input.initial_message);
    case "start_ai_phone_line":
      return await startAIPhoneLine();
    case "simple_call":
      return await makeSimpleCall(input.phone_number, input.message);
    // ---- BRAIN TOOLS ----
    case "remember": {
      const id = brain.saveMemory(input.type || "fact", input.content, {
        tags: input.tags || "",
        source: "agent",
        importance: input.importance || 5,
      });
      return `Stored memory #${id}: "${input.content}"`;
    }
    case "recall": {
      const memories = brain.searchMemories(input.query, { type: input.type || null, limit: 10 });
      if (memories.length === 0) return "No memories found matching that query.";
      return memories.map(m => `[#${m.id} ${m.type}] ${m.content} (importance: ${m.importance})`).join("\n");
    }
    case "forget": {
      const count = brain.archiveMemoriesByQuery(input.query);
      return count > 0 ? `Archived ${count} memory/memories matching "${input.query}".` : `No memories found matching "${input.query}".`;
    }
    case "brain_stats": {
      const stats = brain.getBrainStats();
      return `🧠 Brain Stats:\n` +
        `- Memories: ${stats.totalMemories} (${stats.archivedMemories} archived)\n` +
        `- Conversations: ${stats.totalConversations}\n` +
        `- Errors logged: ${stats.totalErrors}\n` +
        `- Users: ${stats.totalUsers}\n` +
        `- Memory types: ${stats.memoryTypes.map(t => `${t.type}(${t.count})`).join(", ") || "none"}\n` +
        `- DB size: ${stats.dbSizeMB} MB`;
    }
    // ---- SELF-UPGRADE ----
    case "self_upgrade": {
      const upgradeDir = path.join(__dirname, "upgrades");
      const timestamp = Date.now();
      const outputFile = path.join(upgradeDir, `upgrade-${timestamp}.md`);
      const prompt = `You are upgrading a Telegram bot (index.js in /Users/kiki/clawdbot/).
Read index.js and db.js to understand the current codebase.
TASK: ${input.task}

RULES:
- Output a complete, working code patch
- Show exactly which lines to add/modify
- Include the tool definition AND the executeTool handler AND any db.js changes
- Do NOT break existing functionality
- Write the full upgrade plan and code to: ${outputFile}

Format the output file as:
## Upgrade: [title]
### What it does
[description]
### Changes to index.js
[code blocks with context]
### Changes to db.js (if any)
[code blocks]
### New dependencies (if any)
[npm packages]`;

      return new Promise((resolve) => {
        const child = exec(
          `claude --print -p "${prompt.replace(/"/g, '\\"')}"`,
          { cwd: __dirname, timeout: 120000, maxBuffer: 1024 * 1024 },
          async (err, stdout, stderr) => {
            if (err) {
              resolve(`ERROR: Claude Code failed: ${err.message}`);
              return;
            }
            try {
              await fs.outputFile(outputFile, stdout);
              resolve(`✅ Upgrade drafted!\nFile: ${outputFile}\n\nUse /review in Telegram to see it, then /apply to apply it.`);
            } catch (writeErr) {
              resolve(`ERROR: Could not write upgrade file: ${writeErr.message}`);
            }
          }
        );
      });
    }
    // ---- CAPABILITY GAPS ----
    case "log_capability_gap": {
      const id = brain.logCapabilityGap(input.request, {
        reason: input.reason || "",
        category: input.category || "",
        priority: input.priority || "medium",
      });
      return `📋 Logged capability gap #${id}: "${input.request}" — This will be reviewed by the developer.`;
    }
    // ---- APIFY TOOLS ----
    case "apify_run_task": {
      const token = process.env.APIFY_API_TOKEN;
      if (!token) return "ERROR: APIFY_API_TOKEN not set in .env";
      const res = await fetch(`https://api.apify.com/v2/actor-tasks/zeegson~dfw-rentals-v1/runs?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) return `ERROR: ${JSON.stringify(data)}`;
      const run = data.data;
      return `✅ Scraper started!\nRun ID: ${run.id}\nStatus: ${run.status}\nStarted: ${run.startedAt}\n\nUse apify_check_run with run_id "${run.id}" to check progress.`;
    }
    case "apify_check_run": {
      const token = process.env.APIFY_API_TOKEN;
      if (!token) return "ERROR: APIFY_API_TOKEN not set in .env";
      if (input.run_id === "list") {
        const res = await fetch(`https://api.apify.com/v2/actor-tasks/zeegson~dfw-rentals-v1/runs?token=${token}&limit=10&desc=true`);
        const data = await res.json();
        if (!res.ok) return `ERROR: ${JSON.stringify(data)}`;
        if (!data.data?.items?.length) return "No runs found.";
        return data.data.items.map((r, i) =>
          `${i + 1}. ${r.status} | ${r.startedAt} | Items: ${r.stats?.itemCount ?? "?"} | ID: ${r.id}`
        ).join("\n");
      } else if (input.run_id === "last") {
        const res = await fetch(`https://api.apify.com/v2/actor-tasks/zeegson~dfw-rentals-v1/runs?token=${token}&limit=1&desc=true`);
        const data = await res.json();
        if (!res.ok) return `ERROR: ${JSON.stringify(data)}`;
        if (!data.data?.items?.length) return "No runs found.";
        const run = data.data.items[0];
        return `Run ID: ${run.id}\nStatus: ${run.status}\nDataset ID: ${run.defaultDatasetId}\nStarted: ${run.startedAt}\nFinished: ${run.finishedAt || "still running..."}\nItems: ${run.stats?.itemCount ?? "unknown"}`;
      } else {
        const res = await fetch(`https://api.apify.com/v2/actor-runs/${input.run_id}?token=${token}`);
        const data = await res.json();
        if (!res.ok) return `ERROR: ${JSON.stringify(data)}`;
        const run = data.data;
        return `Run ID: ${run.id}\nStatus: ${run.status}\nDataset ID: ${run.defaultDatasetId}\nStarted: ${run.startedAt}\nFinished: ${run.finishedAt || "still running..."}\nItems: ${run.stats?.itemCount ?? "unknown"}`;
      }
    }
    case "apify_download_csv": {
      const token = process.env.APIFY_API_TOKEN;
      if (!token) return "ERROR: APIFY_API_TOKEN not set in .env";
      const fname = input.filename || `dfw-rentals-${Date.now()}.csv`;
      let csvUrl;
      if (input.run_id) {
        // Download from specific run
        csvUrl = `https://api.apify.com/v2/actor-runs/${input.run_id}/dataset/items?token=${token}&format=csv`;
      } else {
        // Find last SUCCEEDED run
        const runsRes = await fetch(`https://api.apify.com/v2/actor-tasks/zeegson~dfw-rentals-v1/runs?token=${token}&limit=10&desc=true`);
        const runsData = await runsRes.json();
        const succeeded = runsData.data?.items?.find(r => r.status === "SUCCEEDED");
        if (!succeeded) return "ERROR: No succeeded runs found.";
        csvUrl = `https://api.apify.com/v2/actor-runs/${succeeded.id}/dataset/items?token=${token}&format=csv`;
      }
      const downloadPath = path.join(os.homedir(), "Downloads", fname);
      const res = await fetch(csvUrl);
      if (!res.ok) return `ERROR: Failed to download CSV (${res.status})`;
      const csvData = await res.text();
      await fs.writeFile(downloadPath, csvData);
      const lines = csvData.split("\n").length - 1;
      return `✅ CSV downloaded!\nPath: ${downloadPath}\nRows: ${lines}\nSize: ${(csvData.length / 1024).toFixed(1)} KB`;
    }
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
// CONVERSATION THREADING: Keep recent messages per chat
// ============================================================

const chatThreads = new Map(); // chatId -> [{role, content}]
const MAX_THREAD_LENGTH = 20;
const THREAD_TIMEOUT = 30 * 60 * 1000; // 30 min inactivity clears thread
const threadTimers = new Map();

function getThread(chatId) {
  if (!chatThreads.has(chatId)) chatThreads.set(chatId, []);
  // Reset inactivity timer
  if (threadTimers.has(chatId)) clearTimeout(threadTimers.get(chatId));
  threadTimers.set(chatId, setTimeout(() => {
    chatThreads.delete(chatId);
    threadTimers.delete(chatId);
    console.log(`🧹 Thread expired for chat ${chatId}`);
  }, THREAD_TIMEOUT));
  return chatThreads.get(chatId);
}

function addToThread(chatId, role, content) {
  const thread = getThread(chatId);
  thread.push({ role, content });
  // Keep only last N messages
  while (thread.length > MAX_THREAD_LENGTH) thread.shift();
}

// ============================================================
// AGENT LOOP: Claude decides what tools to use and chains them
// ============================================================

async function runAgent(userMessage, replyFn, { platform = "telegram", userId = "", chatId = "" } = {}) {
  if (paused) return replyFn("⏸️ Bot is paused. Send /resume to continue.");
  if (!canMakeApiCall()) return replyFn(`🚫 Daily API limit reached (${dailyLimit}). Send /limit <number> to increase.`);

  // Log incoming message
  brain.logConversation(platform, "user", userMessage, { userId });
  if (userId) brain.upsertUser(userId, { platform });

  replyFn("🤔 Thinking…");
  activeAbortController = new AbortController();

  const skills = loadSkills();

  // Load relevant memories for context injection
  const recentMemories = brain.getRecentMemories(15);
  const relevantMemories = brain.searchMemories(userMessage, { limit: 10 });
  const recentErrors = brain.getRecentErrors(5);

  // Deduplicate memories
  const allMemories = new Map();
  for (const m of [...recentMemories, ...relevantMemories]) {
    allMemories.set(m.id, m);
  }

  let memoryContext = "";
  if (allMemories.size > 0) {
    memoryContext = "\n\nYOUR LONG-TERM MEMORY (things you've been told to remember):\n";
    for (const m of allMemories.values()) {
      memoryContext += `- [${m.type}] ${m.content}\n`;
    }
  }

  let errorContext = "";
  if (recentErrors.length > 0) {
    errorContext = "\n\nRECENT ERRORS (avoid repeating these mistakes):\n";
    for (const e of recentErrors) {
      errorContext += `- ${e.tool}: ${e.error_message}\n`;
    }
  }

  // Build messages with conversation history
  const thread = chatId ? getThread(chatId) : [];
  const messages = [
    ...thread.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage }
  ];

  // Save user message to thread
  if (chatId) addToThread(chatId, "user", userMessage);
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

BRAIN & MEMORY:
- You have a persistent brain (SQLite database) that survives restarts.
- Use 'remember' to store facts, preferences, corrections, people info, etc.
- Use 'recall' to search your memory when you need context.
- Use 'forget' to archive memories when asked.
- PROACTIVELY remember important things the user tells you (names, preferences, corrections).
- When the user corrects you, ALWAYS store a correction memory so you don't repeat the mistake.
- Use 'brain_stats' to report on your memory system.

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
6. LEARN FROM MISTAKES: If a tool fails, remember what went wrong so you don't repeat it.
7. CAPABILITY GAPS: If the user asks you to do something you CANNOT do (missing tool, no API, no integration), use log_capability_gap to record it. Be specific about what's missing. This helps the developer build new features.

HOW TO SEND AN IMAGE BY EMAIL:
Step 1: Download the image to /tmp/ using: run_shell "curl -sL -o /tmp/image.jpg 'DIRECT_IMAGE_URL'"
Step 2: Verify with: run_shell "file /tmp/image.jpg" — MUST say "JPEG image data" or "PNG image data"
Step 3: Use send_email_with_attachment with attachment_path "/tmp/image.jpg"
NEVER just open a URL in the browser when asked to email something. DOWNLOAD first, then ATTACH.

IMAGE SOURCES:
- Dog pictures: curl -sL -o /tmp/image.jpg 'https://placedog.net/500/500?random'
- Cat pictures: curl -sL -o /tmp/image.jpg 'https://cataas.com/cat'
- Any search: use curl on DuckDuckGo, find direct .jpg/.png URLs, download with curl -sL -o
- ALWAYS verify: run_shell "file /tmp/image.jpg" — if it says HTML, the URL was wrong.

DATA ANALYSIS (CSV, JSON, large files):
- NEVER try to read large files directly with read_file. It will blow up the context.
- Instead, write a quick Python script to /tmp/analyze.py that does the analysis, then run it with run_shell.
- Example: run_shell "python3 -c \\"import csv; data=list(csv.DictReader(open('/path/to/file.csv'))); print([r for r in data if float(r.get('price','9999')) < 1400])\\""
- Or write a proper script: write_file to /tmp/analyze.py, then run_shell "python3 /tmp/analyze.py"
- For finding files: run_shell "ls -t ~/Downloads/*.csv | head -5" to find recent CSVs
- ALWAYS use scripts for data questions. One tool call to write the script, one to run it. Done.

REAL AI PHONE CALLS:
- Use simple_call to make real phone calls via Twilio
- AI listens, understands, and responds in real-time
- Use speak tool to just say something aloud with AI voice${skills}${memoryContext}${errorContext}`;

  let iterations = 0;
  const MAX_ITERATIONS = 15;
  let lastToolCall = null;
  let duplicateCount = 0;

  try {
    while (iterations < MAX_ITERATIONS) {
      if (paused) {
        replyFn("⏸️ Task interrupted. Bot paused.");
        return;
      }
      if (!canMakeApiCall()) {
        replyFn(`🚫 Daily API limit reached mid-task (${dailyLimit}).`);
        return;
      }

      iterations++;
      trackApiCall();

      // Smart model routing: Sonnet for first call (decides tools), Haiku for follow-ups
      const model = iterations <= 1 ? "claude-sonnet-4-20250514" : "claude-3-5-haiku-20241022";

      const response = await anthropic.messages.create({
        model,
        max_tokens: 4096,
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
              replyFn("⏸️ Task interrupted. Bot paused.");
              return;
            }
            console.log(`🔧 Tool: ${block.name}(${JSON.stringify(block.input)})`);

            // Detect duplicate tool calls (same tool + same input = loop)
            const callKey = `${block.name}:${JSON.stringify(block.input)}`;
            if (callKey === lastToolCall) {
              duplicateCount++;
              if (duplicateCount >= 2) {
                console.log(`🔁 Stopping: duplicate tool call detected (${block.name})`);
                replyFn("I was going in circles. Let me know what you need more specifically.");
                return;
              }
            } else {
              duplicateCount = 0;
            }
            lastToolCall = callKey;

            let result;
            try {
              result = await executeTool(block.name, block.input);
            } catch (err) {
              result = `ERROR: ${err.message}`;
              brain.logError(block.name, block.input, err.message);
            }
            // Log errors from tool results too
            if (typeof result === "string" && result.startsWith("ERROR:")) {
              brain.logError(block.name, block.input, result);
            }
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
          // Log outgoing message
          brain.logConversation(platform, "assistant", finalResponse, { userId });
          // Save to thread so next message has context
          if (chatId) addToThread(chatId, "assistant", finalResponse);
          replyFn(finalResponse);
        }
        activeAbortController = null;
        return;
      }
    }

    replyFn("⚠️ Task took too many steps. Stopping here.");
  } finally {
    activeAbortController = null;
  }
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

bot.on("message", async (msg) => {
  if (!isAdmin(msg) && !isAllowed(msg)) return;
  if (msg.text?.startsWith("/")) return;
  const chatId = msg.chat.id;
  const userMessage = msg.text?.trim();
  if (!userMessage) return;

  const replyFn = (text) => bot.sendMessage(chatId, text);
  try {
    await runAgent(userMessage, replyFn, { platform: "telegram", userId: String(msg.from.id), chatId: String(chatId) });
  } catch (err) {
    console.error("agent error:", err);
    replyFn(`❌ Error: ${err.message}`);
  }
});

// ============================================================
// BRAIN MANAGEMENT COMMANDS
// ============================================================

bot.onText(/\/brain/, (msg) => {
  if (!isAdmin(msg)) return;
  const stats = brain.getBrainStats();
  bot.sendMessage(msg.chat.id,
    `🧠 *Brain Stats*\n` +
    `Memories: ${stats.totalMemories} (${stats.archivedMemories} archived)\n` +
    `Conversations: ${stats.totalConversations}\n` +
    `Errors: ${stats.totalErrors}\n` +
    `Users: ${stats.totalUsers}\n` +
    `Types: ${stats.memoryTypes.map(t => `${t.type}(${t.count})`).join(", ") || "none"}\n` +
    `DB: ${stats.dbSizeMB} MB`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/memories(?:\s+(.+))?/, (msg, match) => {
  if (!isAdmin(msg)) return;
  const query = match[1] || null;
  const memories = query
    ? brain.searchMemories(query, { limit: 20 })
    : brain.getRecentMemories(20);
  if (memories.length === 0) {
    return bot.sendMessage(msg.chat.id, "No memories found.");
  }
  const text = memories.map(m =>
    `#${m.id} [${m.type}] ${m.content} (imp:${m.importance})`
  ).join("\n");
  bot.sendMessage(msg.chat.id, `🧠 Memories:\n${text}`);
});

bot.onText(/\/forget\s+(.+)/, (msg, match) => {
  if (!isAdmin(msg)) return;
  const query = match[1];
  const count = brain.archiveMemoriesByQuery(query);
  bot.sendMessage(msg.chat.id, count > 0
    ? `🗑️ Archived ${count} memory/memories matching "${query}".`
    : `No memories found matching "${query}".`
  );
});

bot.onText(/\/export/, (msg) => {
  if (!isAdmin(msg)) return;
  const filePath = brain.exportBrainToFile();
  bot.sendMessage(msg.chat.id, `📦 Brain exported to: ${filePath}`);
});

bot.onText(/\/cleanup(?:\s+(\d+))?/, (msg, match) => {
  if (!isAdmin(msg)) return;
  const days = parseInt(match[1]) || 90;
  const result = brain.cleanup({ olderThanDays: days });
  bot.sendMessage(msg.chat.id,
    `🧹 Cleanup (>${days} days):\n` +
    `Memories archived: ${result.archived}\n` +
    `Conversations deleted: ${result.conversationsDeleted}`
  );
});

bot.onText(/\/purge/, (msg) => {
  if (!isAdmin(msg)) return;
  const count = brain.deleteArchivedMemories();
  bot.sendMessage(msg.chat.id, `🗑️ Permanently deleted ${count} archived memories.`);
});

// ============================================================
// CAPABILITY GAPS / WISHLIST COMMANDS
// ============================================================

bot.onText(/\/wishlist(?:\s+(.+))?/, (msg, match) => {
  if (!isAdmin(msg)) return;
  const newWish = match[1];
  if (newWish) {
    const id = brain.logCapabilityGap(newWish, { category: "user_request", priority: "high", userId: String(msg.from.id) });
    return bot.sendMessage(msg.chat.id, `📋 Added to wishlist (#${id}): "${newWish}"`);
  }
  const gaps = brain.getOpenGaps();
  if (gaps.length === 0) return bot.sendMessage(msg.chat.id, "📋 Wishlist is empty! The bot can do everything... for now.");
  const text = gaps.map(g =>
    `#${g.id} [${g.priority}] ${g.request}\n   → ${g.reason || "no reason logged"} (${g.category || "uncategorized"})`
  ).join("\n\n");
  bot.sendMessage(msg.chat.id, `📋 Open Capability Gaps:\n\n${text}`);
});

bot.onText(/\/gaps(?:\s+(all|done|open|building))?/, (msg, match) => {
  if (!isAdmin(msg)) return;
  const filter = match[1] || null;
  const gaps = filter ? brain.getAllGaps({ status: filter }) : brain.getAllGaps();
  if (gaps.length === 0) return bot.sendMessage(msg.chat.id, "No gaps found.");
  const text = gaps.map(g =>
    `#${g.id} [${g.status}] [${g.priority}] ${g.request}${g.resolution ? "\n   ✅ " + g.resolution : ""}`
  ).join("\n\n");
  bot.sendMessage(msg.chat.id, `📋 Capability Gaps (${filter || "all"}):\n\n${text}`);
});

bot.onText(/\/gapdone\s+(\d+)\s*(.*)/, (msg, match) => {
  if (!isAdmin(msg)) return;
  const id = parseInt(match[1]);
  const resolution = match[2] || "Resolved";
  brain.updateGapStatus(id, "done", resolution);
  bot.sendMessage(msg.chat.id, `✅ Gap #${id} marked as done: ${resolution}`);
});

bot.onText(/\/gapdel\s+(\d+)/, (msg, match) => {
  if (!isAdmin(msg)) return;
  brain.deleteGap(parseInt(match[1]));
  bot.sendMessage(msg.chat.id, `🗑️ Gap #${match[1]} deleted.`);
});

// ============================================================
// SELF-UPGRADE REVIEW COMMANDS
// ============================================================

bot.onText(/\/upgrades/, async (msg) => {
  if (!isAdmin(msg)) return;
  const upgradeDir = path.join(__dirname, "upgrades");
  try {
    const files = (await fs.readdir(upgradeDir)).filter(f => f.endsWith(".md")).sort().reverse();
    if (files.length === 0) return bot.sendMessage(msg.chat.id, "No upgrade drafts found.");
    const list = files.map((f, i) => `${i + 1}. ${f}`).join("\n");
    bot.sendMessage(msg.chat.id, `📦 Upgrade Drafts:\n${list}\n\nUse /review <filename> to view one.`);
  } catch (e) {
    bot.sendMessage(msg.chat.id, "No upgrades directory found.");
  }
});

bot.onText(/\/review(?:\s+(.+))?/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const upgradeDir = path.join(__dirname, "upgrades");
  try {
    let filename = match[1];
    if (!filename) {
      const files = (await fs.readdir(upgradeDir)).filter(f => f.endsWith(".md")).sort().reverse();
      if (files.length === 0) return bot.sendMessage(msg.chat.id, "No upgrade drafts found.");
      filename = files[0];
    }
    const filePath = path.join(upgradeDir, filename);
    const content = await fs.readFile(filePath, "utf8");
    // Telegram has 4096 char limit, split if needed
    const chunks = content.match(/[\s\S]{1,4000}/g) || [];
    for (const chunk of chunks) {
      await bot.sendMessage(msg.chat.id, chunk);
    }
    bot.sendMessage(msg.chat.id, `\n✅ End of ${filename}\nUse /apply ${filename} to apply this upgrade.`);
  } catch (e) {
    bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
  }
});

bot.onText(/\/apply\s+(.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const filename = match[1];
  const filePath = path.join(__dirname, "upgrades", filename);
  try {
    const content = await fs.readFile(filePath, "utf8");
    // Run Claude Code to apply the upgrade
    bot.sendMessage(msg.chat.id, `⚙️ Applying upgrade ${filename}... Claude Code is working...`);
    exec(
      `claude --print -p "Apply the following upgrade to the codebase in /Users/kiki/clawdbot/. Make the exact changes described. Do NOT remove or break existing code. Here is the upgrade plan:\n\n${content.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
      { cwd: __dirname, timeout: 120000, maxBuffer: 1024 * 1024 },
      async (err, stdout) => {
        if (err) {
          return bot.sendMessage(msg.chat.id, `❌ Apply failed: ${err.message}`);
        }
        bot.sendMessage(msg.chat.id, `✅ Upgrade applied! Output:\n${stdout.substring(0, 3000)}\n\nRestarting bot...`);
        // Restart the bot
        setTimeout(() => process.exit(0), 2000);
      }
    );
  } catch (e) {
    bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
  }
});

// ============================================================
// EMAIL MONITOR: Poll Mail.app for new unread emails
// ============================================================

let lastSeenEmailDate = null;
let emailMonitorEnabled = true;
const EMAIL_CHECK_INTERVAL = 30000; // 30 seconds

function checkForNewEmails() {
  if (!emailMonitorEnabled || !ADMIN_ID) return;

  const script = `
tell application "Mail"
  set unreadMsgs to (messages of inbox whose read status is false)
  set msgCount to count of unreadMsgs
  if msgCount > 0 then
    set latestMsg to item 1 of unreadMsgs
    set msgSubject to subject of latestMsg
    set msgSender to sender of latestMsg
    set msgDate to date received of latestMsg
    set msgId to id of latestMsg
    return (msgId as string) & "|||" & msgSender & "|||" & msgSubject & "|||" & (msgDate as string) & "|||" & (msgCount as string)
  else
    return "NO_NEW_MAIL"
  end if
end tell
  `;

  exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err, stdout) => {
    if (err) {
      console.error("📧 Mail check error:", err.message);
      return;
    }

    const result = stdout.trim();
    if (result === "NO_NEW_MAIL" || !result) return;

    const [msgId, sender, subject, dateStr, unreadCount] = result.split("|||");
    if (!sender) return;

    // Skip bounce/system emails
    const lowerSender = sender.toLowerCase();
    const lowerSubject = (subject || "").toLowerCase();
    if (lowerSender.includes("mail delivery") || lowerSender.includes("mailer-daemon") ||
        lowerSender.includes("postmaster") || lowerSubject.includes("undelivered") ||
        lowerSubject.includes("returned") || lowerSubject.includes("delivery status")) {
      return;
    }

    // Skip if we already notified about this one
    if (msgId === lastSeenEmailDate) return;
    lastSeenEmailDate = msgId;

    const notification =
      `📧 *New Email*\n` +
      `From: ${sender}\n` +
      `Subject: ${subject}\n` +
      `Unread: ${unreadCount}`;

    bot.sendMessage(ADMIN_ID, notification, { parse_mode: "Markdown" }).catch(() => {});
    brain.logConversation("email", "system", `New email from ${sender}: ${subject}`, { userId: "mail" });
    console.log(`📧 Notified: new email from ${sender}`);
  });
}

setInterval(checkForNewEmails, EMAIL_CHECK_INTERVAL);
console.log(`📧 Email monitor active (checking every ${EMAIL_CHECK_INTERVAL / 1000}s)`);

bot.onText(/\/emailmon\s*(on|off)?/, (msg, match) => {
  if (!isAdmin(msg)) return;
  const toggle = match[1];
  if (toggle === "on") emailMonitorEnabled = true;
  else if (toggle === "off") emailMonitorEnabled = false;
  else emailMonitorEnabled = !emailMonitorEnabled;
  bot.sendMessage(msg.chat.id, `📧 Email monitor: ${emailMonitorEnabled ? "ON ✅" : "OFF ❌"}`);
});

console.log("Clawdbot running. Send /ping in Telegram.");

// Start shared server for WhatsApp + Voice
ensureVoiceServerRunning().then(url => {
  console.log("📱 To enable WhatsApp, set your Twilio sandbox webhook to:");
  console.log(`   POST ${url}/whatsapp`);
}).catch(err => {
  console.error("❌ Failed to start server:", err.message);
  console.log("   WhatsApp and voice calls will not be available.");
});
