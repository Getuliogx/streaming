# Minha Stream Simples 6.0

Projeto sem PostgreSQL, com catálogo salvo no GitHub e painel no Render.

## Correção do importador do OK.ru

A versão 6 reconhece o HTML atual das playlists do OK.ru, inclusive:

- links `a.video-card_lk`;
- ações `OK.videoPlayer.openMovie('ID', ...)`;
- paginação desktop e móvel;
- parâmetros `st.page`, `page` e `p`;
- títulos próximos ao cartão e metadados do vídeo;
- contagem informada pela página, como “26 videos”.

O importador preserva o nome encontrado no OK.ru. O TMDB só completa o título quando ele vier genérico, como “Episódio 1”.

## Variáveis do Render

```text
ADMIN_PASSWORD = sua senha
GITHUB_TOKEN = seu token
GITHUB_REPO = usuario/repositorio
NODE_ENV = production
TMDB_API_KEY = sua chave do TMDB
```

## Atualização

Envie todos os arquivos desta pasta por cima dos arquivos antigos no repositório. Depois use **Manual Deploy > Clear build cache & deploy** no Render.

Ao abrir `/admin`, confirme o selo:

```text
IMPORTADOR OK.RU V6.0.0
```

## Importação da série

1. Busque a série no TMDB e clique em **Usar**.
2. Deixe o tipo como **Episódio de série**.
3. Informe a temporada e o primeiro episódio.
4. Cole o link da playlist no quadro **PLAYLIST DO OK.RU**.
5. Clique em **Puxar todos os vídeos da playlist**.

Exemplo:

```text
https://ok.ru/video/c23729458
```

A reimportação atualiza os vídeos existentes e não cria cópias.

## Sem DRM

Links externos funcionam apenas quando o site permite incorporação. O projeto não remove DRM nem bloqueios de terceiros.
