# Minha Stream Simples

Site de catálogo e reprodução com painel administrativo. Não usa PostgreSQL e você não precisa editar `catalog.json` manualmente.

## Como funciona

1. O código fica no GitHub.
2. O site roda no Render.
3. Você entra em `/admin`, cola o título, a capa e o link do vídeo.
4. Ao clicar em **Salvar**, o site grava o catálogo automaticamente em um ramo chamado `catalogo` no seu repositório.

O ramo `catalogo` é criado automaticamente. Ele fica separado do ramo principal, por isso adicionar vídeos não precisa provocar um novo deploy do site.

## Fontes aceitas

- OK.ru: link normal ou link `videoembed`.
- Google Drive: link de compartilhamento.
- Servidor do PC: link público terminando em `.mp4` ou outro formato aceito pelo navegador.
- HLS: link `.m3u8`.

O painel identifica o tipo do link automaticamente.

# Instalação simples

## 1. Enviar para o GitHub

Crie um repositório vazio no GitHub e envie todos os arquivos desta pasta para ele.

## 2. Criar o token do GitHub

Crie um token de acesso para o mesmo repositório. Pode ser um token de acesso refinado/fine-grained. Dê acesso somente ao repositório do site e permissão de **leitura e gravação do conteúdo**.

Copie o token quando ele for mostrado. O nome exato das telas pode variar no GitHub.

## 3. Criar o site no Render

Crie um **Web Service** no Render usando o repositório do GitHub.

Use:

```text
Build Command: npm install
Start Command: npm start
```

Adicione estas três variáveis:

```text
ADMIN_PASSWORD = a senha que você usará no painel
GITHUB_TOKEN = o token criado no GitHub
GITHUB_REPO = usuario/nome-do-repositorio
```

Exemplo de `GITHUB_REPO`:

```text
joao/minha-stream
```

Não coloque `https://github.com/`. Use apenas `usuario/repositorio`.

Também deixe:

```text
NODE_ENV = production
```

Depois faça o deploy.

## 4. Adicionar vídeos

Abra:

```text
https://SEU-SITE.onrender.com/admin
```

Entre com a senha de `ADMIN_PASSWORD`, preencha:

- título;
- link do vídeo;
- link da capa, se tiver;
- descrição, se quiser.

Clique em **Salvar**. Não precisa abrir nem editar arquivo no GitHub.

# Google Drive

No Drive, deixe o arquivo acessível para qualquer pessoa com o link. Cole o link de compartilhamento no painel.

O Google Drive pode limitar reprodução quando há muitas visualizações. Ele é mais indicado para uso pessoal ou poucos usuários.

# OK.ru

Cole um link parecido com:

```text
https://ok.ru/video/1234567890
```

ou:

```text
https://ok.ru/videoembed/1234567890
```

# Vídeos do seu PC

O site no Render não consegue abrir caminhos como `C:\Filmes\filme.mp4`. Você precisa executar o servidor da pasta `pc-video-server` e publicar o endereço com HTTPS.

Veja `pc-video-server/README-PC.md`.

O PC precisa ficar ligado durante a reprodução.

# Teste no computador

Sem configurar GitHub, o projeto usa `data/catalog.json` apenas para teste local.

```bash
npm install
npm start
```

Abra:

```text
http://localhost:10000
http://localhost:10000/admin
```

No uso real no Render, configure `GITHUB_TOKEN` e `GITHUB_REPO` para o catálogo permanecer salvo.

# Segurança

- Nunca coloque o token dentro de arquivos enviados ao GitHub.
- Coloque o token somente nas variáveis do Render.
- Use uma senha forte em `ADMIN_PASSWORD`.
- Use apenas vídeos que você tenha autorização para disponibilizar.
