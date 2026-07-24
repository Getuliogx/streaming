'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PLAYER_ROOT =
  process.env.PLAYER_CACHE_DIR ||
  path.join(os.tmpdir(), 'minha-stream-unified-player');

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const FAILED_SESSION_TTL_MS = 60 * 1000;
const READY_TIMEOUT_MS = 120 * 1000;
const COMMAND_TIMEOUT_MS = 75 * 1000;
const MAX_COMMAND_OUTPUT = 24 * 1024 * 1024;
const MAX_ACTIVE_TRANSCODERS = Math.max(
  1,
  Math.min(3, Number(process.env.PLAYER_MAX_TRANSCODERS || 2))
);

const sessions = new Map();
const transcoderQueue = [];
let activeTranscoders = 0;

function cleanText(value, max = 12000) {
  return String(value ?? '').trim().slice(0, max);
}

function sanitizeError(value) {
  const text = cleanText(value, 1600)
    .replace(/https?:\/\/\S+/gi, '[endereço removido]')
    .replace(/\s+/g, ' ')
    .trim();

  return text || 'Não foi possível preparar o vídeo.';
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
    }, options.timeout || COMMAND_TIMEOUT_MS);

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
        resolve({
          stdout,
          stderr
        });
        return;
      }

      const error = new Error(
        killedForSize
          ? `${command} retornou dados demais.`
          : `${command} terminou com código ${code}. ${stderr}`
      );

      error.command = command;
      error.code = code;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function acquireTranscoderSlot() {
  if (activeTranscoders < MAX_ACTIVE_TRANSCODERS) {
    activeTranscoders += 1;
    return Promise.resolve();
  }

  return new Promise(resolve => {
    transcoderQueue.push(resolve);
  }).then(() => {
    activeTranscoders += 1;
  });
}

function releaseTranscoderSlot() {
  activeTranscoders = Math.max(0, activeTranscoders - 1);
  const next = transcoderQueue.shift();
  if (next) next();
}

async function withTranscoderSlot(task) {
  await acquireTranscoderSlot();

  try {
    return await task();
  } finally {
    releaseTranscoderSlot();
  }
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
      throw new Error('O código do arquivo do Google Drive é inválido.');
    }

    return `https://drive.google.com/file/d/${match[1]}/view`;
  }

  return source;
}

