'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const RESOLVE_TIMEOUT_MS = 45_000;
const PROXY_TIMEOUT_MS = 45_000;
const SOURCE_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_COMMAND_OUTPUT = 18 * 1024 * 1024;

const sources = new Map();

function cleanText(value, max = 12000) {
  return String(value ?? '').trim().slice(0, max);
}

function sanitizeError(value) {
  return cleanText(value, 1200)
    .replace(/https?:\/\/\S+/gi, '[endereço removido]')
    .replace(/\s+/g, ' ')
    .trim();
}

function commandExists(command) {
  return new Promise(resolve => {
    const child = spawn(command, ['--version'], {
      stdio: ['ignore', 'ignore', 'ignore']
    });

    child.once('error', () => resolve(false));
    child.once('exit', code => resolve(code === 0));
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env || {})
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let killedForSize = false;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, options.timeout || RESOLVE_TIMEOUT_MS);

    function append(current, chunk) {
      const next = current + chunk.toString('utf8');

      if (next.length > MAX_COMMAND_OUTPUT) {
        killedForSize = true;
        child.kill('SIGKILL');
        return next.slice(-MAX_COMMAND_OUTPUT);
      }

      return next;
    }

    child.stdout.on('data', chunk => {
      stdout = append(stdout, chunk);
    });

    child.stderr.on('data', chunk => {
      stderr = append(stderr, chunk);
    });

    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });

    child.once('exit', code => {
      clearTimeout(timer);

      if (code === 0 && !killedForSize) {
        resolve({ stdout, stderr });
        return;
      }

      const detail = sanitizeError(stderr);
      const error = new Error(
        killedForSize
          ? `${command} retornou dados demais.`
          : `${command} terminou com código ${code}. ${detail}`
      );

      error.command = command;
      error.code = code;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function isPrivateAddress(address) {
  if (!address) return true;

  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
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
      normalized === '::' ||
      normalized === '::1' ||
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
    const error = new Error('A fonte precisa usar HTTP ou HTTPS.');
    error.status = 400;
    throw error;
  }

  if (
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.local') ||
    (net.isIP(url.hostname) && isPrivateAddress(url.hostname))
  ) {
    const error = new Error('Endereço de mídia não permitido.');
    error.status = 403;
    throw error;
  }

  if (!net.isIP(url.hostname)) {
    const records = await dns.lookup(url.hostname, { all: true });

    if (
      !records.length ||
      records.some(record => isPrivateAddress(record.address))
    ) {
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
    'accept-encoding': 'identity',
    ...(options.headers || {})
  };

  for (let redirects = 0; redirects <= 7; redirects += 1) {
    const response = await fetch(current, {
      method: options.method || 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(
        options.timeout || PROXY_TIMEOUT_MS
      )
    });

    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.get('location')
    ) {
      current = await assertPublicUrl(
        new URL(
          response.headers.get('location'),
          current
        ).toString()
      );
      continue;
    }

    return {
      response,
      finalUrl: current
    };
  }

  const error = new Error('A fonte redirecionou vezes demais.');
  error.status = 502;
  throw error;
}

function sourceUrlForItem(item) {
  const source = cleanText(item.source_url, 12000);

  if (!source) {
    throw new Error('O conteúdo não possui endereço de vídeo.');
  }

  if (item.source_type === 'okru') {
    const match =
      source.match(/(?:videoembed|video)\/(\d{6,})/i) ||
      source.match(/(\d{6,})/);

    if (!match) {
      throw new Error('O código do vídeo do OK.ru é inválido.');
    }

    return `https://ok.ru/video/${match[1]}`;
  }

  if (item.source_type === 'gdrive') {
    const match =
      source.match(/\/d\/([a-zA-Z0-9_-]+)/) ||
      source.match(/[?&]id=([a-zA-Z0-9_-]+)/);

    if (!match) {
      throw new Error('O código do Google Drive é inválido.');
    }

    return `https://drive.google.com/file/d/${match[1]}/view`;
  }

  return source;
}

function mediaKindFromUrl(value) {
  const text = String(value || '').toLowerCase();

  if (/\.m3u8(?:$|[?#])/.test(text)) return 'hls';

  if (
    /\.(?:mp4|m4v|webm|ogv|ogg|mov|mkv|mp3|m4a|aac)(?:$|[?#])/.test(text)
  ) {
    return 'video';
  }

  return '';
}

function hasVideo(format) {
  return Boolean(
    format &&
    format.url &&
    format.vcodec &&
    format.vcodec !== 'none'
  );
}

function hasAudio(format) {
  return Boolean(
    format &&
    format.url &&
    format.acodec &&
    format.acodec !== 'none'
  );
}

function combinedScore(format) {
  const height = Number(format?.height || 0);
  const width = Number(format?.width || 0);
  const bitrate = Number(format?.tbr || 0);
  const mp4 = format?.ext === 'mp4' ? 500000 : 0;
  const h264 = /^(?:avc1|h264)/i.test(format?.vcodec || '')
    ? 400000
    : 0;
  const aac = /^(?:mp4a|aac)/i.test(format?.acodec || '')
    ? 300000
    : 0;

  return (
    height * 1_000_000 +
    width * 1000 +
    bitrate +
    mp4 +
    h264 +
    aac
  );
}

function selectCombinedFormat(info) {
  const candidates = [];

  if (info?.url && hasVideo(info) && hasAudio(info)) {
    candidates.push(info);
  }

  if (Array.isArray(info?.requested_formats)) {
    candidates.push(
      ...info.requested_formats.filter(
        format => hasVideo(format) && hasAudio(format)
      )
    );
  }

  if (Array.isArray(info?.formats)) {
    candidates.push(
      ...info.formats.filter(
        format => hasVideo(format) && hasAudio(format)
      )
    );
  }

  const unique = new Map();

  for (const format of candidates) {
    if (!format.url) continue;

    const previous = unique.get(format.url);

    if (
      !previous ||
      combinedScore(format) > combinedScore(previous)
    ) {
      unique.set(format.url, format);
    }
  }

  return [...unique.values()]
    .sort((a, b) => combinedScore(b) - combinedScore(a))[0] ||
    null;
}

function normalizeHeaders(value, referer = '') {
  const headers = {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    accept: '*/*',
    'accept-encoding': 'identity'
  };

  if (value && typeof value === 'object') {
    for (const [rawName, rawValue] of Object.entries(value)) {
      const name = String(rawName || '')
        .replace(/[\r\n:]/g, '')
        .trim()
        .toLowerCase();

      const content = String(rawValue || '')
        .replace(/[\r\n]/g, ' ')
        .trim();

      if (name && content) {
        headers[name] = content;
      }
    }
  }

  if (referer && !headers.referer) {
    headers.referer = referer;
  }

  return headers;
}

async function resolveWithYtDlp(item) {
  const sourceUrl = sourceUrlForItem(item);
  const directKind = mediaKindFromUrl(sourceUrl);

  if (
    directKind &&
    item.source_type !== 'okru' &&
    item.source_type !== 'gdrive'
  ) {
    return {
      url: sourceUrl,
      kind: directKind,
      headers: normalizeHeaders({}, sourceUrl),
      extractor: 'direct'
    };
  }

  const selector = [
    'best[vcodec!=none][acodec!=none][vcodec^=avc1][acodec^=mp4a][ext=mp4]',
    'best[vcodec!=none][acodec!=none][vcodec^=avc1][ext=mp4]',
    'best[vcodec!=none][acodec!=none][ext=mp4]',
    'best[vcodec!=none][acodec!=none]'
  ].join('/');

  let result;

  try {
    result = await runCommand(
      'yt-dlp',
      [
        '--dump-single-json',
        '--no-playlist',
        '--no-warnings',
        '--no-progress',
        '--no-check-certificates',
        '--socket-timeout',
        '30',
        '--format',
        selector,
        sourceUrl
      ],
      {
        timeout: RESOLVE_TIMEOUT_MS
      }
    );
  } catch (error) {
    const detail = sanitizeError(
      error.stderr || error.message
    );

    if (item.source_type === 'okru') {
      throw new Error(
        `O OK.ru não entregou uma versão pública com vídeo e áudio juntos. ${detail}`
      );
    }

    if (item.source_type === 'gdrive') {
      throw new Error(
        `O Google Drive não entregou o arquivo original com áudio. ${detail}`
      );
    }

    throw new Error(
      `A fonte não pôde ser resolvida. ${detail}`
    );
  }

  let info;

  try {
    info = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      'O resolvedor retornou uma resposta inválida.'
    );
  }

  let format = selectCombinedFormat(info);

  // Google Drive normalmente entrega o arquivo original em info.url.
  // Alguns extratores não preenchem vcodec/acodec, mas o arquivo original
  // continua contendo vídeo e áudio.
  if (
    !format &&
    item.source_type === 'gdrive' &&
    info?.url
  ) {
    format = {
      ...info,
      url: info.url,
      http_headers:
        info.http_headers ||
        {}
    };
  }

  if (!format) {
    throw new Error(
      'Essa fonte só forneceu vídeo e áudio separados. ' +
      'O player não baixa nem converte arquivos.'
    );
  }

  return {
    url: format.url,
    kind:
      /m3u8|mpegurl/i.test(
        `${format.protocol || ''} ${format.url || ''}`
      )
        ? 'hls'
        : 'video',
    headers: normalizeHeaders(
      format.http_headers || info.http_headers,
      sourceUrl
    ),
    extractor: cleanText(
      info.extractor_key ||
      info.extractor ||
      'yt-dlp',
      120
    )
  };
}

function createSourceId() {
  return crypto.randomBytes(18).toString('hex');
}

function createSourceRecord(resolved) {
  const id = createSourceId();

  sources.set(id, {
    ...resolved,
    id,
    createdAt: Date.now(),
    lastAccess: Date.now(),
    expiresAt: Date.now() + SOURCE_TTL_MS
  });

  return id;
}

function getSource(id) {
  const source = sources.get(String(id || ''));

  if (!source || source.expiresAt < Date.now()) {
    if (source) sources.delete(source.id);

    const error = new Error(
      'O endereço temporário do vídeo expirou.'
    );

    error.status = 410;
    throw error;
  }

  source.lastAccess = Date.now();
  return source;
}

function absoluteUrl(value, baseUrl) {
  try {
    return new URL(
      String(value || '').trim(),
      baseUrl
    ).toString();
  } catch {
    return '';
  }
}

function createChildSource(parent, target) {
  return createSourceRecord({
    url: target,
    kind: mediaKindFromUrl(target) || 'video',
    headers: {
      ...parent.headers,
      referer:
        parent.headers?.referer ||
        parent.url
    },
    extractor: parent.extractor
  });
}

function rewriteHlsPlaylist(text, baseUrl, parentSource) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => {
      if (!line) return line;

      function proxy(value) {
        const target = absoluteUrl(value, baseUrl);
        if (!target) return value;

        const id = createChildSource(
          parentSource,
          target
        );

        return `/api/player-media/${id}`;
      }

      if (!line.startsWith('#')) {
        return proxy(line.trim());
      }

      return line.replace(
        /URI=(?:"([^"]+)"|'([^']+)'|([^,\s]+))/gi,
        (_, quoted, single, bare) => {
          const original =
            quoted ||
            single ||
            bare ||
            '';

          return `URI="${proxy(original)}"`;
        }
      );
    })
    .join('\n');
}

async function proxySource(req, res, source) {
  const headers = {
    ...source.headers,
    accept: req.headers.accept || '*/*',
    'accept-encoding': 'identity'
  };

  if (req.headers.range) {
    headers.range = req.headers.range;
  }

  if (req.headers['if-range']) {
    headers['if-range'] = req.headers['if-range'];
  }

  const result = await safeFetch(source.url, {
    method: req.method === 'HEAD'
      ? 'HEAD'
      : 'GET',
    headers,
    timeout: PROXY_TIMEOUT_MS
  });

  const response = result.response;
  const finalUrl = result.finalUrl.toString();
  const contentType = String(
    response.headers.get('content-type') || ''
  );

  const isHls =
    /mpegurl/i.test(contentType) ||
    /\.m3u8(?:$|[?#])/i.test(finalUrl);

  if (isHls && req.method !== 'HEAD') {
    const playlist = await response.text();
    const rewritten = rewriteHlsPlaylist(
      playlist,
      finalUrl,
      source
    );

    res.status(response.status);
    res.setHeader(
      'Content-Type',
      'application/vnd.apple.mpegurl; charset=utf-8'
    );
    res.setHeader(
      'Cache-Control',
      'private, no-store'
    );
    res.send(rewritten);
    return;
  }

  res.status(response.status);

  const passthroughHeaders = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
    'cache-control'
  ];

  for (const name of passthroughHeaders) {
    const value = response.headers.get(name);

    if (value) {
      res.setHeader(name, value);
    }
  }

  if (
    req.headers.range &&
    !response.headers.get('content-range')
  ) {
    res.removeHeader('content-length');
  }

  res.setHeader(
    'Access-Control-Allow-Origin',
    '*'
  );

  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges'
  );

  res.setHeader(
    'Cross-Origin-Resource-Policy',
    'cross-origin'
  );

  if (
    req.method === 'HEAD' ||
    !response.body
  ) {
    res.end();
    return;
  }

  Readable.fromWeb(response.body).pipe(res);
}

function registerUniversalPlayerRoutes(app, options) {
  const { findTitle } = options;

  app.get('/api/player-health', async (req, res) => {
    const ytdlp = await commandExists('yt-dlp');

    res.json({
      ok: ytdlp,
      ytdlp,
      mode: 'direct-streaming',
      converter: false,
      downloads_before_play: false,
      sources: sources.size
    });
  });

  app.get('/api/player-source/:id', async (req, res, next) => {
    try {
      const item = await findTitle(req.params.id, true);

      if (!item) {
        return res.status(404).json({
          error: 'Conteúdo não encontrado.'
        });
      }

      const resolved = await resolveWithYtDlp(item);
      const sourceId = createSourceRecord(resolved);

      res.setHeader('Cache-Control', 'no-store');

      res.json({
        player: 'universal-video',
        mode: 'direct-streaming',
        kind: resolved.kind,
        url: `/api/player-media/${sourceId}`,
        poster:
          item.episode_image_url ||
          item.backdrop_url ||
          item.cover_url ||
          ''
      });
    } catch (error) {
      error.status =
        error.status ||
        (
          /inválid|não possui|não encontr/i.test(
            error.message || ''
          )
            ? 400
            : 422
        );

      next(error);
    }
  });

  async function mediaProxy(req, res, next) {
    try {
      const source = getSource(
        req.params.source
      );

      await proxySource(
        req,
        res,
        source
      );
    } catch (error) {
      next(error);
    }
  }

  app.get(
    '/api/player-media/:source',
    mediaProxy
  );

  app.head(
    '/api/player-media/:source',
    mediaProxy
  );
}

setInterval(() => {
  const now = Date.now();

  for (const source of sources.values()) {
    if (
      source.expiresAt < now ||
      now - source.lastAccess > SOURCE_TTL_MS
    ) {
      sources.delete(source.id);
    }
  }
}, 10 * 60 * 1000).unref();

module.exports = {
  registerUniversalPlayerRoutes,
  selectCombinedFormat,
  sourceUrlForItem,
  mediaKindFromUrl,
  rewriteHlsPlaylist,
  normalizeHeaders
};
