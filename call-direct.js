require("dotenv").config();
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

// Make a call with TwiML bin - no server needed!
async function makeDirectCall(phoneNumber, initialMessage) {
  try {
    // Create TwiML for the call
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${initialMessage || "Hi, this is Kiki, an AI assistant. How can I help you today?"}</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna">This is a test call. The system is working but needs a server for full conversation. Goodbye!</Say>
  <Hangup/>
</Response>`;
    
    // Make the call with TwiML
    const call = await client.calls.create({
      twiml: twiml,
      to: phoneNumber,
      from: process.env.TWILIO_PHONE_NUMBER,
    });
    
    console.log(`Call initiated: ${call.sid}`);
    return `✅ Calling ${phoneNumber}... Call SID: ${call.sid}`;
  } catch (error) {
    return `❌ Error: ${error.message}`;
  }
}

// Export for use in main bot
module.exports = { makeDirectCall };
