// models.js
// Define todos os Schemas do Mongoose para a aplicação BRAINSKILL.

const mongoose = require('mongoose');

// --- Schema do Usuário (User) ---
// Define a estrutura para os dados de cada jogador/usuário.
const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: [true, 'O nome de usuário é obrigatório.'],
    unique: true, // Garante que cada nome de usuário seja único no banco de dados.
    trim: true, // Remove espaços em branco do início e do fim.
    minlength: [3, 'O nome de usuário deve ter pelo menos 3 caracteres.'],
    maxlength: [20, 'O nome de usuário não pode exceder 20 caracteres.']
  },
  email: {
    type: String,
    required: [true, 'O email é obrigatório.'],
    unique: true, // Garante que cada email seja único.
    trim: true,
    lowercase: true, // Armazena o email em letras minúsculas para consistência.
    match: [/.+\@.+\..+/, 'Por favor, insira um email válido.'] // Validação simples de formato de email.
  },
  password: {
    type: String,
    required: [true, 'A senha é obrigatória.'],
    minlength: [6, 'A senha deve ter pelo menos 6 caracteres.']
  },
  profilePicture: {
    type: String,
    default: 'https://res.cloudinary.com/dje6f5k5u/image/upload/v1677382297/default-avatar_j3h6c6.png' // Uma URL de imagem padrão.
  },
  bio: {
    type: String,
    maxlength: [150, 'A biografia não pode exceder 150 caracteres.'],
    default: ''
  },
  stats: {
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    draws: { type: Number, default: 0 }, // Empates podem ser uma funcionalidade futura.
    rank: { type: Number, default: 1000 } // Um sistema simples de pontuação/ranking.
  },
  role: {
    type: String,
    enum: ['user', 'admin'], // Define os papéis permitidos.
    default: 'user'
  },
  // Campos para a funcionalidade de recuperação de senha.
  resetPasswordToken: String,
  resetPasswordExpires: Date,
}, { timestamps: true }); // Adiciona os campos createdAt e updatedAt automaticamente.

// --- Schema do Jogo (Game) ---
// Armazena o estado e o histórico de cada partida de Damas.
const gameSchema = new mongoose.Schema({
  player1: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  player2: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Pode ser nulo se estiver esperando um oponente.
  boardState: {
    type: [[String]], // Representação do tabuleiro 8x8. Ex: 'b' (peão preto), 'B' (dama preta), 'w', 'W', 'e' (vazio).
    required: true
  },
  currentPlayer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: {
    type: String,
    enum: ['waiting', 'inprogress', 'finished'], // Status possíveis da partida.
    default: 'waiting'
  },
  winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  gameHistory: [{
    move: String, // Ex: "c3-d4"
    player: String, // Username do jogador
    timestamp: { type: Date, default: Date.now }
  }],
  startTime: { type: Date, default: Date.now },
  endTime: { type: Date }
});

// --- Schema da Mensagem de Chat (ChatMessage) ---
// Modela cada mensagem enviada no chat.
const chatMessageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message: {
    type: String,
    trim: true,
    required: function() { return !this.imageUrl; } // Mensagem é obrigatória se não houver imagem.
  },
  imageUrl: {
    type: String, // URL da imagem enviada via Cloudinary.
    default: ''
  }
}, { timestamps: true });

// --- Schema do Anúncio (Ad) ---
// Define a estrutura para os anúncios gerenciados pelo painel de administração.
const adSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['video', 'gif', 'image', 'html'],
    required: true
  },
  contentUrl: { // URL para video, gif ou imagem
    type: String,
    required: function() { return this.type !== 'html'; }
  },
  htmlSnippet: { // Código HTML para anúncios embedados
    type: String,
    required: function() { return this.type === 'html'; }
  },
  linkUrl: { // Link de destino do anúncio
    type: String
  },
  buttonText: String,
  buttonColor: { type: String, default: '#FFFFFF' },
  targetPages: [String], // Array de páginas onde o anúncio deve ser exibido (ex: 'login', 'lobby').
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true } // O ID do admin que criou.
}, { timestamps: true });

// Compila os schemas em modelos e os exporta
const User = mongoose.model('User', userSchema);
const Game = mongoose.model('Game', gameSchema);
const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);
const Ad = mongoose.model('Ad', adSchema);

module.exports = { User, Game, ChatMessage, Ad };