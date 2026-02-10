require("dotenv").config();
const { VoiceResponse } = require("twilio").twiml;
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");

const app = express();
const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Store conversations
const conversations = new Map();

// Twilio webhook for incoming/outgoing calls
app.post("/voice", (req, res) => {
  const response = new VoiceResponse();
  
  const gather = response.gather({
    input: "speech",
    action: "/process",
    language: "en-US",
    timeout: 3,
    maxSpeechTime: 10,
    hints: "hello,hi,yes,no,bye,goodbye"
  });
  
  gather.say({ voice: "Polly.Joanna" }, "Hi, this is Kiki, an AI assistant. How can I help you today?");
  
  res.type("text/xml");
  res.send(response.toString());
});

// Process what the user said
app.post("/process", async (req, res) => {
  const userSpeech = req.body.SpeechResult;
  const response = new VoiceResponse();
  
  if (!userSpeech) {
    response.say({ voice: "Polly.Joanna" }, "I didn't catch that. Could you repeat?");
    response.redirect("/voice");
    res.type("text/xml");
    res.send(response.toString());
    return;
  }
  
  try {
    // Get AI response
    const aiResponse = await getAIResponse(req.body.CallSid, userSpeech);
    
    response.say({ voice: "Polly.Joanna" }, aiResponse);
    
    // Continue conversation
    if (!aiResponse.toLowerCase().includes("goodbye")) {
      response.redirect("/voice");
    } else {
      response.hangup();
    }
    
  } catch (error) {
    console.error("Error:", error);
    response.say({ voice: "Polly.Joanna" }, "I'm having trouble understanding. Let me try again.");
    response.redirect("/voice");
  }
  
  res.type("text/xml");
  res.send(response.toString());
});

// Get AI response
async function getAIResponse(callSid, userMessage) {
  try {
    let messages = conversations.get(callSid) || [{
      role: "user",
      content: "You are Kiki, a helpful AI assistant having a phone conversation. Be friendly, concise, and natural. Keep responses under 30 words."
    }];
    
    messages.push({ role: "user", content: userMessage });
    
    const response = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 100,
      messages: messages,
    });
    
    const aiMessage = response.content[0].text;
    messages.push({ role: "assistant", content: aiMessage });
    conversations.set(callSid, messages);
    
    return aiMessage;
  } catch (error) {
    console.error("Claude error:", error);
    return "I'm sorry, I didn't catch that. Could you repeat?";
  }
}

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "healthy", activeConversations: conversations.size });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Simple Twilio server running on port ${PORT}`);
});
