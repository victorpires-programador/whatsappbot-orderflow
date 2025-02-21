🤖 ZapOrder – Bot de Pedidos via WhatsApp com PIX
O ZapOrder é um bot automatizado que permite realizar pedidos de refeições e bebidas diretamente pelo WhatsApp, com pagamentos via PIX. Ele foi desenvolvido usando as bibliotecas Baileys e Axios em Node.js.

🚀 Funcionalidades
📋 Cadastro automático de usuários (nome, endereço e telefone)
🍔 Exibição de catálogo com opções de refeições e bebidas
🛒 Sistema de carrinho para adicionar itens
💳 Geração de QR Code para pagamentos via PIX
✅ Reconhecimento de comprovantes em PDF
❌ Cancelamento de pedidos pendentes
📄 Listagem de pedidos em andamento
🛠 Tecnologias Utilizadas
Node.js
Baileys (API do WhatsApp)
Axios (Requisições HTTP)
PDF-Parse (Leitura de PDFs para confirmação de pagamentos)
File System (fs) (Leitura e gravação de arquivos)
📦 Instalação
Clone o repositório:
bash
Copiar
Editar
git clone https://github.com/seu-usuario/zaporder.git
cd zaporder
Instale as dependências:
bash
Copiar
Editar
npm install
Execute o bot:
bash
Copiar
Editar
node index.js
Escaneie o QR Code gerado no terminal com o seu WhatsApp.
⚙️ Como Usar
Digite catálogo para visualizar as opções de produtos.
Envie o número do item desejado para adicioná-lo ao carrinho.
Digite finalizar para receber o QR Code de pagamento.
Após o pagamento, envie o comprovante em PDF para confirmar o pedido.
Digite cancelar para cancelar pedidos pendentes.
