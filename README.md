# Minha Stream V10.1

Site de catálogo e reprodução com filmes, séries, temporadas, episódios,
categorias, gêneros, A–Z, TMDb e painel administrativo.

## Mudanças da V10

### Um único player para a série

A página `series.html` agora possui somente um player. Ao clicar em qualquer
episódio, o mesmo player troca de vídeo sem abrir uma página diferente para
cada episódio.

O player continua aceitando:

- OK.ru;
- Google Drive;
- HLS/M3U8;
- vídeo direto;
- sites que permitem iframe.

### Descrição própria de cada episódio

Quando a série possui identificação do TMDb, o servidor busca o resumo
específico de cada temporada e episódio. A descrição geral da série não é mais
repetida em todos os cartões.

Isso também corrige episódios antigos ao abrir a página, sem exigir que cada
item seja editado manualmente.

### Adicionar em playlist/série existente

No painel administrativo existe a opção:

`Adicionar os vídeos em`

Ela lista todas as séries e temporadas já cadastradas. Ao escolher uma delas,
os novos vídeos são acrescentados depois do maior número de episódio existente.

A opção funciona nos dois importadores:

- importação por link;
- importação de arquivo M3U/M3U8/TXT.

E vale para todas as origens já aceitas pelo importador universal:

- OK.ru;
- M3U, M3U8 e TXT por URL;
- JSON;
- RSS/XML;
- páginas HTML públicas;
- links diretos;
- HLS;
- outros sites públicos sem DRM que exponham os links no conteúdo da página.

Links repetidos não são duplicados.

## Variáveis

```text
ADMIN_PASSWORD=sua_senha
SESSION_SECRET=uma_chave_longa
GITHUB_TOKEN=seu_token
GITHUB_REPO=Getuliogx/streaming
TMDB_API_KEY=sua_chave_tmdb
NODE_ENV=production
```

## Atualização

Substitua os arquivos do projeto pelos arquivos da V10, mas preserve o seu
catálogo atual. O pacote de atualização separado não contém `data/catalog.json`.


## Atualização pelo GitHub

Este repositório deve ser atualizado enviando todos os arquivos da pasta
`streaming-main` para a raiz do repositório. Esta versão não altera Nginx,
Docker, HTTPS, porta ou configuração da Oracle.

A versão 10.1 também impede que uma importação destinada a uma playlist
existente remova um item anterior com a mesma URL da página importada.


## V10.3 — Player único para filmes e episódios

- `series.html` mostra somente a série, temporadas e episódios.
- A página de série não cria iframe, vídeo ou player.
- Todo episódio abre `watch.html?id=ID`.
- Filmes e episódios usam exatamente o mesmo `watch.html` e `watch.js`.
- Links antigos com `series.html?...&episode=ID` são redirecionados para `watch.html?id=ID`.
