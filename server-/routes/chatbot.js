const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const mongoose = require('mongoose');
const ArtistProfile = require('../models/ArtistProfile');
const Event = require('../models/Event');
const Product = require('../models/Product');
const ChatbotMessage = require('../models/ChatbotMessage');

/**
 * Generates an MP3 audio buffer from text using the Cartesia API.
 * @param {string} text - The transcript to synthesize.
 * @returns {Promise<Buffer>} The MP3 audio buffer.
 */
async function generateSpeech(text) {
  const apiKey = process.env.CARTESIA_API_KEY;
  const voiceId = process.env.CARTESIA_VOICE_ID;

  if (!apiKey) {
    throw new Error("Missing CARTESIA_API_KEY environment variable.");
  }
  if (!voiceId) {
    throw new Error("Missing CARTESIA_VOICE_ID environment variable.");
  }

  const payload = {
    model_id: "sonic-3",
    transcript: text,
    voice: {
      mode: "id",
      id: voiceId
    },
    output_format: {
      container: "mp3",
      sample_rate: 44100,
      bit_rate: 128000
    }
  };

  console.log(`[Cartesia TTS] Synthesizing speech: "${text.substring(0, 60)}..."`);
  
  const response = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Cartesia-Version": "2026-03-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    let errorMessage = `Cartesia API error: ${response.status} ${response.statusText}`;
    try {
      const errorJson = await response.json();
      if (errorJson && errorJson.message) {
        errorMessage = errorJson.message;
      }
    } catch (e) {}
    throw new Error(errorMessage);
  }

  const buffer = await response.buffer();
  return buffer;
}

