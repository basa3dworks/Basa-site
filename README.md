# Basa 3D Works

MVP de e-commerce com vitrine publica, carrinho, checkout, painel admin, gestao de produtos/pedidos e camada de split de pagamentos.

## Como rodar

```bash
node src/server.mjs
```

Por padrao o site abre em:

- Loja: `http://localhost:3000`
- Admin: `http://localhost:3000/admin.html`

Credenciais de desenvolvimento:

- Email: `admin@basa3dworks.com`
- Senha: `admin`

Em producao, configure as variaveis de ambiente usando `.env.example` como referencia.

## O que ja esta implementado

- Catalogo publico de produtos.
- Carrinho persistido no navegador.
- Checkout com criacao de pedido.
- Painel admin protegido por sessao.
- Cadastro de produtos pelo admin.
- Lista de pedidos com detalhes do split.
- Banco JSON local em `data/db.json`.
- Modulo de split em `src/payment/split.mjs`.
- Cotacao de frete preparada em `src/shipping.mjs`.

## Split de pagamentos

O projeto vem com `PAYMENT_PROVIDER=mock`, que aprova pedidos localmente e calcula:

- comissao da Basa;
- taxa estimada do gateway;
- valor liquido do vendedor;
- alocacoes entre marketplace e vendedor.

Para producao, substitua o provider por `mercado-pago` ou `stripe` e implemente a chamada real no arquivo `src/payment/split.mjs` usando as credenciais:

- `MERCADO_PAGO_ACCESS_TOKEN`
- `MERCADO_PAGO_PUBLIC_KEY`
- `STRIPE_SECRET_KEY`

O modelo atual ja guarda `seller.paymentAccountId` nos produtos, que e o identificador usado para transferir a parte do vendedor.

## Mercado Pago Checkout Pro

O servidor carrega variaveis do arquivo `.env`. Para usar Checkout Pro em teste:

```env
PAYMENT_PROVIDER=mercado-pago
MERCADO_PAGO_ACCESS_TOKEN=cole_seu_access_token
MERCADO_PAGO_PUBLIC_KEY=cole_sua_public_key
PUBLIC_BASE_URL=http://localhost:3000
```

Enquanto o site estiver em `localhost`, o checkout redireciona para o Mercado Pago, mas webhooks automaticos ficam para quando houver dominio publico com HTTPS.

## Frete

O projeto vem com `SHIPPING_PROVIDER=mock`, que simula opcoes de PAC/SEDEX enquanto a conta do Melhor Envio nao estiver conectada.

Para conectar o Melhor Envio, configure:

- `SHIPPING_PROVIDER=melhor-envio`
- `MELHOR_ENVIO_TOKEN`
- `MELHOR_ENVIO_API_BASE`
- `MELHOR_ENVIO_USER_AGENT`

Cada produto ja possui dados de frete:

- peso em kg;
- largura em cm;
- altura em cm;
- comprimento em cm.

O checkout chama `/api/shipping/quote`, mostra as opcoes de entrega e grava a opcao escolhida no pedido.

## Proximos passos recomendados

- Trocar o banco JSON por PostgreSQL ou MySQL.
- Usar hash de senha e gerenciamento de usuarios admin.
- Integrar gateway real de pagamento com webhooks.
- Criar area do cliente e rastreio de pedidos.
- Adicionar upload de imagens para produtos.
