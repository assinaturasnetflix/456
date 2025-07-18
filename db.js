// db.js
// Módulo para configurar e conectar ao banco de dados MongoDB usando Mongoose.

const mongoose = require('mongoose');
require('dotenv').config(); // Carrega as variáveis de ambiente do arquivo .env

/**
 * Função assíncrona para conectar ao MongoDB.
 * Utiliza a string de conexão (MONGO_URI) definida no arquivo .env.
 * A função inclui tratamento de erros para capturar e exibir falhas na conexão.
 */
const connectDB = async () => {
  try {
    // Tenta conectar ao MongoDB com a URI fornecida e opções recomendadas
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true, // Usa o novo parser de URL do driver do MongoDB
      useUnifiedTopology: true, // Usa o novo mecanismo de descoberta e monitoramento de servidor
    });
    console.log('Conexão com o MongoDB estabelecida com sucesso.');
  } catch (error) {
    // Em caso de erro na conexão, exibe a mensagem de erro e encerra o processo do servidor
    console.error('Falha ao conectar com o MongoDB:', error.message);
    process.exit(1); // Encerra a aplicação com um código de falha
  }
};

// Exporta a função de conexão para que ela possa ser chamada em outros arquivos (como o server.js)
module.exports = connectDB;