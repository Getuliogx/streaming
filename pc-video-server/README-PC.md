# Servidor de vídeos no PC

Este servidor entrega arquivos MP4 com suporte a **Range**, necessário para avançar e voltar no player.

## 1. Preparar

1. Instale o Node.js 20 ou mais recente.
2. Copie `.env.example` para `.env`.
3. Edite o `.env`:

```env
PORT=8787
VIDEO_DIR=C:\Videos
ACCESS_TOKEN=uma-chave-bem-grande
ALLOWED_ORIGIN=https://seu-site.onrender.com
```

4. Coloque os vídeos diretamente na pasta informada em `VIDEO_DIR`.
5. Dê dois cliques em `iniciar.bat`.

Teste no próprio PC:

```text
http://localhost:8787/health
```

## 2. Tornar acessível na internet

A forma mais simples sem abrir porta no roteador é um túnel HTTPS. Com o Cloudflare Tunnel instalado, o teste rápido costuma ser:

```text
cloudflared tunnel --url http://localhost:8787
```

Ele exibirá um endereço HTTPS temporário. No painel do site, cole este endereço no campo **Link do vídeo**:

```text
https://ENDERECO-DO-TUNEL/videos/meu-video.mp4?token=SEU_ACCESS_TOKEN
```

Para uso fixo, configure um túnel nomeado e um domínio no painel da Cloudflare. Os nomes dos menus podem mudar.

## Limitações

- O PC precisa permanecer ligado.
- A velocidade para cada espectador depende do upload da sua internet.
- O endereço temporário muda quando o túnel é reiniciado.
- Não coloque senhas pessoais no nome do arquivo.
- O token fica visível para quem abrir as ferramentas do navegador; ele reduz acesso casual, mas não é DRM.
