# React preview

Este diretorio e a primeira etapa da migracao segura do front para React.

- A loja atual continua em `/`.
- A loja React é a experiência pública principal e fica em `/`.
- O caminho `/react` continua aceito como compatibilidade temporária.
- O shell React consome as APIs atuais do Django.
- Nenhuma pagina publica foi substituida ainda.

Quando tivermos `npm`/build configurado no ambiente, este shell pode ser movido para Vite/React com build em `public/react-app`.
