require("dotenv").config();
const express = require("express");
const { VoiceResponse } = require("twilio").twiml;
const WebSocket = require("ws");
const http = require("http");
const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");
const fs = require("fs-extra");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Initialize AI clients
const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Store active calls
const activeCalls = new Map();

// WebSocket connection for media streams
wss.on("connection", (ws, req) => {
  console.log("WebSocket connected");
  const callSid = req.url.substring(1);
  activeCalls.set(callSid, { ws, state: "listening" });
  
  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);
      if (data.event === "media") {
        const call = activeCalls.get(callSid);
        if (!call || call.state !== "listening") return;
        
        // Save audio chunk for processing
        if (!call.audioBuffer) call.audioBuffer = [];
        call.audioBuffer.push(Buffer.from(data.media.payload, "base64"));
        
        // Process every 1 second of audio
        if (call.audioBuffer.length >= 50) {
          call.state = "processing";
          await processAudio(callSid, call.audioBuffer);
          call.audioBuffer = [];
          call.state = "listening";
        }
      }
    } catch (error) {
      console.error("WebSocket error:", error);
    }
  });
  
  ws.on("close", () => {
    console.log(`WebSocket closed for call ${callSid}`);
    activeCalls.delete(callSid);
  });
});

// Process audio with Whisper and Claude
async function processAudio(callSid, audioBuffer) {
  try {
    const call = activeCalls.get(callSid);
    if (!call) return;
    
    // Combine audio chunks
    const audioData = Buffer.concat(audioBuffer);
    
    // Save to temp file
    const tempFile = path.join(__dirname, "temp", `${callSid}.mulaw`);
    await fs.writeFile(tempFile, audioData);
    
    // Convert to WAV for Whisper
    const wavFile = path.join(__dirname, "temp", `${callSid}.wav`);
    await runShell(`ffmpeg -y -f mulaw -ar 8000 -i "${tempFile}" "${wavFile}"`);
    
    // Transcribe with Whisper
    const transcription = await transcribeAudio(wavFile);
    console.log(`Transcription: ${transcription}`);
    
    if (transcription && transcription.trim()) {
      // Get AI response
      const response = await getAIResponse(callSid, transcription);
      console.log(`AI Response: ${response}`);
      
      if (response) {
        // Convert to speech
        const speechFile = await synthesizeSpeech(response);
        
        // Send back to caller
        await sendAudioToCall(callSid, speechFile);
        
        // Clean up
        await fs.remove(speechFile);
      }
    }
    
    // Clean up temp files
    await fs.remove(tempFile);
    await fs.remove(wavFile);
    
  } catch (error) {
    console.error("Error processing audio:", error);
    const call = activeCalls.get(callSid);
    if (call) call.state = "listening";
  }
}

// Transcribe audio with Whisper
async function transcribeAudio(audioFile) {
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFile),
      model: "whisper-1",
    });
    return transcription.text;
  } catch (error) {
    console.error("Whisper error:", error);
    return "";
  }
}

// Get AI response from Claude
async function getAIResponse(callSid, userMessage) {
  try {
    const call = activeCalls.get(callSid);
    if (!call) return "";
    
    // Initialize conversation if needed
    if (!call.messages) {
      call.messages = [{
        role: "user",
        content: "You are Kiki, a helpful AI assistant having a phone conversation. Be friendly, concise, and natural. The person just picked up the phone."
      }];
    }
    
    // Add user message
    call.messages.push({ role: "user", content: userMessage });
    
    // Get response from Claude
    const response = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 150,
      messages: call.messages,
    });
    
    const aiMessage = response.content[0].text;
    call.messages.push({ role: "assistant", content: aiMessage });
    
    return aiMessage;
  } catch (error) {
    console.error("Claude error:", error);
    return "I'm sorry, I didn't catch that. Could you repeat?";
  }
}

// Synthesize speech with OpenAI TTS
async function synthesizeSpeech(text) {
  try {
    const response = await openai.audio.speech.create({
      model: "tts-1",
      voice: "nova",
      input: text,
    });
    
    const speechFile = path.join(__dirname, "temp", `speech_${Date.now()}.mp3`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(speechFile, buffer);
    
    return speechFile;
  } catch (error) {
    console.error("TTS error:", error);
    return null;
  }
}

// Send audio back to the call
async function sendAudioToCall(callSid, audioFile) {
  try {
    const call = activeCalls.get(callSid);
    if (!call || !call.ws) return;
    
    // Convert MP3 to mulaw for Twilio
    const mulawFile = audioFile.replace(".mp3", ".mulaw");
    await runShell(`ffmpeg -y -i "${audioFile}" -f mulaw -ar 8000 "${mulawFile}"`);
    
    // Read and send audio
    const audioData = await fs.readFile(mulawFile);
    const base64Audio = audioData.toString("base64");
    
    // Send in chunks
    const chunkSize = 160;
    for (let i = 0; i < base64Audio.length; i += chunkSize) {
      const chunk = base64Audio.substring(i, i + chunkSize);
      call.ws.send(JSON.stringify({
        event: "media",
        streamSid: callSid,
        media: { payload: chunk }
      }));
      await new Promise(resolve => setTimeout(resolve, 20)); // 20ms delay
    }
    
    // Mark end of speech
    call.ws.send(JSON.stringify({
      event: "mark",
      streamSid: callSid,
      mark: { name: "speechEnd" }
    }));
    
    await fs.remove(mulawFile);
  } catch (error) {
    console.error("Error sending audio:", error);
  }
}

// Helper to run shell commands
function runShell(command) {
  return new Promise((resolve, reject) => {
    const { exec } = require("child_process");
    exec(command, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

// Twilio webhook for incoming calls
app.post("/voice", (req, res) => {
  const response = new VoiceResponse();
  
  response.start().stream({
    url: `wss://${req.headers.host}/`,
  });
  
  response.say({ voice: "alice" }, "Please wait while I connect you to Kiki.");
  
  res.type("text/xml");
  res.send(response.toString());
});

// Twilio webhook for when call connects
app.post("/connect", (req, res) => {
  console.log(`Call connected: ${req.body.CallSid}`);
  res.status(200).send();
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "healthy", activeCalls: activeCalls.size });
});

// Ensure temp directory exists
fs.ensureDirSync("./temp");

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Twilio server running on port ${PORT}`);
  console.log(`Active calls: ${activeCalls.size}`);
});