// POST /api/chatbot/chat - Chat with the AI assistant (supporting voice output & persistent history)
router.post('/chat', async (req, res) => {
  try {
    const { message, sessionId = 'default-session' } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Save user message to persistent DB history
    await ChatbotMessage.create({ sessionId, role: 'user', content: message.trim() });

    // Fetch conversation history from MongoDB (last 15 messages)
    const chatHistory = await ChatbotMessage.find({ sessionId }).sort({ createdAt: 1 }).limit(15);

    // Get system prompt configurations
    const openrouterApiKey = process.env.OPENROUTER_API_KEY;

    if (!openrouterApiKey || openrouterApiKey === 'your-openrouter-api-key-here') {
      return res.status(500).json({
        error: 'OpenRouter API key not configured',
        message: 'Please configure OPENROUTER_API_KEY in server/.env'
      });
    }

    // Define Uday Digital Twin Persona + Platform instructions
    const systemPrompt = `You are Uday, the official AI Digital Twin and voice assistant for the ArtArtist platform.
Your role is to represent the artist's voice while being transparent that you are an AI assistant.
Speak exactly in Uday's communication style:
• Kind
• Respectful
• Calm
• Encouraging
• Patient
• Positive
• Humble

Speaking rules:
- Keep responses friendly, motivating, conversational, and direct.
- Average response length: 25-50 words. Never exceed 60 words.
- Pause and structure sentences naturally.
- Always prioritize database data over assumptions. If information is missing, say:
  "I don't have that information right now. Please check back later."
- Never invent facts. Never claim to have attended events or created artworks unless listed in the database.
- Redirect any off-topic conversations back to art and the ArtArtist platform topics.`;

    // Fetch relevant database data from the platform based on the latest message content
    const lowerMessage = message.toLowerCase();
    let contextData = {
      artists: [],
      events: [],
      artworks: []
    };

    if (lowerMessage.includes('artist') || lowerMessage.includes('artiste') || lowerMessage.includes('profile')) {
      const artists = await ArtistProfile.find({ isActive: true })
        .select('name artForm bio location social')
        .limit(10);
      contextData.artists = artists.map(artist => ({
        name: artist.name,
        artForm: artist.artForm,
        bio: artist.bio,
        location: artist.location
      }));
    }

    if (lowerMessage.includes('event') || lowerMessage.includes('exhibition') || lowerMessage.includes('workshop')) {
      let events = await Event.find({ 
        status: 'published',
        'date.start': { $gte: new Date() }
      })
      .select('title description category date location pricing')
      .sort({ 'date.start': 1 })
      .limit(10);

      if (events.length === 0) {
        events = await Event.find({ status: 'published' })
          .select('title description category date location pricing')
          .sort({ 'date.start': -1 })
          .limit(10);
      }

      contextData.events = events.map(event => ({
        title: event.title,
        description: event.description,
        category: event.category,
        date: event.date,
        location: event.location,
        pricing: event.pricing
      }));
    }

    if (lowerMessage.includes('artwork') || lowerMessage.includes('product') || lowerMessage.includes('painting') || lowerMessage.includes('sculpture') || lowerMessage.includes('buy')) {
      const artworks = await Product.find({ 
        status: 'available',
        isActive: true
      })
      .select('name description category price artistName status')
      .limit(10);

      contextData.artworks = artworks
        .filter(art => art.name && art.name.length > 0 && art.name !== '6/-=9-=809-u7y80t')
        .map(art => ({
          name: art.name,
          description: art.description,
          category: art.category,
          price: art.price,
          artistName: art.artistName
        }));
    }

    // Default general context if no keywords matched
    if (contextData.artists.length === 0 && contextData.events.length === 0 && contextData.artworks.length === 0) {
      const [artists, events, artworks] = await Promise.all([
        ArtistProfile.find({ isActive: true }).select('name artForm bio location').limit(4),
        Event.find({ status: 'published' }).select('title description category date location pricing').sort({ 'date.start': -1 }).limit(4),
        Product.find({ status: 'available', isActive: true }).select('name description category price artistName').limit(4)
      ]);

      contextData = {
        artists: artists.map(a => ({ name: a.name, artForm: a.artForm, bio: a.bio, location: a.location })),
        events: events.map(e => ({ title: e.title, description: e.description, category: e.category, date: e.date, location: e.location, pricing: e.pricing })),
        artworks: artworks
          .filter(art => art.name && art.name.length > 0 && art.name !== '6/-=9-=809-u7y80t')
          .map(art => ({ name: art.name, description: art.description, category: art.category, price: art.price, artistName: art.artistName }))
      };
    }

    // Formulate systemInstruction and contents array for Google Generative AI spec
    const systemPromptCombined = `${systemPrompt}\n\nAvailable platform data: ${JSON.stringify(contextData)}`;
    
    const geminiContents = chatHistory.map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }]
    }));

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return res.status(500).json({
        error: 'Gemini API key not configured',
        message: 'Please configure GEMINI_API_KEY in server/.env'
      });
    }

    console.log(`[Chatbot] Sending query to Google Gemini API (gemini-flash-latest)...`);
    
    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${geminiApiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': geminiApiKey
      },
      body: JSON.stringify({
        contents: geminiContents,
        systemInstruction: {
          parts: [{ text: systemPromptCombined }]
        },
        generationConfig: {
          maxOutputTokens: 800,
          temperature: 0.7
        }
      })
    });

    const geminiData = await geminiResponse.json();

    if (!geminiResponse.ok) {
      throw new Error((geminiData.error && geminiData.error.message) || 'Google Gemini API failed.');
    }

    if (!geminiData.candidates || !geminiData.candidates[0] || !geminiData.candidates[0].content || !geminiData.candidates[0].content.parts || !geminiData.candidates[0].content.parts[0].text) {
      throw new Error('Unexpected response format from Google Gemini API');
    }

    const botText = geminiData.candidates[0].content.parts[0].text.trim();
    console.log(`[Chatbot] LLM Response: "${botText}"`);

    // Save assistant reply to DB history
    await ChatbotMessage.create({ sessionId, role: 'assistant', content: botText });

    // Synthesize response to voice if CARTESIA_API_KEY is configured
    if (process.env.CARTESIA_API_KEY) {
      try {
        const audioBuffer = await generateSpeech(botText);
        const base64Audio = audioBuffer.toString('base64');
        return res.json({
          success: true,
          response: botText,
          reply: botText,
          text: botText,
          audioUrl: `data:audio/mp3;base64,${base64Audio}`
        });
      } catch (ttsErr) {
        console.error("[Chatbot TTS Error] Voice synthesis failed:", ttsErr.message);
        // Fallback to text only if TTS fails
        return res.json({
          success: true,
          response: botText,
          reply: botText,
          text: botText,
          audioUrl: null
        });
      }
    }

    // No Cartesia API key, return text only
    return res.json({
      success: true,
      response: botText,
      reply: botText,
      text: botText,
      audioUrl: null
    });

  } catch (error) {
    console.error('Chatbot route error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/chatbot/history - Retrieve conversation log
router.get('/history', async (req, res) => {
  try {
    const { sessionId = 'default-session' } = req.query;
    const history = await ChatbotMessage.find({ sessionId }).sort({ createdAt: 1 }).limit(50);
    res.json({ history });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch chat history", details: error.message });
  }
});

// POST /api/chatbot/clear - Reset conversation memory
router.post('/clear', async (req, res) => {
  try {
    const { sessionId = 'default-session' } = req.body;
    await ChatbotMessage.deleteMany({ sessionId });
    res.json({ success: true, message: "Chat history cleared successfully." });
  } catch (error) {
    res.status(500).json({ error: "Failed to clear chat history", details: error.message });
  }
});

// GET /api/chatbot/health - Check configurations
router.get('/health', (req, res) => {
  const hasCartesia = !!process.env.CARTESIA_API_KEY;
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
  res.json({
    configured: hasCartesia && hasOpenRouter,
    hasCartesia,
    hasOpenRouter,
    message: 'Chatbot service status check'
  });
});

module.exports = router;
