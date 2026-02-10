require("dotenv").config();
const { VoiceResponse } = require("twilio").twiml;
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.urlencoded({ extended: true }));

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const conversations = new Map();

// Main webhook - waits for answer
app.post("/voice", (req, res) => {
  const response = new VoiceResponse();
  
  // Start gathering speech immediately - this waits for someone to speak
  const gather = response.gather({
    input: "speech",
    action: "/conversation",
    language: "en-US",
    timeout: 5, // Wait 5 seconds for speech
    maxSpeechTime: 10,
    hints: "hello,hi,yes,no,who is this,what do you want"
  });
  
  // Optional: play a ring sound while waiting
  // gather.play({}, "https://demo.twilio.com/docs/classic.mp3");
  
  res.type("text/xml");
  res.send(response.toString());
});

// Conversation handler
app.post("/conversation", async (req, res) => {
  const response = new VoiceResponse();
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult;
  
  // If no speech detected, try again
  if (!userSpeech) {
    const gather = response.gather({
      input: "speech",
      action: "/conversation",
      language: "en-US",
      timeout: 3,
      maxSpeechTime: 10
    });
    gather.say({ voice: "Polly.Joanna" }, "Hello? Are you there?");
    
    res.type("text/xml");
    res.send(response.toString());
    return;
  }
  
  try {
    // Get AI response
    const aiResponse = await getAIResponse(callSid, userSpeech);
    
    response.say({ voice: "Polly.Joanna" }, aiResponse);
    
    // Check if conversation should end
    if (shouldEndConversation(userSpeech, aiResponse)) {
      response.say({ voice: "Polly.Joanna" }, "Goodbye!");
      response.hangup();
    } else {
      // Continue gathering
      const gather = response.gather({
        input: "speech",
        action: "/conversation",
        language: "en-US",
        timeout: 3,
        maxSpeechTime: 10
      });
    }
    
  } catch (error) {
    console.error("Error:", error);
    response.say({ voice: "Polly.Joanna" }, "I'm having trouble understanding. Could you repeat?");
    
    const gather = response.gather({
      input: "speech",
      action: "/conversation",
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
    // Initialize conversation if needed
    if (!conversations.has(callSid)) {
      conversations.set(callSid, [{
        role: "user",
        content: "You are Kiki, a helpful AI assistant having a phone conversation. Be friendly, natural, and concise. The person just answered the phone."
      }]);
    }
    
    const messages = conversations.get(callSid);
    messages.push({ role: "user", content: userMessage });
    
    const response = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 100,
      messages: messages,
    });
    
    const aiMessage = response.content[0].text;
    messages.push({ role: "assistant", content: aiMessage });
    
    return aiMessage;
  } catch (error) {
    console.error("Claude error:", error);
    return "I'm sorry, I didn't catch that. Could you repeat?";
  }
}

// Check if conversation should end
function shouldEndConversation(userMessage, aiMessage) {
  const endPhrases = ["goodbye", "bye", "hang up", "done", "thanks", "thank you"];
  const lowerUser = userMessage.toLowerCase();
  const lowerAI = aiMessage.toLowerCase();
  
  return endPhrases.some(phrase => 
    lowerUser.includes(phrase) || lowerAI.includes(phrase)
  );
}

// Health check
app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    activeConversations: conversations.size,
    ngrokUrl: process.env.NGROK_URL || "Not set"
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✅ Twilio server running on port ${PORT}`);
  console.log(`\n📝 To receive calls:`);
  console.log(`1. Run: ngrok http ${PORT}`);
  console.log(`2. Copy the ngrok URL (e.g., https://abc123.ngrok.io)`);
  console.log(`3. Set it in your Twilio phone number webhook`);
  console.log(`\n📞 Active conversations: ${conversations.size}\n`);
});
