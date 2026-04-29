# Basa 3D Works

Sistema de e-commerce para vitrine publica, carrinho, checkout, painel admin, pedidos, frete, campanhas, metricas e integracoes operacionais.

## Como rodar

```bash
node src/server.mjs
```

Por padrao o site abre em:

- Loja: `http://localhost:3000`
- Admin: `http://localhost:3000/admin.html`

Configure as credenciais locais no arquivo `.env`. Em producao, cadastre as variaveis de ambiente na plataforma de hospedagem usando `.env.example` como referencia.

## O que ja esta implementado

- Catalogo publico de produtos.
- Carrinho persistido no navegador.
- Checkout com criacao de pedido.
- Painel admin protegido por sessao.
- Cadastro de produtos pelo admin.
- Central operacional de pedidos.
- Banco JSON local em `data/db.json`.
- Integracao preparada com Mercado Pago.
- Integracao preparada com Melhor Envio.
- Cupons, campanhas e metricas comerciais.

## Pagamentos

O projeto vem com `PAYMENT_PROVIDER=mock` para desenvolvimento local. Para producao, configure `PAYMENT_PROVIDER=mercado-pago` e use as credenciais no ambiente seguro da hospedagem.

Variaveis relacionadas:

- `MERCADO_PAGO_ACCESS_TOKEN`
- `MERCADO_PAGO_PUBLIC_KEY`
- `PUBLIC_BASE_URL`

## Mercado Pago Checkout Pro

O servidor carrega variaveis do arquivo `.env`. Para usar Checkout Pro em teste:

```env
PAYMENT_PROVIDER=mercado-pago
MERCADO_PAGO_ACCESS_TOKEN=cole_seu_access_token
MERCADO_PAGO_PUBLIC_KEY=cole_sua_public_key
PUBLIC_BASE_URL=http://localhost:3000
```

Enquanto o site estiver em `localhost`, o checkout pode redirecionar para o Mercado Pago, mas webhooks automaticos dependem de dominio publico com HTTPS.

## Frete

O projeto vem com `SHIPPING_PROVIDER=mock` para desenvolvimento local.

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

O checkout chama `/api/shipping/quote`, mostra as opcoes de entrega e grava a opcao escolhida no pedido. A central operacional do admin acompanha etiqueta, envio e rastreio.

## Proximos passos recomendados

- Trocar o banco JSON por PostgreSQL ou MySQL.
- Usar hash de senha e gerenciamento de usuarios admin.
- Integrar gateway real de pagamento com webhooks.
- Criar area do cliente e rastreio de pedidos.
- Adicionar upload de imagens para produtos.
