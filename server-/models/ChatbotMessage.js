const mongoose = require('mongoose');

const ChatbotMessageSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, index: true },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ChatbotMessage', ChatbotMessageSchema);
