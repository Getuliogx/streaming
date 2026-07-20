# Minha Stream — TMDB, playlists e séries

Esta versão continua sem PostgreSQL. O catálogo é salvo automaticamente no GitHub pelo painel.

## O que foi adicionado

- busca no TMDB para preencher capa, imagem de fundo, descrição, ano e gêneros;
- importação de arquivos `.m3u`, `.m3u8` e `.txt` pelo painel;
- séries agrupadas em uma única capa no catálogo;
- página de série com escolha de temporada e episódio;
- lista de temporadas e episódios também abaixo do player;
- OK.ru, Google Drive, HLS/M3U8, vídeo direto e sites que aceitam incorporação por iframe.

## Atualizar o site que já está no Render

1. Envie todos os arquivos desta pasta para o mesmo repositório do GitHub e confirme a substituição dos arquivos antigos.
2. No Render, abra o seu Web Service.
3. Entre em **Environment**.
4. Adicione:

```text
TMDB_API_KEY = sua chave API do TMDB
```

5. Salve. O Render fará um novo deploy. Caso não faça, use **Manual Deploy → Deploy latest commit**.

As variáveis que você já configurou continuam iguais:

```text
ADMIN_PASSWORD = sua senha do painel
GITHUB_TOKEN = seu token do GitHub
GITHUB_REPO = usuario/repositorio
NODE_ENV = production
```

Não precisa de banco de dados.

## Adicionar capa pelo TMDB

1. Abra `https://SEU-SITE.onrender.com/admin`.
2. Entre com sua senha.
3. Em **Buscar capa e dados no TMDB**, escreva o nome do filme ou série.
4. Clique em **Buscar** e depois em **Usar** no resultado certo.
5. Cole o link do vídeo e clique em **Salvar**.

Ao escolher uma série no TMDB, o formulário muda para episódio e preenche o nome da série. Informe temporada, episódio e o link do vídeo.

## Importar uma playlist

1. No painel, preencha antes a capa e o nome da série, caso todos os links sejam da mesma série.
2. Abra **Importar playlist M3U, M3U8 ou TXT**.
3. Selecione o arquivo.
4. Deixe marcada a opção para usar os dados do formulário.
5. Clique em **Importar playlist**.

O importador reconhece nomes como:

```text
Minha Série S01E01 - Piloto
Minha Série 1x02 - Segundo episódio
```

Quando você preenche o nome da série no formulário e a playlist não contém números, os itens são importados na ordem como Temporada 1, Episódios 1, 2, 3 e assim por diante.

Arquivos HLS que contêm apenas os segmentos de um único vídeo não são importados como catálogo. Nesse caso, cadastre o link `.m3u8` diretamente no campo **Link do vídeo**.

## Links e sites aceitos

- OK.ru;
- Google Drive;
- link direto MP4/WebM e servidor do PC;
- HLS `.m3u8`;
- página ou player de outro site usando **Site incorporado / iframe**.

Não existe suporte literal a qualquer site. Alguns sites bloqueiam iframe com `X-Frame-Options` ou `Content-Security-Policy`; nesse caso, o navegador impede a exibição e o site precisa fornecer um link oficial de incorporação. HLS também precisa permitir CORS. O projeto não remove DRM nem contorna bloqueios.

Use somente conteúdo próprio ou que você tenha autorização para exibir.

Este produto usa a API do TMDB, mas não é endossado nem certificado pelo TMDB.
