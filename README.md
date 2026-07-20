# Minha Stream Simples 4.0

Site de catálogo e reprodução com painel administrativo. Não usa PostgreSQL e não exige edição manual de `catalog.json`.

## O que esta versão corrige

- Importação de playlist/canal do OK.ru por link, inclusive links no formato `https://ok.ru/video/c23729458`.
- Busca dos vídeos nas páginas seguintes da lista.
- Leitura do título real de cada vídeo do OK.ru.
- Reconhecimento de formatos como `S01E01`, `1x01`, `Temporada 1 Episódio 1`, `EP 1` e semelhantes.
- Uso opcional do TMDB para substituir títulos genéricos como “Episódio 1”.
- Nova tela de série com seletor de temporada, seletor de episódio e cartões visuais.
- Nova troca de episódios no player, com anterior e próximo.

## Como funciona

1. O código fica no GitHub.
2. O site roda no Render.
3. Você entra em `/admin`.
4. Ao salvar ou importar, o catálogo é gravado automaticamente no ramo `catalogo` do seu repositório.

O ramo `catalogo` é criado automaticamente e fica separado do ramo principal. Adicionar vídeos não provoca novo deploy.

## Variáveis do Render

```text
ADMIN_PASSWORD = sua senha do painel
GITHUB_TOKEN = seu token do GitHub
GITHUB_REPO = usuario/nome-do-repositorio
NODE_ENV = production
TMDB_API_KEY = sua chave do TMDB
```

Não coloque `https://github.com/` em `GITHUB_REPO`. Use apenas `usuario/repositorio`.

## Atualizar um site já criado

1. Extraia o ZIP.
2. Envie todos os arquivos e pastas para o mesmo repositório do GitHub, substituindo os antigos.
3. Aguarde o deploy automático do Render.
4. Abra `https://SEU-SITE.onrender.com/admin`.

Não é preciso criar PostgreSQL nem variável nova.

## Importar uma playlist do OK.ru

Para importar uma série:

1. No painel, pesquise a série no TMDB e clique em **Usar**.
2. Confirme que o tipo ficou como **Episódio de série**.
3. Informe a temporada inicial e, se necessário, o primeiro episódio.
4. Abra **Importar uma playlist inteira**.
5. Cole um link como:

```text
https://ok.ru/video/c23729458
```

6. Clique em **Puxar todos do OK.ru**.

O importador tenta acessar a versão normal e a versão móvel do OK.ru, procura páginas seguintes, remove links repetidos e salva cada vídeo como um episódio separado.

A lista precisa ser pública e abrir sem login. Como o OK.ru pode mudar o HTML da página, o importador mostra um erro quando não consegue identificar os vídeos em vez de cadastrar links aleatórios.

## Arquivos M3U, M3U8 e TXT

Também é possível enviar um arquivo de playlist. Para séries, preencha primeiro o nome da série, a temporada inicial e o episódio inicial. O painel usa esses valores nos itens que não possuem numeração no título.

## Fontes aceitas

- OK.ru: vídeo individual, `videoembed` e playlist/canal por link.
- Google Drive: link de compartilhamento.
- Servidor do PC: link público de vídeo.
- HLS: link `.m3u8`.
- Sites externos: somente quando permitem incorporação por iframe.

O sistema não remove DRM nem bloqueios de incorporação.

## Vídeos do seu PC

O Render não consegue abrir caminhos como `C:\Filmes\filme.mp4`. Execute o servidor da pasta `pc-video-server` e publique um endereço HTTPS. Veja `pc-video-server/README-PC.md`.

O computador precisa ficar ligado durante a reprodução.

## Teste local

```bash
npm install
npm start
```

Abra:

```text
http://localhost:10000
http://localhost:10000/admin
```

Sem `GITHUB_TOKEN` e `GITHUB_REPO`, o projeto usa `data/catalog.json` apenas para testes locais.

## Segurança

- Nunca coloque o token dentro dos arquivos do GitHub.
- Guarde o token somente nas variáveis do Render.
- Use uma senha forte em `ADMIN_PASSWORD`.
- Disponibilize apenas conteúdo que você tenha autorização para publicar.
