// models.js
// Define todos os Schemas do Mongoose para a aplicação BRAINSKILL.

const mongoose = require('mongoose');

// --- Schema do Usuário (User) ---
const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: [true, 'O nome de usuário é obrigatório.'],
    unique: true,
    trim: true,
    minlength: [3, 'O nome de usuário deve ter pelo menos 3 caracteres.'],
    maxlength: [20, 'O nome de usuário não pode exceder 20 caracteres.']
  },
  email: {
    type: String,
    required: [true, 'O email é obrigatório.'],
    unique: true,
    trim: true,
    lowercase: true,
    match: [/.+\@.+\..+/, 'Por favor, insira um email válido.']
  },
  password: {
    type: String,
    required: [true, 'A senha é obrigatória.'],
    minlength: [6, 'A senha deve ter pelo menos 6 caracteres.']
  },
  profilePicture: {
    type: String,
    default: 'https://res.cloudinary.com/dje6f5k5u/image/upload/v1677382297/default-avatar_j3h6c6.png'
  },
  bio: {
    type: String,
    maxlength: [150, 'A biografia não pode exceder 150 caracteres.'],
    default: ''
  },
  stats: {
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    draws: { type: Number, default: 0 },
    rank: { type: Number, default: 1000 }
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  },
  resetPasswordToken: String,
  resetPasswordExpires: Date,
}, { timestamps: true });

// --- Schema do Jogo (Game) ---
const gameSchema = new mongoose.Schema({
  player1: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  player2: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  boardState: {
    type: [[String]],
    required: true
  },
  currentPlayer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: {
    type: String,
    // Status expandidos para o novo fluxo de jogo
    enum: [
        'waiting',    // Aguardando um oponente no lobby
        'readying',   // Ambos os jogadores na sala, aguardando confirmação de "pronto"
        'inprogress', // Partida em andamento
        'finished',   // Partida concluída normalmente
        'cancelled',  // Cancelada pelo criador ou por tempo esgotado no lobby
        'abandoned'   // Um dos jogadores desconectou e não retornou a tempo
    ],
    default: 'waiting'
  },
  winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  gameHistory: [{
    move: String,
    player: String,
    timestamp: { type: Date, default: Date.now }
  }],
  startTime: { type: Date, default: Date.now },
  endTime: { type: Date }
});

// --- Schema da Mensagem de Chat (ChatMessage) ---
const chatMessageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message: {
    type: String,
    trim: true,
    required: function() { return !this.imageUrl; }
  },
  imageUrl: {
    type: String,
    default: ''
  }
}, { timestamps: true });

// --- Schema do Anúncio (Ad) ---
const adSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['video', 'gif', 'image', 'html'],
    required: true
  },
  contentUrl: {
    type: String,
    required: function() { return this.type !== 'html'; }
  },
  htmlSnippet: {
    type: String,
    required: function() { return this.type === 'html'; }
  },
  linkUrl: String,
  buttonText: String,
  buttonColor: { type: String, default: '#FFFFFF' },
  targetPages: [String],
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

// Compila os schemas em modelos e os exporta
const User = mongoose.model('User', userSchema);
const Game = mongoose.model('Game', gameSchema);
const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);
const Ad = mongoose.model('Ad', adSchema);

module.exports = { User, Game, ChatMessage, Ad };