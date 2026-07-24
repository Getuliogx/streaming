'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { Readable } = require('stream');

const PLAYER_PROXY_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_RESOLVER_DEPTH = 3;
const MAX_RESOLVER_HTML = 5 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 35_000;

function cleanText(value, max = 5000) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanHttpUrl(value, max = 12000) {
  const text = cleanText(value, max);
  if (!text) return '';

  try {
    const parsed = new URL(text);
    return /^https?:$/i.test(parsed.protocol) ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function isPrivateAddress(address) {
  if (!address) return true;

  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts;

    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }

  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();

    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb') ||
      normalized.startsWith('ff')
    );
  }

  return true;
}

async function assertPublicUrl(value) {
  const url = new URL(value);

  if (!/^https?:$/i.test(url.protocol)) {
    const error = new Error('A fonte do vídeo precisa usar HTTP ou HTTPS.');
    error.status = 400;
    throw error;
  }

  if (
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.local') ||
    net.isIP(url.hostname) && isPrivateAddress(url.hostname)
  ) {
    const error = new Error('Endereço de mídia não permitido.');
    error.status = 403;
    throw error;
  }

  if (!net.isIP(url.hostname)) {
    const records = await dns.lookup(url.hostname, { all: true });

    if (!records.length || records.some(record => isPrivateAddress(record.address))) {
      const error = new Error('Endereço de mídia não permitido.');
      error.status = 403;
      throw error;
    }
  }

  return url;
}

async function safeFetch(input, options = {}) {
  let current = await assertPublicUrl(input);
  const headers = {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    accept: '*/*',
    ...(options.headers || {})
  };

  for (let redirects = 0; redirects <= 6; redirects += 1) {
    const response = await fetch(current, {
      method: options.method || 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeout || MEDIA_TIMEOUT_MS)
    });

    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.get('location')
    ) {
      current = await assertPublicUrl(
        new URL(response.headers.get('location'), current).toString()
      );
      continue;
    }

    return {
      response,
      finalUrl: current
    };
  }

  const error = new Error('A fonte do vídeo redirecionou vezes demais.');
  error.status = 502;
  throw error;
}

