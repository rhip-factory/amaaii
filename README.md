# WhatsApp Pregnancy Bot

A WhatsApp bot that provides AI-powered support and information for pregnant mothers using OpenAI GPT and Twilio.

## Setup Instructions

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Update the `.env` file with your Twilio credentials:
- `TWILIO_ACCOUNT_SID`: Your Twilio Account SID
- `TWILIO_AUTH_TOKEN`: Your Twilio Auth Token
- `TWILIO_WHATSAPP_NUMBER`: Your Twilio WhatsApp sandbox number (usually whatsapp:+14155238886)

### 3. Start the Server
```bash
npm start
```
Or for development with auto-restart:
```bash
npm run dev
```

### 4. Expose Server to Internet (for local testing)
Install ngrok globally:
```bash
npm install -g ngrok
```

Run ngrok to expose your local server:
```bash
ngrok http 3000
```

### 5. Configure Twilio Webhook
1. Copy the HTTPS URL from ngrok (e.g., `https://abc123.ngrok.io`)
2. Go to Twilio Console > Messaging > Try it out > Send a WhatsApp message
3. In the Sandbox settings, set the webhook URL to: `https://your-ngrok-url.ngrok.io/webhook`
4. Make sure the method is set to `POST`

### 6. Test the Bot
1. Send "join [your-sandbox-keyword]" to the Twilio WhatsApp number from your phone
2. Once joined, send any message to start chatting with the bot
3. Type "help" to see available options

## Features
- AI-powered responses using OpenAI GPT
- Pregnancy-specific knowledge and support
- Warm, empathetic communication
- Safety reminders for medical concerns
- Easy-to-use WhatsApp interface

## Test Phone Number
The configured test number is: +254797437715

## Important Notes
- This is a demo/development setup using Twilio's WhatsApp Sandbox
- For production, you'll need WhatsApp Business API approval
- Always ensure sensitive medical advice includes disclaimers
- The bot reminds users to consult healthcare providers for urgent concerns