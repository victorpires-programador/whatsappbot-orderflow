const { useMultiFileAuthState, makeWASocket, downloadMediaMessage } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const Tesseract = require('tesseract.js'); // Para OCR em imagens
const { Client } = require('pg');

// ------------------------------------------
// Configuração do banco de dados
// ------------------------------------------
const dbClient = new Client({
  user: 'postgres',
  host: 'localhost',
  database: 'dbOrderFlow',
  password: 'admin',
  port: 5432,
});

dbClient.connect()
  .then(() => console.log('Conectado ao banco de dados!'))
  .catch(err => console.error('Erro ao conectar ao banco de dados:', err));

// ------------------------------------------
// Variáveis globais
// ------------------------------------------
let userData = {};         // Armazena dados temporários dos usuários (CPF, etapa do cadastro)
let cart = {};             // Armazena os itens do carrinho por usuário
let attendantMode = {};    // Controla quem está em atendimento humano

// ------------------------------------------
// Funções de auxílio
// ------------------------------------------

// Normaliza texto (remove espaços e quebras extras)
function normalizeText(text) {
  return text.replace(/\s+/g, ' ').replace(/[\r\n]+/g, ' ').trim();
}

// Remove acentos
function removeAcentos(text) {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Gera o menu principal de comandos
function getMainMenu() {
  return `
*Menu de Comandos*:
1️⃣ *catálogo* - Ver produtos disponíveis
2️⃣ *orcamento* - Ver o total dos itens do carrinho (sem pagar)
3️⃣ *listar pedidos* - Ver todos os seus pedidos
4️⃣ *pagar <número>* - Pagar um pedido pendente (ex: pagar 1)
5️⃣ *cancelar* - Cancelar um pedido pendente
6️⃣ *cancelar orçamento* - Limpar seu carrinho
7️⃣ *finalizar* - Concluir o pedido e gerar QR Code para pagamento
8️⃣ *falar com atendente* - Entrar em atendimento humano
`;
}

// Formata o telefone para o padrão WhatsApp <numero>@s.whatsapp.net
function formatarTelefone(telefone) {
  let soNumeros = telefone.replace(/[^\d]/g, '');
  // Se não começar com 55 e tiver pelo menos 10 dígitos, adiciona 55
  if (!soNumeros.startsWith('55') && soNumeros.length >= 10) {
    soNumeros = '55' + soNumeros;
  }
  return soNumeros + '@s.whatsapp.net';
}

// Envia broadcast para todos os clientes cadastrados
async function broadcastMessage(socket, texto) {
  try {
    const result = await dbClient.query('SELECT telefone FROM clientes');
    if (result.rows.length === 0) {
      console.log('Nenhum telefone encontrado no banco de dados para broadcast.');
      return;
    }
    console.log(`Iniciando broadcast para ${result.rows.length} clientes...`);

    for (const row of result.rows) {
      const telefoneFormatado = formatarTelefone(row.telefone);
      try {
        await socket.sendMessage(telefoneFormatado, { text: texto });
        console.log(`Mensagem enviada para: ${telefoneFormatado}`);
      } catch (err) {
        console.error(`Erro ao enviar mensagem para ${telefoneFormatado}:`, err);
      }
    }
    console.log('Broadcast concluído.');
  } catch (err) {
    console.error('Erro ao executar broadcastMessage:', err);
  }
}

// Extrai texto de imagem via OCR
async function extractTextFromImage(buffer) {
  try {
    const { data: { text } } = await Tesseract.recognize(buffer, 'por', {
      tessedit_char_whitelist: '0123456789.,R$áàâãéèêíïóôõöúçÁÀÂÃÉÈÊÍÏÓÔÕÖÚÇ ',
      psm: 6,
      logger: m => console.log(m)
    });
    return normalizeText(removeAcentos(text));
  } catch (error) {
    console.error('Erro ao extrair texto da imagem:', error);
    return null;
  }
}

// Extrai texto de PDF
async function extractTextFromPdf(buffer) {
  try {
    const data = await pdf(buffer);
    return normalizeText(data.text);
  } catch (error) {
    console.error('Erro ao extrair texto do PDF:', error);
    return null;
  }
}

// Valida CPF
function validarCPF(cpf) {
  cpf = cpf.replace(/[^\d]+/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;

  let soma = 0;
  let resto;
  for (let i = 1; i <= 9; i++) {
    soma += parseInt(cpf.charAt(i - 1)) * (11 - i);
  }
  resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  if (resto !== parseInt(cpf.charAt(9))) return false;

  soma = 0;
  for (let i = 1; i <= 10; i++) {
    soma += parseInt(cpf.charAt(i - 1)) * (12 - i);
  }
  resto = (soma * 10) % 11;
  return resto === parseInt(cpf.charAt(10));
}

// Descrição do status do pedido
function getStatusDescription(status) {
  const statusMap = {
    'pendente': '⏳ Pendente',
    'pago': '✅ Pago',
    'cancelado': '❌ Cancelado'
  };
  return statusMap[status] || '🔍 Status desconhecido';
}

// Lista pedidos de um CPF
async function listarPedidos(cpf) {
  try {
    const query = `
      SELECT pedidos.id, pedidos.total, pedidos.status, pedidos.data_criacao
      FROM pedidos
      INNER JOIN clientes ON pedidos.id_cliente = clientes.id
      WHERE clientes.cpf = $1
      ORDER BY pedidos.data_criacao DESC
    `;
    const res = await dbClient.query(query, [cpf]);
    if (res.rows.length === 0) {
      return '🚫 Nenhum pedido encontrado.';
    }
    
    let responseText = '📝 *Seus Pedidos:*\n\n';
    res.rows.forEach((order, index) => {
      responseText += `🔢 Pedido ${index + 1}:\n`;
      responseText += `💰 Valor: R$${parseFloat(order.total).toFixed(2)}\n`;
      responseText += `📌 Status: ${getStatusDescription(order.status)}\n`;
      if (order.data_criacao) {
        responseText += `🗓️ Data: ${new Date(order.data_criacao).toLocaleString()}\n`;
      }
      responseText += '\n';
    });
    
    responseText += 'Para pagar um pedido pendente, digite "pagar <número do pedido>" (ex: pagar 1).';
    return responseText;
  } catch (err) {
    console.error('Erro ao listar pedidos:', err);
    return '❌ Erro ao listar pedidos. Tente novamente.';
  }
}

// ------------------------------------------
// Inicia o bot
// ------------------------------------------
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const socket = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  socket.ev.on('creds.update', saveCreds);

  // Quando a conexão for estabelecida, enviamos a mensagem para todos os clientes
  socket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      console.log('Bot conectado com sucesso! Enviando broadcast...');
      // Aqui enviamos a mensagem "Estamos abertos" para todos no banco
      await broadcastMessage(socket, '🌟 Olá! Estamos abertos e prontos para atendê-lo.  Digite um "oi" para começar o atendimento!');
    } else if (connection === 'close') {
      console.log('Conexão fechada:', lastDisconnect?.error);
    }
  });

  // Processamento das mensagens recebidas
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const message = messages[0];
    if (!message || !message.message || message.key.fromMe) return;

    const sender = message.key.remoteJid;
    const text = (message.message?.conversation || message.message?.extendedTextMessage?.text || '').trim();
    console.log(`Mensagem recebida de ${sender}: ${text}`);

    // Se o usuário estiver em atendimento humano
    if (attendantMode[sender]) {
      const lowerText = text.toLowerCase();
      // Comando para finalizar atendimento
      if (lowerText === 'finalizar atendimento') {
        attendantMode[sender] = false;
        await socket.sendMessage(sender, { text: '✅ Atendimento finalizado. O bot foi reativado.\n' + getMainMenu() });
      } else {
        // Modo humano: não respondemos, apenas logamos
        console.log(`[ATENDIMENTO HUMANO - ${sender}]: ${text}`);
      }
      return;
    }

    let responseText = '';

    // -------------------------------------------
    // Verifica se é um comprovante (PDF/imagem)
    // -------------------------------------------
    if (message.message?.documentMessage || message.message?.imageMessage) {
      try {
        console.log('Recebendo comprovante...');
        const buffer = await downloadMediaMessage(message, 'buffer');
        if (!buffer) {
          console.log('Erro ao baixar o comprovante.');
          responseText = 'Não consegui baixar o comprovante. Tente novamente.';
        } else {
          let extractedText = null;
          if (message.message?.documentMessage) {
            const mimeType = message.message.documentMessage.mimetype;
            if (mimeType && mimeType.includes('pdf')) {
              extractedText = await extractTextFromPdf(buffer);
            } else {
              extractedText = await extractTextFromImage(buffer);
            }
          } else if (message.message?.imageMessage) {
            extractedText = await extractTextFromImage(buffer);
          }

          if (extractedText) {
            console.log('Texto extraído:\n', extractedText);
            const valueRegex = /(valor|total)\s*[:\-]?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i;
            const pixKeyRegex = /(?:chave\s*pix|chave)\s*[:\-]?\s*([a-zA-Z0-9._%+-]+[@&][a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
            const transacaoRegex = /(?:id\s*da\s*transa[çc][aã]o|numero\s*de\s*controle|controle)\s*[:\-]?\s*([\w\-]+)/i;

            const valueMatch = extractedText.match(valueRegex);
            const pixKeyMatch = extractedText.match(pixKeyRegex);
            const transacaoMatch = extractedText.match(transacaoRegex);

            if (valueMatch && pixKeyMatch && transacaoMatch) {
              const value = parseFloat(valueMatch[2].replace(/\./g, '').replace(',', '.'));
              let email = pixKeyMatch[1].replace(/&/g, '@');
              const transacaoId = transacaoMatch[1].trim();

              console.log(`Valor extraído: R$${value}`);
              console.log(`Chave PIX extraída: ${email}`);
              console.log(`ID da transação extraída: ${transacaoId}`);

              const pixKeyEmail = 'contato.vtml@outlook.com';
              if (email !== pixKeyEmail) {
                responseText = `❌ O e-mail do comprovante (${email}) não corresponde à chave PIX esperada (${pixKeyEmail}).`;
              } else {
                // Verifica se já existe esse transacao_id
                const transQuery = 'SELECT id FROM pedidos WHERE transacao_id = $1';
                const transRes = await dbClient.query(transQuery, [transacaoId]);
                if (transRes.rows.length > 0) {
                  responseText = '❌ Este comprovante já foi utilizado para pagamento.';
                } else {
                  // Busca pedido pendente do usuário
                  const query = `
                    SELECT pedidos.id, pedidos.total
                    FROM pedidos
                    INNER JOIN clientes ON pedidos.id_cliente = clientes.id
                    WHERE clientes.cpf = $1 AND pedidos.status = 'pendente'
                  `;
                  const res = await dbClient.query(query, [userData[sender].cpf]);
                  if (res.rows.length > 0) {
                    const pendingOrder = res.rows[0];
                    console.log(`Valor esperado: R$${pendingOrder.total}`);
                    if (value === parseFloat(pendingOrder.total)) {
                      const updateQuery = 'UPDATE pedidos SET status = $1, transacao_id = $2 WHERE id = $3';
                      await dbClient.query(updateQuery, ['pago', transacaoId, pendingOrder.id]);
                      responseText = `✅ Pagamento de R$${value.toFixed(2)} confirmado! Seu pedido está sendo processado.`;
                    } else {
                      responseText = `❌ O valor pago (R$${value.toFixed(2)}) não corresponde ao pedido (R$${parseFloat(pendingOrder.total).toFixed(2)}). Verifique e tente novamente.`;
                    }
                  } else {
                    responseText = '⚠️ Nenhum pedido pendente encontrado.';
                  }
                }
              }
            } else {
              console.log('Valor, chave PIX ou ID da transação não encontrados no comprovante.');
              responseText = '❌ Não consegui identificar o valor, a chave PIX ou o ID da transação no comprovante. Envie um comprovante válido.';
            }
          } else {
            console.log('Erro ao extrair texto do comprovante.');
            responseText = '❌ Erro ao extrair texto do comprovante.';
          }
        }
      } catch (error) {
        console.error('Erro ao processar o comprovante:', error);
        responseText = '❌ Erro ao processar o comprovante.';
      }
    }
    // ------------------------------------------------
    // Fluxo de cadastro: CPF, nome, telefone, endereço
    // ------------------------------------------------
    else if (userData[sender]?.step === 'cpf') {
      const cpf = text.replace(/[^\d]+/g, '');
      if (validarCPF(cpf)) {
        try {
          const checkQuery = 'SELECT id FROM clientes WHERE cpf = $1';
          const checkResult = await dbClient.query(checkQuery, [cpf]);
          if (checkResult.rows.length === 0) {
            userData[sender] = { cpf, step: 'nome' };
            responseText = '📝 Por favor, informe seu *nome completo*:';
          } else {
            userData[sender] = { cpf, step: null };
            responseText = '✅ Bem-vindo de volta! Aqui estão os comandos disponíveis:\n' + getMainMenu();
          }
        } catch (err) {
          console.error('Erro na verificação:', err);
          responseText = '❌ Erro ao processar CPF. Tente novamente.';
          delete userData[sender];
        }
      } else {
        responseText = 'CPF inválido. Por favor, insira um CPF válido:';
      }
    }
    else if (userData[sender]?.step === 'nome') {
      userData[sender].nome = text;
      userData[sender].step = 'telefone';
      responseText = '📱 Agora informe seu *telefone com DDD*:';
    }
    else if (userData[sender]?.step === 'telefone') {
      userData[sender].telefone = text;
      userData[sender].step = 'endereco';
      responseText = '🏠 Por último, informe seu *endereço completo*:';
    }
    else if (userData[sender]?.step === 'endereco') {
      userData[sender].endereco = text;
      try {
        const insertQuery = `
          INSERT INTO clientes (cpf, nome, telefone, endereco)
          VALUES ($1, $2, $3, $4)
        `;
        await dbClient.query(insertQuery, [
          userData[sender].cpf,
          userData[sender].nome,
          userData[sender].telefone,
          userData[sender].endereco
        ]);
        userData[sender].step = null;
        responseText = '✅ Cadastro completo! Agora você pode usar os comandos abaixo:\n' + getMainMenu();
      } catch (err) {
        console.error('Erro no cadastro:', err);
        responseText = '❌ Erro ao salvar dados. Tente novamente.';
        delete userData[sender];
      }
    }
    // ------------------------------------------------
    // Se o usuário não estiver cadastrado, inicia o fluxo solicitando CPF
    // ------------------------------------------------
    else if (!userData[sender]) {
      userData[sender] = { step: 'cpf' };
      responseText = 'Olá! Por favor, informe seu CPF:';
    }
    // ------------------------------------------------
    // Processamento dos comandos pós-cadastro
    // ------------------------------------------------
    else {
      const lowerText = text.toLowerCase();

      // Modo atendente
      if (lowerText === 'falar com atendente') {
        attendantMode[sender] = true;
        responseText = '🔔 Você será atendido por um atendente agora.\nPara voltar ao bot, digite "finalizar atendimento".';
      }
      else if (lowerText === 'cancelar orçamento' || lowerText === 'cancelar orcamento') {
        cart[sender] = [];
        responseText = '🗑️ Orçamento cancelado e carrinho limpo.';
      }
      else if (lowerText === 'listar pedidos') {
        responseText = await listarPedidos(userData[sender].cpf);
      }
      else if (lowerText.startsWith('pagar')) {
        const parts = lowerText.split(" ");
        if (parts.length >= 2) {
          const orderNum = parseInt(parts[1]);
          if (!isNaN(orderNum)) {
            try {
              const query = `
                SELECT pedidos.id, pedidos.total
                FROM pedidos
                INNER JOIN clientes ON pedidos.id_cliente = clientes.id
                WHERE clientes.cpf = $1 AND pedidos.status = 'pendente'
              `;
              const resQuery = await dbClient.query(query, [userData[sender].cpf]);
              if (resQuery.rows.length > 0 && orderNum >= 1 && orderNum <= resQuery.rows.length) {
                const pendingOrder = resQuery.rows[orderNum - 1];
                responseText = `🔢 Pedido ${orderNum} selecionado\n💰 Valor: R$${parseFloat(pendingOrder.total).toFixed(2)}\n\nEnviando QR Code...`;
                const qrCodePath = path.join(__dirname, 'img_qrcode', 'QRCodeRestaurante.jpg');
                if (fs.existsSync(qrCodePath)) {
                  await socket.sendMessage(sender, {
                    image: { url: qrCodePath },
                    caption: 'QR Code para pagamento via PIX.'
                  });
                }
              } else {
                responseText = "Número de pedido inválido ou nenhum pedido pendente encontrado.";
              }
            } catch (err) {
              console.error('Erro ao processar o pagamento do pedido:', err);
              responseText = '❌ Erro ao processar o pagamento do pedido. Tente novamente.';
            }
          } else {
            responseText = 'Por favor, informe o número do pedido para pagar. Ex: pagar 1';
          }
        } else {
          responseText = 'Por favor, informe o número do pedido para pagar. Ex: pagar 1';
        }
      }
      else if (userData[sender]?.step === 'cancel_order') {
        const orderNumber = parseInt(text);
        try {
          const query = `
            SELECT pedidos.id, pedidos.total, pedidos.status
            FROM pedidos
            INNER JOIN clientes ON pedidos.id_cliente = clientes.id
            WHERE clientes.cpf = $1 AND pedidos.status = 'pendente'
          `;
          const resQuery = await dbClient.query(query, [userData[sender].cpf]);
          if (resQuery.rows.length === 0) {
            responseText = '🚫 Nenhum pedido pendente encontrado para cancelar.';
          } else if (!isNaN(orderNumber) && orderNumber >= 1 && orderNumber <= resQuery.rows.length) {
            const orderToCancel = resQuery.rows[orderNumber - 1];
            const updateQuery = 'UPDATE pedidos SET status = $1 WHERE id = $2';
            await dbClient.query(updateQuery, ['cancelado', orderToCancel.id]);
            responseText = `✅ Pedido ${orderNumber} cancelado com sucesso.`;
          } else {
            responseText = '⚠️ Número de pedido inválido. Por favor, verifique e tente novamente.';
          }
        } catch (err) {
          console.error('Erro ao cancelar pedido:', err);
          responseText = '❌ Erro ao cancelar o pedido. Tente novamente.';
        }
        userData[sender].step = null;
      }
      else if (lowerText === 'catálogo' || lowerText === 'catalogo') {
        try {
          const query = 'SELECT nome, preco FROM produtos';
          const resQuery = await dbClient.query(query);
          if (resQuery.rows.length > 0) {
            responseText = '🍽️ *Catálogo de Produtos:*\n\n';
            resQuery.rows.forEach((produto, index) => {
              const preco = parseFloat(produto.preco);
              responseText += `${index + 1}. ${produto.nome} - R$${preco.toFixed(2)}\n`;
            });
            responseText += '\nDigite o número do item para adicionar ao carrinho.';
          } else {
            responseText = '🚫 Nenhum produto encontrado no catálogo.';
          }
        } catch (err) {
          console.error('Erro ao consultar produtos:', err);
          responseText = '❌ Erro ao carregar o catálogo. Tente novamente.';
        }
      }
      else if (!isNaN(text) && userData[sender]?.step !== 'cancel_order') {
        try {
          const query = 'SELECT id, nome, preco FROM produtos';
          const resQuery = await dbClient.query(query);
          if (resQuery.rows.length > 0) {
            const selectedIndex = parseInt(text) - 1;
            if (selectedIndex >= 0 && selectedIndex < resQuery.rows.length) {
              const selectedProduct = resQuery.rows[selectedIndex];
              cart[sender] = cart[sender] || [];
              cart[sender].push({
                item: selectedProduct.nome,
                price: parseFloat(selectedProduct.preco),
              });
              responseText = `🛒 *${selectedProduct.nome}* adicionado ao seu carrinho.\n\nDigite "finalizar" para concluir, "orcamento" para ver o total, "cancelar orçamento" para limpar seu carrinho ou "pagar <número>" para pagar um pedido pendente.`;
            } else {
              responseText = '⚠️ Número de produto inválido. Por favor, verifique o catálogo e tente novamente.';
            }
          } else {
            responseText = '🚫 Nenhum produto encontrado no catálogo.';
          }
        } catch (err) {
          console.error('Erro ao consultar produtos:', err);
          responseText = '❌ Erro ao adicionar item ao carrinho. Tente novamente.';
        }
      }
      else if (lowerText === 'orcamento' || lowerText === 'orçamento') {
        if (cart[sender] && cart[sender].length > 0) {
          const total = cart[sender].reduce((sum, item) => sum + item.price, 0);
          responseText = '📋 *Seu Orçamento:*\n\n';
          cart[sender].forEach((item, index) => {
            responseText += `${index + 1}. ${item.item} - R$${parseFloat(item.price).toFixed(2)}\n`;
          });
          responseText += `\nTotal: R$${total.toFixed(2)}`;
        } else {
          responseText = 'Seu carrinho está vazio. Adicione itens para gerar um orçamento.';
        }
      }
      else if (lowerText === 'finalizar') {
        if (cart[sender] && cart[sender].length) {
          const total = cart[sender].reduce((sum, item) => sum + item.price, 0);
          try {
            const clientQuery = 'SELECT id FROM clientes WHERE cpf = $1';
            const clientRes = await dbClient.query(clientQuery, [userData[sender].cpf]);
            const idCliente = clientRes.rows[0].id;
            const orderQuery = 'INSERT INTO pedidos (id_cliente, total, status) VALUES ($1, $2, $3) RETURNING id';
            const orderValues = [idCliente, total, 'pendente'];
            const orderRes = await dbClient.query(orderQuery, orderValues);
            console.log(`Pedido cadastrado com ID: ${orderRes.rows[0].id}`);
            responseText = `🧾 *Pedido cadastrado!* Total: R$${parseFloat(total).toFixed(2)}\nChave pix: contato.vtml@outlook.com`;
            const qrCodePath = path.join(__dirname, 'img_qrcode', 'QRCodeRestaurante.jpg');
            if (fs.existsSync(qrCodePath)) {
              await socket.sendMessage(sender, {
                image: { url: qrCodePath },
                caption: 'QR Code para pagamento via PIX.',
              });
            }
            cart[sender] = [];
          } catch (err) {
            console.error('Erro ao cadastrar pedido:', err);
            responseText = '❌ Erro ao finalizar o pedido. Tente novamente.';
          }
        } else {
          responseText = 'Seu carrinho está vazio. Digite "catálogo" para ver as opções.';
        }
      }
      else if (lowerText === 'cancelar') {
        try {
          const query = `
            SELECT pedidos.id, pedidos.total, pedidos.status
            FROM pedidos
            INNER JOIN clientes ON pedidos.id_cliente = clientes.id
            WHERE clientes.cpf = $1 AND pedidos.status = 'pendente'
          `;
          const resQuery = await dbClient.query(query, [userData[sender].cpf]);
          if (resQuery.rows.length > 0) {
            responseText = '❌ *Pedidos Pendentes:*\n\n';
            resQuery.rows.forEach((order, index) => {
              responseText += `🔢 Pedido ${index + 1}:\n`;
              responseText += `💰 Valor: R$${parseFloat(order.total).toFixed(2)}\n`;
              responseText += `📌 Status: Pendente ⏳\n\n`;
            });
            responseText += 'Digite o número do pedido que deseja cancelar.';
            userData[sender].step = 'cancel_order';
          } else {
            responseText = '🚫 Você não tem pedidos pendentes para cancelar.';
          }
        } catch (err) {
          console.error('Erro ao listar pedidos pendentes:', err);
          responseText = '❌ Erro ao listar pedidos pendentes. Tente novamente.';
        }
      }
      else {
        responseText = '🤖 Comando não reconhecido. Use um dos comandos abaixo:\n' + getMainMenu();
      }
    }

    // Envia a resposta ao usuário, se houver
    if (responseText) {
      await socket.sendMessage(sender, { text: responseText });
    }
  });

  console.log('🚀 Bot iniciado! Aguardando mensagens...');
}

startBot().catch((err) => console.error('❌ Erro ao iniciar o bot:', err));
