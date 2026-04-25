const OpenAI = require('openai');
const { log } = require('../utils/logger');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SYSTEM_PROMPT = `You are a helpful and caring AI assistant specialized in pregnancy and maternal health. 
You provide supportive, informative, and empathetic responses to pregnant mothers. 
Always be encouraging and positive while providing accurate information.
If a question seems urgent or medical in nature, remind them to consult with their healthcare provider.
Keep responses concise and easy to understand, suitable for WhatsApp messages.`;

async function getGPTResponse(userMessage, userName = 'Mother') {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage }
      ],
      max_tokens: 500,
      temperature: 0.7,
    });

    return completion.choices[0].message.content;
  } catch (error) {
    log.error('OpenAI API error', error);
    return "I'm sorry, I'm having trouble processing your message right now. Please try again later or contact your healthcare provider if this is urgent.";
  }
}

module.exports = { getGPTResponse };