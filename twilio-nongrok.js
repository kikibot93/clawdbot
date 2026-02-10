require("dotenv").config();
const express = require("express");
const { VoiceResponse } = require("twilio").twiml;
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.urlencoded({ extended: true }));

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

// Use TwiML Bin approach - no server needed!
app.post("/call-now", async (req, res) => {
  const { phoneNumber, message } = req.body;
  
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="2"/>
  <Say voice="Polly.Joanna">Hello?</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna">${message || "This is Kiki, an AI assistant. I'm calling to test the system."}</Say>
  <Pause length="3"/>
  <Say voice="Polly.Joanna">Since this is a test without a full server, I'll say goodbye now. Goodbye!</Say>
  <Hangup/>
</Response>`;
  
  try {
    const twilio = require("twilio");
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
    const call = await client.calls.create({
      twiml: twiml,
      to: phoneNumber,
      from: process.env.TWILIO_PHONE_NUMBER,
    });
    
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

const PORT = 3002;
app.listen(PORT, () => {
  console.log(`Direct call server on port ${PORT}`);
});
