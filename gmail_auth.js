const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { google } = require("googleapis");

const CREDENTIALS_PATH = path.join(__dirname, "gmail_credentials.json");
const TOKEN_PATH = path.join(__dirname, "gmail_token.json");
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

(async () => {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error("Missing gmail_credentials.json");
    process.exit(1);
  }

  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  const installed = creds.installed || creds.web;
  if (!installed) {
    console.error("Invalid credentials JSON");
    process.exit(1);
  }

  const { client_id, client_secret, redirect_uris } = installed;
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("\nOpen this URL in your browser:\n");
  console.log(authUrl);
  console.log("\nPaste the code here:\n");

  const code = await ask("Code: ");
  const { tokens } = await oAuth2Client.getToken(code.trim());
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log(`\nSaved token to ${TOKEN_PATH}\n`);
})();
