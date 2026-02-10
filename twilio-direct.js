require("dotenv").config();
const { VoiceResponse } = require("twilio").twiml;
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");

const app = express();
const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Store conversations in memory (for demo)
const conversations = new Map();

// TwiML directly in the call - no server needed!
app.post("/voice", express.urlencoded({type: '*/*'}), async (req, res) => {
  const response = new VoiceResponse();
  
  // Check if this is the first call or continuing
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult;
  
  if (!userSpeech) {
    // First time - say initial message
    response.say({ voice: "Polly.Joanna" }, "Hi, this is Kiki, an AI assistant. How can I help you?");
    
    // Gather response
    const gather = response.gather({
      input: "speech",
      action: `/voice?CallSid=${callSid}`,
      language: "en-US",
      timeout: 3,
      maxSpeechTime: 10
    });
    
    res.type("text/xml");
    res.send(response.toString());
    return;
  }
  
  try {
    // Get AI response
    const aiResponse = await getAIResponse(callSid, userSpeech);
    
    response.say({ voice: "Polly.Joanna" }, aiResponse);
    
    // Continue conversation unless goodbye
    if (!aiResponse.toLowerCase().includes("goodbye")) {
      const gather = response.gather({
        input: "speech",
        action: `/voice?CallSid=${callSid}`,
        language: "en-US",
        timeout: 3,
        maxSpeechTime: 10
      });
    } else {
      response.say({ voice: "Polly.Joanna" }, "Goodbye!");
      response.hangup();
    }
    
  } catch (error) {
    console.error("Error:", error);
    response.say({ voice: "Polly.Joanna" }, "I'm having trouble understanding. Let me try again.");
    const gather = response.gather({
      input: "speech",
      action: `/voice?CallSid=${callSid}`,
      language: "en-US",
      timeout: 3,
      maxSpeechTime: 10
    });
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Twilio server running on port ${PORT}`);
});