function directMediaKind(value) {
  const text = String(value || '').toLowerCase();

  if (/\.m3u8(?:$|[?#])/.test(text)) return 'hls';

  if (
    /\.(?:mp4|m4v|webm|ogv|ogg|mov|mkv|mp3|m4a|aac)(?:$|[?#])/.test(text)
  ) {
    return 'direct';
  }

  return '';
}

function normalizeHeaders(value) {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
  };

  if (value && typeof value === 'object') {
    for (const [name, content] of Object.entries(value)) {
      const safeName = String(name || '').replace(/[\r\n:]/g, '').trim();
      const safeValue = String(content || '').replace(/[\r\n]/g, ' ').trim();

      if (safeName && safeValue) {
        headers[safeName] = safeValue;
      }
    }
  }

  return headers;
}

function headerBlock(headers) {
  return Object.entries(normalizeHeaders(headers))
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('');
}

function formatHeight(format) {
  const height = Number(format?.height || 0);
  const width = Number(format?.width || 0);
  const bitrate = Number(format?.tbr || format?.vbr || 0);

  return height * 1_000_000 + width * 1_000 + bitrate;
}

function formatAudioScore(format) {
  const bitrate = Number(format?.abr || format?.tbr || 0);
  const channels = Number(format?.audio_channels || 0);
  const preferredCodec = /^(?:mp4a|aac)/i.test(format?.acodec || '') ? 10000 : 0;

  return preferredCodec + channels * 1000 + bitrate;
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

function selectInputsFromInfo(info) {
  const requested = Array.isArray(info?.requested_formats)
    ? info.requested_formats
    : [];

  const allFormats = [
    ...requested,
    ...(Array.isArray(info?.formats) ? info.formats : [])
  ].filter(format => format && format.url);

  const combinedRequested = requested.find(
    format => hasVideo(format) && hasAudio(format)
  );

  if (combinedRequested) {
    return {
      video: combinedRequested,
      audio: null,
      combined: true
    };
  }

  const requestedVideo = requested.find(hasVideo);
  const requestedAudio = requested.find(
    format => hasAudio(format) && !hasVideo(format)
  );

  if (requestedVideo && requestedAudio) {
    return {
      video: requestedVideo,
      audio: requestedAudio,
      combined: false
    };
  }

  if (info?.url && hasVideo(info)) {
    if (hasAudio(info)) {
      return {
        video: info,
        audio: null,
        combined: true
      };
    }
  }

  const combined = allFormats
    .filter(format => hasVideo(format) && hasAudio(format))
    .sort((a, b) => formatHeight(b) - formatHeight(a))[0];

  if (combined) {
    return {
      video: combined,
      audio: null,
      combined: true
    };
  }

  const video = allFormats
    .filter(hasVideo)
    .sort((a, b) => {
      const aH264 = /^(?:avc1|h264)/i.test(a.vcodec || '') ? 1 : 0;
      const bH264 = /^(?:avc1|h264)/i.test(b.vcodec || '') ? 1 : 0;

      return bH264 - aH264 || formatHeight(b) - formatHeight(a);
    })[0];

  const audio = allFormats
    .filter(format => hasAudio(format) && !hasVideo(format))
    .sort((a, b) => formatAudioScore(b) - formatAudioScore(a))[0];

  if (!video) {
    throw new Error('A fonte não forneceu uma faixa de vídeo.');
  }

  return {
    video,
    audio: audio || null,
    combined: Boolean(hasAudio(video))
  };
}

async function resolveWithYtDlp(item) {
  const sourceUrl = sourceUrlForItem(item);
  const directKind = directMediaKind(sourceUrl);

  if (
    (item.source_type === 'direct' || item.source_type === 'hls') &&
    directKind
  ) {
    return {
      sourceUrl,
      video: {
        url: sourceUrl,
        vcodec: '',
        acodec: '',
        http_headers: {}
      },
      audio: null,
      combined: true,
      extractor: 'direct'
    };
  }

  const selector = [
    'bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]',
    'bestvideo[vcodec^=avc1]+bestaudio',
    'bestvideo[ext=mp4]+bestaudio',
    'bestvideo+bestaudio',
    'best[ext=mp4]',
    'best'
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
        '35',
        '--format',
        selector,
        sourceUrl
      ],
      {
        timeout: COMMAND_TIMEOUT_MS
      }
    );
  } catch (error) {
    const detail = sanitizeError(error.stderr || error.message);

    if (item.source_type === 'okru') {
      throw new Error(
        `O OK.ru não liberou o vídeo público para reprodução. ${detail}`
      );
    }

    if (item.source_type === 'gdrive') {
      throw new Error(
        `O Google Drive não liberou o arquivo público. ${detail}`
      );
    }

    throw new Error(`A fonte não pôde ser resolvida. ${detail}`);
  }

  let info;

  try {
    info = JSON.parse(result.stdout);
  } catch {
    throw new Error('O resolvedor de mídia retornou uma resposta inválida.');
  }

  const selected = selectInputsFromInfo(info);

  return {
    sourceUrl,
    ...selected,
    extractor: cleanText(info.extractor_key || info.extractor || 'yt-dlp', 120)
  };
}

function inputArguments(input, fallbackReferer = '') {
  if (!input?.url) return [];

  const headers = normalizeHeaders(input.http_headers);

  if (
    fallbackReferer &&
    !headers.Referer &&
    !headers.referer
  ) {
    headers.Referer = fallbackReferer;
  }

  return [
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '5',
    '-headers',
    headerBlock(headers),
    '-i',
    input.url
  ];
}

function h264Compatible(value) {
  return /^(?:avc1|h264)/i.test(String(value || ''));
}

function buildFfmpegArguments(resolved, sessionDir, forceVideoTranscode = false) {
  const playlistPath = path.join(sessionDir, 'index.m3u8');
  const segmentPattern = path.join(sessionDir, 'segment-%06d.ts');

  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-y'
  ];

  args.push(
    ...inputArguments(resolved.video, resolved.sourceUrl)
  );

  if (resolved.audio) {
    args.push(
      ...inputArguments(resolved.audio, resolved.sourceUrl)
    );
  }

  args.push(
    '-map',
    '0:v:0'
  );

  if (resolved.audio) {
    args.push(
      '-map',
      '1:a:0'
    );
  } else {
    args.push(
      '-map',
      '0:a:0?'
    );
  }

  const copyVideo =
    !forceVideoTranscode &&
    h264Compatible(resolved.video?.vcodec);

  if (copyVideo) {
    args.push(
      '-c:v',
      'copy'
    );
  } else {
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '22',
      '-pix_fmt',
      'yuv420p'
    );
  }

  // O áudio é sempre convertido para AAC. Isso corrige Drive sem som
  // e também combina a faixa de áudio separada do OK.ru.
  args.push(
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-ac',
    '2',
    '-ar',
    '48000',
    '-max_muxing_queue_size',
    '4096',
    '-f',
    'hls',
    '-hls_time',
    '4',
    '-hls_list_size',
    '0',
    '-hls_playlist_type',
    'event',
    '-hls_flags',
    'independent_segments+temp_file',
    '-hls_segment_filename',
    segmentPattern,
    playlistPath
  );

  return args;
}

function sessionKey(item) {
  return crypto
    .createHash('sha256')
    .update(
      `${item.id}\n${item.source_type}\n${item.source_url}`
    )
    .digest('hex')
    .slice(0, 24);
}

async function removeSession(session) {
  if (!session) return;

  if (session.process && !session.process.killed) {
    try {
      session.process.kill('SIGKILL');
    } catch {}
  }

  sessions.delete(session.key);

  try {
    await fsp.rm(session.dir, {
      recursive: true,
      force: true
    });
  } catch {}
}

async function waitForPlaylist(session, timeout = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (session.status === 'error') {
      throw new Error(session.error || 'Não foi possível gerar o vídeo.');
    }

    try {
      const stats = await fsp.stat(
        path.join(session.dir, 'index.m3u8')
      );

      if (stats.size > 40) {
        session.status = 'ready';
        session.lastAccess = Date.now();
        return;
      }
    } catch {}

    if (
      session.ffmpegExited &&
      session.status !== 'ready'
    ) {
      throw new Error(
        session.error ||
        'O FFmpeg não conseguiu gerar a reprodução.'
      );
    }

    await new Promise(resolve => setTimeout(resolve, 350));
  }

  throw new Error('O vídeo demorou demais para ficar pronto.');
}

