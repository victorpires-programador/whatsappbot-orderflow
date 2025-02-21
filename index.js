const { useMultiFileAuthState, makeWASocket, downloadMediaMessage } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');

let userData = {}; // Armazena os dados dos usuários
let cart = {}; // Carrinho por usuário
let pendingOrders = []; // Lista de pedidos pendentes

// Função para limpar o texto extraído
function normalizeText(text) {
  return text.replace(/\s+/g, ' ').replace(/[\r\n]+/g, ' ').trim();
}

// Função para extrair texto do PDF
async function extractTextFromPdf(buffer) {
  try {
    const data = await pdf(buffer);
    return normalizeText(data.text);
  } catch (error) {
    console.error('Erro ao extrair texto do PDF:', error);
    return null;
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const socket = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('messages.upsert', async ({ messages }) => {
    const message = messages[0];
    if (!message.key.fromMe) {
      const sender = message.key.remoteJid;
      const text = message.message?.conversation?.toLowerCase() || '';

      console.log(`Mensagem recebida de ${sender}: ${text}`);

      let responseText = '';

      // Cadastro do usuário
      if (!userData[sender]) {
        userData[sender] = { step: 'name' };
        responseText = 'Olá! Qual é o seu nome?';
      } else if (userData[sender].step === 'name') {
        userData[sender].name = text;
        userData[sender].step = 'address';
        responseText = 'Qual é o seu endereço?';
      } else if (userData[sender].step === 'address') {
        userData[sender].address = text;
        userData[sender].step = 'phone';
        responseText = 'Por favor, informe seu número de telefone.';
      } else if (userData[sender].step === 'phone') {
        userData[sender].phone = text;
        userData[sender].step = null;
        responseText = 'Cadastro concluído! Digite "catálogo" para ver as opções.';
      }

      // Cancelamento de pedido
      else if (userData[sender]?.step === 'cancel_order') {
        const orderNumber = parseInt(text.trim());

        if (!isNaN(orderNumber)) {
          const userPendingOrders = pendingOrders.filter(order => order.sender === sender && order.status === 'pending');

          if (orderNumber > 0 && orderNumber <= userPendingOrders.length) {
            const orderToCancel = userPendingOrders[orderNumber - 1];
            pendingOrders = pendingOrders.filter(order => order !== orderToCancel);

            responseText = `❌ Pedido número ${orderNumber} cancelado com sucesso.`;
            userData[sender].step = null;
          } else {
            responseText = '⚠️ Número de pedido inválido. Por favor, verifique a lista e tente novamente.';
          }
        } else {
          responseText = '❌ Insira um número válido para cancelar o pedido.';
        }
      }

      // Comandos
      else if (text === 'listar pedidos') {
        if (pendingOrders.length) {
          responseText = '📋 *Pedidos Realizados:*\n\n';
          pendingOrders.forEach((order, index) => {
            const user = userData[order.sender];
            const date = new Date().toLocaleDateString();
            const time = new Date().toLocaleTimeString();
            responseText += `📝 Pedido ${index + 1}:\n`;
            responseText += `👤 Nome: ${user.name}\n`;
            responseText += `🏠 Endereço: ${user.address}\n`;
            responseText += `📞 Telefone: ${user.phone}\n`;
            responseText += `💰 Valor: R$${order.total.toFixed(2)}\n`;
            responseText += `📅 Data: ${date}\n`;
            responseText += `🕒 Hora: ${time}\n`;
            responseText += `📌 Status: ${order.status === 'paid' ? 'Pago ✅' : 'Pendente ⏳'}\n\n`;
          });
        } else {
          responseText = '🚫 Nenhum pedido encontrado.';
        }
      }

      // Exibe o catálogo
      else if (text === 'catálogo') {
        responseText = 'Aqui está o nosso cardápio:\n1. Refeição - R$25,00\n2. Bebida - R$5,00\nDigite o número do item para adicionar ao carrinho.';
      } else if (['1', '2'].includes(text) && userData[sender]?.step !== 'cancel_order') {
        const items = { '1': { item: 'Refeição', price: 25 }, '2': { item: 'Bebida', price: 5 } };
        cart[sender] = cart[sender] || [];
        cart[sender].push(items[text]);
        responseText = `${items[text].item} adicionada ao seu carrinho. Digite "finalizar" para concluir ou "cancelar" para cancelar o pedido.`;
      } else if (text === 'finalizar') {
        if (cart[sender] && cart[sender].length) {
          const total = cart[sender].reduce((sum, item) => sum + item.price, 0);
          pendingOrders.push({ sender, items: cart[sender], total, status: 'pending' });
          responseText = `Total: R$${total.toFixed(2)}. Enviando QR Code para pagamento...`;

          // Simular envio de QR Code
          const qrCodePath = path.join(__dirname, 'img_qrcode', 'QRCodeRestaurante.jpg');
          if (fs.existsSync(qrCodePath)) {
            await socket.sendMessage(sender, {
              image: { url: qrCodePath },
              caption: 'QR Code para pagamento via PIX.',
            });
          }
          cart[sender] = [];
        } else {
          responseText = 'Seu carrinho está vazio. Digite "catálogo" para ver as opções.';
        }
      }

      // Comando para cancelar pedidos
      else if (text === 'cancelar') {
        const userPendingOrders = pendingOrders.filter(order => order.sender === sender && order.status === 'pending');

        if (userPendingOrders.length) {
          responseText = '❌ *Pedidos Pendentes:*\n\n';
          userPendingOrders.forEach((order, index) => {
            responseText += `🔢 Pedido ${index + 1}:\n`;
            responseText += `💰 Valor: R$${order.total.toFixed(2)}\n`;
            responseText += `📌 Status: Pendente ⏳\n\n`;
          });

          responseText += 'Digite o número do pedido que deseja cancelar.';
          userData[sender].step = 'cancel_order';
        } else {
          responseText = '🚫 Você não tem pedidos pendentes para cancelar.';
        }
      }

      // Reconhecimento de comprovante em PDF
      else if (message.message?.documentMessage) {
        try {
          console.log('Recebendo PDF...');
          const buffer = await downloadMediaMessage(message, 'buffer');

          if (!buffer) {
            console.log('Erro ao baixar o PDF.');
            responseText = 'Não consegui baixar o comprovante. Tente novamente.';
          } else {
            const extractedText = await extractTextFromPdf(buffer);

            if (extractedText) {
              console.log('Texto extraído do PDF:\n', extractedText);

              const valueRegex = /(valor|total)\s*[:\-]?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i;
              const match = extractedText.match(valueRegex);

              if (match) {
                const value = parseFloat(match[2].replace(/\./g, '').replace(',', '.'));
                console.log(`Valor extraído: R$${value}`);

                const pendingOrder = pendingOrders.find(order => order.sender === sender && order.status === 'pending');

                if (pendingOrder) {
                  console.log(`Valor esperado: R$${pendingOrder.total}`);

                  if (value === pendingOrder.total) {
                    pendingOrder.status = 'paid';
                    responseText = `✅ Pagamento de R$${value.toFixed(2)} confirmado! Seu pedido está sendo processado.`;
                  } else {
                    responseText = `❌ O valor pago (R$${value.toFixed(2)}) não corresponde ao pedido (R$${pendingOrder.total.toFixed(2)}). Verifique e tente novamente.`;
                  }
                } else {
                  responseText = '⚠️ Nenhum pedido pendente encontrado.';
                }
              } else {
                console.log('Valor não encontrado no texto.');
                responseText = '❌ Não consegui identificar o valor no comprovante. Envie um comprovante válido.';
              }
            } else {
              console.log('Erro ao extrair texto do PDF.');
              responseText = '❌ Erro ao extrair texto do PDF.';
            }
          }
        } catch (error) {
          console.error('Erro ao processar o PDF:', error);
          responseText = '❌ Erro ao processar o comprovante.';
        }
      }

      // Resposta padrão
      else {
        responseText = '🤖 Desculpe, não entendi. Digite "catálogo" para ver os produtos.';
      }

      if (responseText) {
        await socket.sendMessage(sender, { text: responseText });
      }
    }
  });

  console.log('🚀 Bot iniciado! Aguardando mensagens...');
}

startBot().catch((err) => console.error('❌ Erro ao iniciar o bot:', err));