function decodeEscapedUrl(value) {
  return cleanHttpUrl(
    String(value || '')
      .replace(/\\u0026/gi, '&')
      .replace(/\\\//g, '/')
      .replace(/&amp;/gi, '&')
  );
}

function mediaKindFromUrl(value) {
  const url = String(value || '').toLowerCase();

  if (/\.m3u8(?:$|[?#])/.test(url)) return 'hls';

  if (
    /\.(?:mp4|m4v|webm|ogv|ogg|mov|mkv|mp3|m4a|aac)(?:$|[?#])/.test(url)
  ) {
    return 'video';
  }

  return '';
}

function qualityScore(name, url) {
  const text = `${name || ''} ${url || ''}`.toLowerCase();
  let score = 0;

  if (/2160|4k|ultra/.test(text)) score += 900;
  if (/1440|quad/.test(text)) score += 800;
  if (/1080|full/.test(text)) score += 700;
  if (/720|\bhd\b/.test(text)) score += 600;
  if (/480|\bsd\b/.test(text)) score += 500;
  if (/360|low/.test(text)) score += 400;
  if (/240|mobile/.test(text)) score += 300;
  if (/\.mp4(?:$|[?#])/.test(text)) score += 80;
  if (/\.m3u8(?:$|[?#])/.test(text)) score += 60;

  const numeric = [...text.matchAll(/(?:^|\D)(\d{3,4})(?:p|\D|$)/g)]
    .map(match => Number(match[1]))
    .filter(Number.isFinite);

  if (numeric.length) score += Math.max(...numeric);

  return score;
}

function extractOkruMediaCandidates(root) {
  const queue = [root];
  const visited = new Set();
  const candidates = new Map();

  function add(rawUrl, name = '', type = '') {
    const url = decodeEscapedUrl(rawUrl);
    if (!url) return;

    const kind =
      /m3u8|mpegurl|hls/i.test(`${type} ${url}`)
        ? 'hls'
        : mediaKindFromUrl(url) || 'video';

    const key = url;
    const candidate = {
      url,
      kind,
      name: cleanText(name, 100),
      score: qualityScore(name, url)
    };

    const previous = candidates.get(key);
    if (!previous || candidate.score > previous.score) {
      candidates.set(key, candidate);
    }
  }

  while (queue.length) {
    const value = queue.shift();

    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);

    if (Array.isArray(value)) {
      for (const child of value) queue.push(child);
      continue;
    }

    const objectUrl =
      value.url ||
      value.src ||
      value.videoUrl ||
      value.video_url ||
      value.file ||
      value.playbackUrl ||
      value.playback_url;

    if (objectUrl) {
      add(
        objectUrl,
        value.name || value.quality || value.label || value.type || '',
        value.type || value.mimeType || value.mime_type || ''
      );
    }

    for (const [key, child] of Object.entries(value)) {
      if (
        typeof child === 'string' &&
        /(?:url|src|manifest|playlist|hls|video|file)/i.test(key)
      ) {
        add(child, key, key);
      }

      if (child && typeof child === 'object') queue.push(child);
    }
  }

  return [...candidates.values()];
}

function selectBestMediaCandidate(candidates) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];

  if (!list.length) return null;

  return [...list].sort((a, b) => {
    if (a.kind !== b.kind) {
      if (a.kind === 'video') return -1;
      if (b.kind === 'video') return 1;
    }

    return (b.score || 0) - (a.score || 0);
  })[0];
}

function extractOkruId(value) {
  const text = String(value || '');
  const match =
    text.match(/(?:videoembed|video)\/(\d{6,})/) ||
    text.match(/(\d{6,})/);

  return match ? match[1] : '';
}

async function resolveOkru(item, fetchOkruHtml) {
  const id = extractOkruId(item.source_url);
  if (!id) throw new Error('O código do vídeo do OK.ru é inválido.');

  const metadataUrl = new URL('https://ok.ru/dk');
  metadataUrl.searchParams.set('cmd', 'videoPlayerMetadata');
  metadataUrl.searchParams.set('mid', id);

  const result = await fetchOkruHtml(metadataUrl);
  const raw = String(result.html || '')
    .trim()
    .replace(/^while\s*\(\s*1\s*\)\s*;?/i, '')
    .replace(/^for\s*\(\s*;;\s*\)\s*;?/i, '')
    .trim();

  const starts = [raw.indexOf('{'), raw.indexOf('[')]
    .filter(index => index >= 0);
  const start = starts.length ? Math.min(...starts) : -1;

  if (start < 0) {
    throw new Error('O OK.ru não entregou os dados do vídeo.');
  }

  const parsed = JSON.parse(raw.slice(start));
  const candidate = selectBestMediaCandidate(
    extractOkruMediaCandidates(parsed)
  );

  if (!candidate) {
    throw new Error('O OK.ru não disponibilizou um arquivo reproduzível.');
  }

  return {
    ...candidate,
    referer: `https://ok.ru/video/${id}`
  };
}

function extractDriveId(value) {
  const text = String(value || '').trim();
  const match =
    text.match(/\/d\/([a-zA-Z0-9_-]+)/) ||
    text.match(/[?&]id=([a-zA-Z0-9_-]+)/);

  return match ? match[1] : text;
}

async function resolveGoogleDrive(item) {
  const id = extractDriveId(item.source_url);

  if (!/^[a-zA-Z0-9_-]{10,}$/.test(id)) {
    throw new Error('O código do arquivo do Google Drive é inválido.');
  }

  return {
    kind: 'video',
    url:
      `https://drive.usercontent.google.com/download` +
      `?id=${encodeURIComponent(id)}&export=download&confirm=t`,
    referer: 'https://drive.google.com/'
  };
}

function absoluteUrl(value, baseUrl) {
  try {
    return new URL(
      String(value || '')
        .replace(/\\u0026/gi, '&')
        .replace(/\\\//g, '/')
        .replace(/&amp;/gi, '&'),
      baseUrl
    ).toString();
  } catch {
    return '';
  }
}

function extractMediaFromHtml(html, baseUrl) {
  const source = String(html || '').slice(0, MAX_RESOLVER_HTML);
  const candidates = [];
  const iframeUrls = [];

  function add(value, label = '') {
    const url = absoluteUrl(value, baseUrl);
    const kind = mediaKindFromUrl(url);

    if (!url || !kind) return;

    candidates.push({
      url,
      kind,
      name: label,
      score: qualityScore(label, url),
      referer: baseUrl
    });
  }

  const tagRegex = /<(video|source|iframe|meta)\b([^>]*)>/gi;
  let match;

  while ((match = tagRegex.exec(source))) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];

    function attr(name) {
      const pattern = new RegExp(
        `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
        'i'
      );
      const found = attrs.match(pattern);
      return found ? found[1] ?? found[2] ?? found[3] ?? '' : '';
    }

    if (tag === 'iframe') {
      const iframeUrl = absoluteUrl(attr('src'), baseUrl);
      if (iframeUrl) iframeUrls.push(iframeUrl);
      continue;
    }

    if (tag === 'meta') {
      const property = `${attr('property')} ${attr('name')}`.toLowerCase();
      if (/og:video|twitter:player:stream/.test(property)) {
        add(attr('content'), property);
      }
      continue;
    }

    add(attr('src'), attr('label') || attr('type') || tag);
  }

  const escapedUrlRegex =
    /https?:\\?\/\\?\/[^"'\\\s<]+?\.(?:m3u8|mp4|m4v|webm|ogv|ogg|mov|mkv)(?:\\?[^"'\\\s<]*)?/gi;

  while ((match = escapedUrlRegex.exec(source))) {
    add(match[0], 'html');
  }

  const jsonUrlRegex =
    /"(?:file|src|url|videoUrl|playbackUrl|hlsManifestUrl)"\s*:\s*"((?:\\.|[^"\\])*)"/gi;

  while ((match = jsonUrlRegex.exec(source))) {
    add(match[1], 'json');
  }

  return {
    candidates,
    iframeUrls: [...new Set(iframeUrls)].slice(0, 8)
  };
}

async function resolveGeneric(
  inputUrl,
  fetchPublicResource,
  depth = 0,
  visited = new Set()
) {
  const normalized = cleanHttpUrl(inputUrl);
  if (!normalized) throw new Error('A fonte do vídeo é inválida.');

  if (visited.has(normalized)) {
    throw new Error('A página do vídeo criou um ciclo de redirecionamento.');
  }

  visited.add(normalized);

  const directKind = mediaKindFromUrl(normalized);
  if (directKind) {
    return {
      kind: directKind,
      url: normalized,
      referer: normalized
    };
  }

  if (depth > MAX_RESOLVER_DEPTH) {
    throw new Error('A página não revelou um arquivo de vídeo direto.');
  }

  const resource = await fetchPublicResource(normalized);
  const type = String(resource.contentType || '').toLowerCase();
  const finalUrl = resource.finalUrl.toString();

  if (/mpegurl|application\/vnd\.apple\.mpegurl/.test(type)) {
    return {
      kind: 'hls',
      url: finalUrl,
      referer: normalized
    };
  }

  if (/^video\/|^audio\/|application\/octet-stream/.test(type)) {
    return {
      kind: 'video',
      url: finalUrl,
      referer: normalized
    };
  }

  const body = String(resource.body || '');

  if (/#EXTM3U|#EXT-X-(?:TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/i.test(body)) {
    return {
      kind: 'hls',
      url: finalUrl,
      referer: normalized
    };
  }

  const extracted = extractMediaFromHtml(body, finalUrl);
  const best = selectBestMediaCandidate(extracted.candidates);

  if (best) return best;

  for (const iframeUrl of extracted.iframeUrls) {
    try {
      return await resolveGeneric(
        iframeUrl,
        fetchPublicResource,
        depth + 1,
        visited
      );
    } catch {}
  }

  throw new Error(
    'Esse site não fornece o arquivo do vídeo para o player único.'
  );
}

function base64UrlEncode(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(String(value), 'base64url').toString('utf8');
}

function createSignature(secret, expires, target, referer) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${expires}\n${target}\n${referer}`)
    .digest('base64url');
}

function createProxyUrl(secret, target, referer, expires = Date.now() + PLAYER_PROXY_TTL_MS) {
  const signature = createSignature(secret, expires, target, referer);

  return (
    `/api/player-media?e=${encodeURIComponent(expires)}` +
    `&u=${encodeURIComponent(base64UrlEncode(target))}` +
    `&r=${encodeURIComponent(base64UrlEncode(referer || ''))}` +
    `&s=${encodeURIComponent(signature)}`
  );
}

function readSignedProxyRequest(req, secret) {
  const expires = Number(req.query.e);
  const target = base64UrlDecode(req.query.u || '');
  const referer = base64UrlDecode(req.query.r || '');
  const signature = String(req.query.s || '');

  if (!Number.isFinite(expires) || expires < Date.now()) {
    const error = new Error('O endereço temporário do vídeo expirou.');
    error.status = 410;
    throw error;
  }

  const expected = createSignature(secret, expires, target, referer);
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    const error = new Error('Assinatura de mídia inválida.');
    error.status = 403;
    throw error;
  }

  return {
    target,
    referer,
    expires
  };
}

function rewriteHlsPlaylist(text, baseUrl, secret, referer, expires) {
  const source = String(text || '');

  function proxy(value) {
    const absolute = absoluteUrl(value, baseUrl);
    return absolute
      ? createProxyUrl(secret, absolute, referer || baseUrl, expires)
      : value;
  }

  return source
    .split(/\r?\n/)
    .map(line => {
      if (!line) return line;

      if (!line.startsWith('#')) {
        return proxy(line.trim());
      }

      return line.replace(
        /URI=(?:"([^"]+)"|'([^']+)'|([^,\s]+))/gi,
        (_, doubleQuoted, singleQuoted, bare) => {
          const original = doubleQuoted || singleQuoted || bare || '';
          return `URI="${proxy(original)}"`;
        }
      );
    })
    .join('\n');
}

async function pipeRemoteMedia(req, res, target, referer, secret, expires) {
  const headers = {
    accept: req.headers.accept || '*/*'
  };

  if (req.headers.range) headers.range = req.headers.range;
  if (req.headers['if-range']) headers['if-range'] = req.headers['if-range'];
  if (referer) headers.referer = referer;

  const result = await safeFetch(target, {
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers,
    timeout: MEDIA_TIMEOUT_MS
  });

  const response = result.response;
  const contentType = String(response.headers.get('content-type') || '');
  const finalUrl = result.finalUrl.toString();
  const looksHls =
    /mpegurl/i.test(contentType) ||
    /\.m3u8(?:$|[?#])/i.test(finalUrl);

  if (looksHls && req.method !== 'HEAD') {
    const playlist = await response.text();
    const rewritten = rewriteHlsPlaylist(
      playlist,
      finalUrl,
      secret,
      referer || finalUrl,
      expires
    );

    res.status(response.status);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(rewritten);
    return;
  }

  res.status(response.status);

  const headersToCopy = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'last-modified',
    'etag',
    'cache-control'
  ];

  for (const name of headersToCopy) {
    const value = response.headers.get(name);
    if (value) res.setHeader(name, value);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  if (req.method === 'HEAD' || !response.body) {
    res.end();
    return;
  }

  Readable.fromWeb(response.body).pipe(res);
}

function registerUniversalPlayerRoutes(app, options) {
  const {
    findTitle,
    fetchOkruHtml,
    fetchPublicResource
  } = options;

  const secret = String(
    options.secret ||
    process.env.SESSION_SECRET ||
    process.env.GITHUB_TOKEN ||
    process.env.ADMIN_PASSWORD ||
    'minha-stream-player-unico'
  );

  async function resolveItem(item) {
    if (item.source_type === 'okru') {
      return resolveOkru(item, fetchOkruHtml);
    }

    if (item.source_type === 'gdrive') {
      return resolveGoogleDrive(item);
    }

    if (item.source_type === 'hls') {
      return {
        kind: 'hls',
        url: item.source_url,
        referer: item.source_url
      };
    }

    if (item.source_type === 'direct') {
      return {
        kind: mediaKindFromUrl(item.source_url) || 'video',
        url: item.source_url,
        referer: item.source_url
      };
    }

    return resolveGeneric(item.source_url, fetchPublicResource);
  }

  app.get('/api/player-source/:id', async (req, res, next) => {
    try {
      const item = await findTitle(req.params.id, true);

      if (!item) {
        return res.status(404).json({
          error: 'Conteúdo não encontrado.'
        });
      }

      const source = await resolveItem(item);
      const expires = Date.now() + PLAYER_PROXY_TTL_MS;

      res.setHeader('Cache-Control', 'no-store');

      res.json({
        player: 'universal-video',
        kind: source.kind,
        url: createProxyUrl(
          secret,
          source.url,
          source.referer || item.source_url,
          expires
        ),
        expires,
        poster:
          item.episode_image_url ||
          item.backdrop_url ||
          item.cover_url ||
          ''
      });
    } catch (error) {
      if (!error.status) error.status = 422;
      next(error);
    }
  });

  async function mediaProxy(req, res, next) {
    try {
      const signed = readSignedProxyRequest(req, secret);

      await pipeRemoteMedia(
        req,
        res,
        signed.target,
        signed.referer,
        secret,
        signed.expires
      );
    } catch (error) {
      next(error);
    }
  }

  app.get('/api/player-media', mediaProxy);
  app.head('/api/player-media', mediaProxy);
}

module.exports = {
  registerUniversalPlayerRoutes,
  extractOkruMediaCandidates,
  selectBestMediaCandidate,
  rewriteHlsPlaylist,
  extractMediaFromHtml,
  mediaKindFromUrl
};