function startFfmpeg(session, resolved, forceVideoTranscode) {
  return new Promise((resolve, reject) => {
    const args = buildFfmpegArguments(
      resolved,
      session.dir,
      forceVideoTranscode
    );

    const child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    });

    session.process = child;
    session.ffmpegExited = false;
    session.ffmpegLog = '';

    child.stderr.on('data', chunk => {
      session.ffmpegLog = (
        session.ffmpegLog + chunk.toString('utf8')
      ).slice(-12000);
    });

    child.once('error', error => {
      session.ffmpegExited = true;
      session.error = sanitizeError(error.message);
      reject(error);
    });

    child.once('exit', code => {
      session.ffmpegExited = true;

      if (code === 0) {
        resolve();
        return;
      }

      const message = sanitizeError(session.ffmpegLog);
      session.error =
        `O conversor de vídeo terminou com erro. ${message}`;

      const error = new Error(session.error);
      error.code = code;
      reject(error);
    });
  });
}

async function prepareSession(session, item) {
  await withTranscoderSlot(async () => {
    session.status = 'resolving';
    session.lastAccess = Date.now();

    const resolved = await resolveWithYtDlp(item);
    session.resolved = resolved;

    session.status = 'transcoding';

    let ffmpegPromise = startFfmpeg(
      session,
      resolved,
      false
    );

    ffmpegPromise.catch(() => {});

    try {
      await waitForPlaylist(session, 55_000);
    } catch (firstError) {
      if (session.process && !session.process.killed) {
        try {
          session.process.kill('SIGKILL');
        } catch {}
      }

      await new Promise(resolve => setTimeout(resolve, 500));

      session.status = 'transcoding';
      session.ffmpegExited = false;
      session.error = '';
      session.ffmpegLog = '';

      await fsp.rm(session.dir, {
        recursive: true,
        force: true
      });

      await fsp.mkdir(session.dir, {
        recursive: true
      });

      // Segunda tentativa converte também o vídeo para H.264.
      ffmpegPromise = startFfmpeg(
        session,
        resolved,
        true
      );

      ffmpegPromise.catch(() => {});

      await waitForPlaylist(session, 65_000);
    }

    ffmpegPromise.catch(error => {
      if (session.status !== 'ready') {
        session.status = 'error';
        session.error = sanitizeError(
          error.message || session.ffmpegLog
        );
      }
    });

    session.status = 'ready';
    session.lastAccess = Date.now();
  });
}

async function createOrGetSession(item) {
  const key = sessionKey(item);
  const previous = sessions.get(key);

  if (previous) {
    previous.lastAccess = Date.now();

    if (previous.status === 'ready') {
      return previous;
    }

    if (
      previous.status === 'error' &&
      Date.now() - previous.createdAt > FAILED_SESSION_TTL_MS
    ) {
      await removeSession(previous);
    } else {
      await previous.promise;
      return previous;
    }
  }

  const dir = path.join(PLAYER_ROOT, key);

  await fsp.rm(dir, {
    recursive: true,
    force: true
  });

  await fsp.mkdir(dir, {
    recursive: true
  });

  const session = {
    key,
    dir,
    status: 'queued',
    error: '',
    createdAt: Date.now(),
    lastAccess: Date.now(),
    process: null,
    ffmpegExited: false,
    ffmpegLog: '',
    promise: null
  };

  sessions.set(key, session);

  session.promise = prepareSession(session, item)
    .catch(error => {
      session.status = 'error';
      session.error = sanitizeError(
        error.message || session.ffmpegLog
      );
      throw error;
    });

  await session.promise;
  return session;
}

function mediaType(filename) {
  if (filename.endsWith('.m3u8')) {
    return 'application/vnd.apple.mpegurl; charset=utf-8';
  }

  if (filename.endsWith('.ts')) {
    return 'video/mp2t';
  }

  return 'application/octet-stream';
}

function registerUniversalPlayerRoutes(app, options) {
  const {
    findTitle
  } = options;

  app.get('/api/player-health', async (req, res) => {
    const [ffmpeg, ytdlp] = await Promise.all([
      commandExists('ffmpeg'),
      commandExists('yt-dlp')
    ]);

    res.json({
      ok: ffmpeg && ytdlp,
      ffmpeg,
      ytdlp,
      active: activeTranscoders,
      queued: transcoderQueue.length,
      sessions: sessions.size
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

      const session = await createOrGetSession(item);

      res.setHeader('Cache-Control', 'no-store');

      res.json({
        player: 'universal-video',
        kind: 'hls',
        url:
          `/api/player-hls/${session.key}/index.m3u8`,
        poster:
          item.episode_image_url ||
          item.backdrop_url ||
          item.cover_url ||
          ''
      });
    } catch (error) {
      const message = sanitizeError(error.message);

      error.status =
        /inválid|não possui|não encontr/i.test(message)
          ? 400
          : 422;

      error.message = message;
      next(error);
    }
  });

  app.get('/api/player-hls/:session/:filename', async (req, res, next) => {
    try {
      const session = sessions.get(req.params.session);
      const filename = String(req.params.filename || '');

      if (
        !session ||
        !/^(?:index\.m3u8|segment-\d{6}\.ts)$/.test(filename)
      ) {
        return res.status(404).end();
      }

      const file = path.join(session.dir, filename);
      const resolved = path.resolve(file);

      if (
        !resolved.startsWith(
          `${path.resolve(session.dir)}${path.sep}`
        )
      ) {
        return res.status(403).end();
      }

      await fsp.access(file);
      session.lastAccess = Date.now();

      res.setHeader('Content-Type', mediaType(filename));

      if (filename.endsWith('.m3u8')) {
        res.setHeader(
          'Cache-Control',
          'no-store, no-cache, must-revalidate'
        );
      } else {
        res.setHeader(
          'Cache-Control',
          'private, max-age=120'
        );
      }

      res.sendFile(resolved);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).end();
      }

      next(error);
    }
  });
}

setInterval(() => {
  const now = Date.now();

  for (const session of sessions.values()) {
    const ttl =
      session.status === 'error'
        ? FAILED_SESSION_TTL_MS
        : SESSION_TTL_MS;

    if (now - session.lastAccess > ttl) {
      removeSession(session).catch(() => {});
    }
  }
}, 5 * 60 * 1000).unref();

fsp.mkdir(PLAYER_ROOT, {
  recursive: true
}).catch(() => {});

module.exports = {
  registerUniversalPlayerRoutes,
  selectInputsFromInfo,
  buildFfmpegArguments,
  sourceUrlForItem,
  h264Compatible
};
