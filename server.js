'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs/promises');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const DATA_FILE = path.join(__dirname, 'data', 'catalog.json');
const GITHUB_API = 'https://api.github.com';
const GITHUB_TOKEN = String(process.env.GITHUB_TOKEN || '').trim();
const GITHUB_REPO = String(process.env.GITHUB_REPO || '').trim();
const GITHUB_CATALOG_BRANCH = String(process.env.GITHUB_CATALOG_BRANCH || 'catalogo').trim();
const GITHUB_CATALOG_PATH = String(process.env.GITHUB_CATALOG_PATH || 'data/catalog.json').trim();
const TMDB_API_KEY = String(process.env.TMDB_API_KEY || '').trim();
const TMDB_READ_TOKEN = String(process.env.TMDB_READ_TOKEN || '').trim();
const TMDB_LANGUAGE = String(process.env.TMDB_LANGUAGE || 'pt-BR').trim();
const HAS_GITHUB_STORAGE = Boolean(GITHUB_TOKEN && /^[^/\s]+\/[^/\s]+$/.test(GITHUB_REPO));
const HAS_TMDB = Boolean(TMDB_API_KEY || TMDB_READ_TOKEN);
const ALLOWED_CONTENT_TYPES = new Set(['movie', 'episode']);
const ALLOWED_SOURCE_TYPES = new Set(['okru', 'gdrive', 'direct', 'hls', 'iframe']);
const ALLOWED_TMDB_TYPES = new Set(['movie', 'tv']);
const MAX_PLAYLIST_ITEMS = 1500;

let catalogCache = null;
let catalogCacheTime = 0;
let resolvedCatalogBranch = null;
let mutationQueue = Promise.resolve();

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:', 'http:'],
      mediaSrc: ["'self'", 'blob:', 'https:', 'http:'],
      frameSrc: ["'self'", 'https:', 'http:'],
      connectSrc: ["'self'", 'https:', 'http:'],
      fontSrc: ["'self'", 'data:']
    }
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(compression());
app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(session({
  name: 'stream_admin',
  secret: process.env.SESSION_SECRET || GITHUB_TOKEN || process.env.ADMIN_PASSWORD || 'troque-esta-chave-local',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 8
  }
}));
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos.' }
});

function cleanText(value, max = 5000) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanNullableInt(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function cleanHttpUrl(value, max = 4000) {
  const text = cleanText(value, max);
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function detectSourceType(url) {
  const value = String(url || '').toLowerCase();
  if (value.includes('ok.ru/')) return 'okru';
  if (value.includes('drive.google.com/') || value.includes('docs.google.com/')) return 'gdrive';
  if (/\.m3u8(?:$|[?#])/i.test(value)) return 'hls';
  if (/\.(?:mp4|m4v|webm|ogv|ogg|mov|mp3|m4a|aac)(?:$|[?#])/i.test(value)) return 'direct';
  return 'iframe';
}

function normalizeTitle(body) {
  const sourceUrlRaw = cleanText(body.source_url, 4000);
  const sourceUrl = cleanHttpUrl(sourceUrlRaw, 4000);
  const contentType = cleanText(body.content_type, 20) || 'movie';
  const requestedSourceType = cleanText(body.source_type, 20);
  const sourceType = ALLOWED_SOURCE_TYPES.has(requestedSourceType)
    ? requestedSourceType
    : detectSourceType(sourceUrl);

  const tmdbType = ALLOWED_TMDB_TYPES.has(cleanText(body.tmdb_type, 20))
    ? cleanText(body.tmdb_type, 20)
    : '';

  const record = {
    title: cleanText(body.title, 180),
    series_title: cleanText(body.series_title, 180),
    description: cleanText(body.description, 5000),
    year: cleanNullableInt(body.year),
    genres: cleanText(body.genres, 300),
    cover_url: cleanHttpUrl(body.cover_url, 2000),
    backdrop_url: cleanHttpUrl(body.backdrop_url, 2000),
    content_type: contentType,
    season: cleanNullableInt(body.season),
    episode: cleanNullableInt(body.episode),
    source_type: sourceType,
    source_url: sourceUrl,
    tmdb_id: cleanNullableInt(body.tmdb_id),
    tmdb_type: tmdbType,
    featured: Boolean(body.featured),
    published: body.published !== false
  };

  if (!record.title) throw new Error('Digite o título.');
  if (!sourceUrlRaw) throw new Error('Cole o link do vídeo.');
  if (!record.source_url) throw new Error('O link do vídeo precisa começar com http:// ou https://.');
  if (!ALLOWED_CONTENT_TYPES.has(record.content_type)) throw new Error('Tipo de conteúdo inválido.');
  if (record.content_type === 'episode' && !record.series_title) {
    throw new Error('Digite o nome da série para cadastrar um episódio.');
  }
  return record;
}

async function ensureDataFile() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, '[]\n', 'utf8');
  }
}

function parseCatalog(raw) {
  const parsed = JSON.parse(raw || '[]');
  if (!Array.isArray(parsed)) throw new Error('O catálogo não está em formato válido.');
  return parsed;
}

async function readLocalCatalog() {
  await ensureDataFile();
  return parseCatalog(await fs.readFile(DATA_FILE, 'utf8'));
}

async function writeLocalCatalog(items) {
  await fs.writeFile(DATA_FILE, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}

async function githubRequest(endpoint, options = {}) {
  const response = await fetch(`${GITHUB_API}${endpoint}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'minha-stream-simples',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `Erro do GitHub (${response.status}).`);
    error.status = response.status;
    error.source = 'github';
    error.githubBody = body;
    throw error;
  }
  return body;
}

async function ensureCatalogBranch() {
  if (resolvedCatalogBranch) return resolvedCatalogBranch;

  const repository = await githubRequest(`/repos/${GITHUB_REPO}`);
  const defaultBranch = repository.default_branch || 'main';

  try {
    await githubRequest(`/repos/${GITHUB_REPO}/git/ref/heads/${encodeURIComponent(GITHUB_CATALOG_BRANCH)}`);
    resolvedCatalogBranch = GITHUB_CATALOG_BRANCH;
    return resolvedCatalogBranch;
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  const sourceRef = await githubRequest(`/repos/${GITHUB_REPO}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
  await githubRequest(`/repos/${GITHUB_REPO}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({
      ref: `refs/heads/${GITHUB_CATALOG_BRANCH}`,
      sha: sourceRef.object.sha
    })
  });

  resolvedCatalogBranch = GITHUB_CATALOG_BRANCH;
  return resolvedCatalogBranch;
}

async function readGitHubCatalogRecord() {
  const branch = await ensureCatalogBranch();
  try {
    const file = await githubRequest(
      `/repos/${GITHUB_REPO}/contents/${GITHUB_CATALOG_PATH.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`
    );
    const raw = Buffer.from(String(file.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
    return { items: parseCatalog(raw), sha: file.sha || null, branch };
  } catch (error) {
    if (error.status === 404) return { items: [], sha: null, branch };
    throw error;
  }
}

async function writeGitHubCatalog(items, sha, branch, message) {
  const body = {
    message,
    content: Buffer.from(`${JSON.stringify(items, null, 2)}\n`, 'utf8').toString('base64'),
    branch
  };
  if (sha) body.sha = sha;

  await githubRequest(
    `/repos/${GITHUB_REPO}/contents/${GITHUB_CATALOG_PATH.split('/').map(encodeURIComponent).join('/')}`,
    { method: 'PUT', body: JSON.stringify(body) }
  );
}

async function readCatalog({ force = false } = {}) {
  const now = Date.now();
  if (!force && catalogCache && now - catalogCacheTime < 30_000) return structuredClone(catalogCache);

  const items = HAS_GITHUB_STORAGE
    ? (await readGitHubCatalogRecord()).items
    : await readLocalCatalog();

  catalogCache = items;
  catalogCacheTime = now;
  return structuredClone(items);
}

function queueMutation(work) {
  const run = mutationQueue.then(work, work);
  mutationQueue = run.catch(() => {});
  return run;
}

async function mutateCatalog(message, mutator) {
  return queueMutation(async () => {
    if (HAS_GITHUB_STORAGE) {
      const record = await readGitHubCatalogRecord();
      const result = await mutator(record.items);
      await writeGitHubCatalog(record.items, record.sha, record.branch, message);
      catalogCache = record.items;
      catalogCacheTime = Date.now();
      return result;
    }

    const items = await readLocalCatalog();
    const result = await mutator(items);
    await writeLocalCatalog(items);
    catalogCache = items;
    catalogCacheTime = Date.now();
    return result;
  });
}

async function listTitles({ publishedOnly = false, search = '' } = {}) {
  let items = await readCatalog();
  if (publishedOnly) items = items.filter(item => item.published !== false);
  if (search) {
    const needle = search.toLocaleLowerCase('pt-BR');
    items = items.filter(item => [item.title, item.series_title, item.genres]
      .some(value => String(value || '').toLocaleLowerCase('pt-BR').includes(needle)));
  }
  return items.sort((a, b) => Number(b.featured) - Number(a.featured) || Number(b.id) - Number(a.id));
}

async function findTitle(id, publishedOnly = false) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId < 1) return null;
  const items = await readCatalog();
  return items.find(item => Number(item.id) === numericId && (!publishedOnly || item.published !== false)) || null;
}

async function findSeries(seriesTitle, publishedOnly = true) {
  const normalized = cleanText(seriesTitle, 180).toLocaleLowerCase('pt-BR');
  if (!normalized) return [];
  const items = await readCatalog();
  return items
    .filter(item => item.content_type === 'episode'
      && String(item.series_title || '').trim().toLocaleLowerCase('pt-BR') === normalized
      && (!publishedOnly || item.published !== false))
    .sort((a, b) => (Number(a.season) || 0) - (Number(b.season) || 0)
      || (Number(a.episode) || 0) - (Number(b.episode) || 0)
      || Number(a.id) - Number(b.id));
}

async function createTitle(record) {
  return mutateCatalog(`Adicionar: ${record.title}`, items => {
    const nextId = items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
    const now = new Date().toISOString();
    const created = { id: nextId, ...record, created_at: now, updated_at: now };
    items.push(created);
    return created;
  });
}

async function createManyTitles(records) {
  return mutateCatalog(`Importar playlist: ${records.length} itens`, items => {
    let nextId = items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
    const existingUrls = new Set(items.map(item => String(item.source_url || '').trim()).filter(Boolean));
    const now = new Date().toISOString();
    const created = [];
    let skipped = 0;

    for (const record of records) {
      if (existingUrls.has(record.source_url)) {
        skipped += 1;
        continue;
      }
      const item = { id: nextId++, ...record, created_at: now, updated_at: now };
      items.push(item);
      created.push(item);
      existingUrls.add(record.source_url);
    }
    return { added: created.length, skipped, items: created };
  });
}

async function updateTitle(id, record) {
  const numericId = Number(id);
  return mutateCatalog(`Editar: ${record.title}`, items => {
    const index = items.findIndex(item => Number(item.id) === numericId);
    if (index === -1) return null;
    items[index] = { ...items[index], ...record, id: numericId, updated_at: new Date().toISOString() };
    return items[index];
  });
}

async function deleteTitle(id) {
  const numericId = Number(id);
  return mutateCatalog('Excluir conteúdo', items => {
    const index = items.findIndex(item => Number(item.id) === numericId);
    if (index === -1) return false;
    items.splice(index, 1);
    return true;
  });
}

function parseM3UAttributes(line) {
  const attributes = {};
  const regex = /([\w-]+)="([^"]*)"/g;
  let match;
  while ((match = regex.exec(line))) attributes[match[1].toLowerCase()] = match[2].trim();
  return attributes;
}

function parseEpisodeInfo(rawTitle) {
  const title = cleanText(rawTitle, 180);
  const patterns = [
    /\bS(\d{1,3})\s*E(\d{1,4})\b/i,
    /\b(\d{1,3})\s*x\s*(\d{1,4})\b/i,
    /\bT(?:EMPORADA)?\s*(\d{1,3}).{0,12}\bE(?:P(?:IS[ÓO]DIO)?)?\s*(\d{1,4})\b/i
  ];
  const match = patterns.map(pattern => title.match(pattern)).find(Boolean);
  if (!match) return null;

  const before = title.slice(0, match.index).replace(/[._\-–—]+/g, ' ').trim();
  const after = title.slice((match.index || 0) + match[0].length).replace(/^[\s._\-–—:]+/, '').trim();
  return {
    seriesTitle: before,
    season: Number(match[1]),
    episode: Number(match[2]),
    episodeTitle: after || `Episódio ${Number(match[2])}`
  };
}

function parsePlaylist(content, defaults = {}) {
  const text = String(content || '').replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('A playlist está vazia.');
  if (/#EXT-X-(?:TARGETDURATION|MEDIA-SEQUENCE|STREAM-INF)/i.test(text)) {
    throw new Error('Esse arquivo é uma playlist HLS de um único vídeo, não uma lista de filmes/episódios para importar.');
  }

  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const entries = [];
  let pending = null;

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      const attributes = parseM3UAttributes(line);
      const commaIndex = line.indexOf(',');
      pending = {
        title: cleanText(commaIndex >= 0 ? line.slice(commaIndex + 1) : attributes['tvg-name'], 180),
        cover_url: cleanHttpUrl(attributes['tvg-logo'], 2000),
        group_title: cleanText(attributes['group-title'], 300)
      };
      continue;
    }
    if (line.startsWith('#')) continue;

    const sourceUrl = cleanHttpUrl(line, 4000);
    if (!sourceUrl) {
      pending = null;
      continue;
    }
    entries.push({ ...(pending || {}), source_url: sourceUrl });
    pending = null;
    if (entries.length >= MAX_PLAYLIST_ITEMS) break;
  }

  if (!entries.length) throw new Error('Nenhum link http:// ou https:// foi encontrado na playlist.');

  const defaultSeries = cleanText(defaults.series_title, 180);
  const defaultContentType = defaultSeries ? 'episode' : cleanText(defaults.content_type, 20);
  const defaultRecord = {
    description: cleanText(defaults.description, 5000),
    year: cleanNullableInt(defaults.year),
    genres: cleanText(defaults.genres, 300),
    cover_url: cleanHttpUrl(defaults.cover_url, 2000),
    backdrop_url: cleanHttpUrl(defaults.backdrop_url, 2000),
    tmdb_id: cleanNullableInt(defaults.tmdb_id),
    tmdb_type: ALLOWED_TMDB_TYPES.has(cleanText(defaults.tmdb_type, 20)) ? cleanText(defaults.tmdb_type, 20) : '',
    featured: false,
    published: defaults.published !== false
  };

  return entries.map((entry, index) => {
    const rawTitle = entry.title || `Vídeo ${index + 1}`;
    const episodeInfo = parseEpisodeInfo(rawTitle);
    const isEpisode = Boolean(defaultSeries || episodeInfo || defaultContentType === 'episode');
    const seriesTitle = defaultSeries || episodeInfo?.seriesTitle || '';
    const contentType = isEpisode && seriesTitle ? 'episode' : 'movie';

    return normalizeTitle({
      ...defaultRecord,
      title: contentType === 'episode' ? (episodeInfo?.episodeTitle || rawTitle) : rawTitle,
      series_title: contentType === 'episode' ? seriesTitle : '',
      content_type: contentType,
      season: contentType === 'episode' ? (episodeInfo?.season ?? cleanNullableInt(defaults.season) ?? (defaultSeries ? 1 : null)) : null,
      episode: contentType === 'episode' ? (episodeInfo?.episode ?? (defaultSeries ? index + 1 : null)) : null,
      genres: defaultRecord.genres || entry.group_title,
      cover_url: defaultRecord.cover_url || entry.cover_url,
      source_url: entry.source_url,
      source_type: detectSourceType(entry.source_url),
      published: defaultRecord.published
    });
  });
}

async function tmdbRequest(pathname, params = {}) {
  if (!HAS_TMDB) {
    const error = new Error('Configure TMDB_API_KEY no Render para usar a busca de capas.');
    error.status = 503;
    throw error;
  }

  const url = new URL(`https://api.themoviedb.org/3${pathname}`);
  url.searchParams.set('language', TMDB_LANGUAGE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  if (TMDB_API_KEY && !TMDB_READ_TOKEN) url.searchParams.set('api_key', TMDB_API_KEY);

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      ...(TMDB_READ_TOKEN ? { Authorization: `Bearer ${TMDB_READ_TOKEN}` } : {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.status_message || `Erro do TMDB (${response.status}).`);
    error.status = response.status;
    error.source = 'tmdb';
    throw error;
  }
  return body;
}

function tmdbImage(pathname, size = 'w500') {
  return pathname ? `https://image.tmdb.org/t/p/${size}${pathname}` : '';
}

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  return res.status(401).json({ error: 'Entre com a senha do painel.' });
}

function storageLabel() {
  return HAS_GITHUB_STORAGE ? 'github' : 'local';
}

app.get('/health', (req, res) => res.json({ ok: true, storage: storageLabel(), tmdb: HAS_TMDB }));

app.get('/api/catalog', async (req, res, next) => {
  try {
    const search = cleanText(req.query.search, 120);
    res.json(await listTitles({ publishedOnly: true, search }));
  } catch (error) { next(error); }
});

app.get('/api/series', async (req, res, next) => {
  try {
    const episodes = await findSeries(req.query.title, true);
    if (!episodes.length) return res.status(404).json({ error: 'Série não encontrada.' });
    res.json({ title: episodes[0].series_title, episodes });
  } catch (error) { next(error); }
});

app.get('/api/catalog/:id', async (req, res, next) => {
  try {
    const item = await findTitle(req.params.id, true);
    if (!item) return res.status(404).json({ error: 'Conteúdo não encontrado.' });
    res.json(item);
  } catch (error) { next(error); }
});

app.get('/api/admin/session', (req, res) => {
  res.json({
    authenticated: Boolean(req.session?.isAdmin),
    storage: storageLabel(),
    githubConfigured: HAS_GITHUB_STORAGE,
    tmdbConfigured: HAS_TMDB
  });
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const configuredPassword = process.env.ADMIN_PASSWORD;
  if (!configuredPassword) {
    return res.status(503).json({ error: 'Configure ADMIN_PASSWORD no Render.' });
  }
  if (String(req.body.password || '') !== configuredPassword) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }
  req.session.isAdmin = true;
  res.json({ ok: true });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/titles', requireAdmin, async (req, res, next) => {
  try { res.json(await listTitles()); } catch (error) { next(error); }
});

app.get('/api/admin/tmdb/search', requireAdmin, async (req, res, next) => {
  try {
    const query = cleanText(req.query.q, 180);
    const requestedType = cleanText(req.query.type, 20);
    if (query.length < 2) return res.status(400).json({ error: 'Digite pelo menos 2 letras para buscar.' });
    const endpoint = requestedType === 'movie' || requestedType === 'tv'
      ? `/search/${requestedType}`
      : '/search/multi';
    const data = await tmdbRequest(endpoint, { query, include_adult: 'false', page: 1 });
    const results = (data.results || [])
      .map(item => {
        const mediaType = requestedType === 'movie' || requestedType === 'tv' ? requestedType : item.media_type;
        if (!ALLOWED_TMDB_TYPES.has(mediaType)) return null;
        const date = item.release_date || item.first_air_date || '';
        return {
          id: item.id,
          media_type: mediaType,
          title: item.title || item.name || 'Sem título',
          year: /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null,
          overview: item.overview || '',
          cover_url: tmdbImage(item.poster_path, 'w342'),
          backdrop_url: tmdbImage(item.backdrop_path, 'w780')
        };
      })
      .filter(Boolean)
      .slice(0, 12);
    res.json(results);
  } catch (error) { next(error); }
});

app.get('/api/admin/tmdb/details', requireAdmin, async (req, res, next) => {
  try {
    const mediaType = cleanText(req.query.type, 20);
    const id = cleanNullableInt(req.query.id);
    if (!ALLOWED_TMDB_TYPES.has(mediaType) || !id) {
      return res.status(400).json({ error: 'Item do TMDB inválido.' });
    }
    const item = await tmdbRequest(`/${mediaType}/${id}`);
    const date = item.release_date || item.first_air_date || '';
    res.json({
      tmdb_id: item.id,
      tmdb_type: mediaType,
      title: item.title || item.name || 'Sem título',
      description: item.overview || '',
      year: /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null,
      genres: Array.isArray(item.genres) ? item.genres.map(genre => genre.name).join(', ') : '',
      cover_url: tmdbImage(item.poster_path, 'w500'),
      backdrop_url: tmdbImage(item.backdrop_path, 'original')
    });
  } catch (error) { next(error); }
});

app.post('/api/admin/titles', requireAdmin, async (req, res, next) => {
  try {
    const record = normalizeTitle(req.body);
    res.status(201).json(await createTitle(record));
  } catch (error) {
    if (/Digite|Cole|link|inválido|série/i.test(error.message)) return res.status(400).json({ error: error.message });
    next(error);
  }
});

app.post('/api/admin/import-playlist', requireAdmin, async (req, res, next) => {
  try {
    const records = parsePlaylist(req.body.content, req.body.defaults || {});
    const result = await createManyTitles(records);
    res.status(201).json({ ...result, parsed: records.length });
  } catch (error) {
    if (/playlist|Nenhum|link|Digite|Cole|inválido|série/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

app.put('/api/admin/titles/:id', requireAdmin, async (req, res, next) => {
  try {
    const record = normalizeTitle(req.body);
    const updated = await updateTitle(req.params.id, record);
    if (!updated) return res.status(404).json({ error: 'Conteúdo não encontrado.' });
    res.json(updated);
  } catch (error) {
    if (/Digite|Cole|link|inválido|série/i.test(error.message)) return res.status(400).json({ error: error.message });
    next(error);
  }
});

app.delete('/api/admin/titles/:id', requireAdmin, async (req, res, next) => {
  try {
    const removed = await deleteTitle(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Conteúdo não encontrado.' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/watch', (req, res) => res.sendFile(path.join(__dirname, 'public', 'watch.html')));
app.get('/series', (req, res) => res.sendFile(path.join(__dirname, 'public', 'series.html')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.use((error, req, res, next) => {
  console.error(error);
  let status = Number(error.status) || 500;
  if (status < 400 || status > 599) status = 500;
  let message = status === 500 ? 'Erro interno no servidor.' : error.message;
  if ((error.status === 401 || error.status === 403) && error.source === 'tmdb') {
    message = 'A chave do TMDB foi recusada. Verifique TMDB_API_KEY.';
  } else if ((error.status === 401 || error.status === 403) && error.source === 'github') {
    message = 'O token do GitHub não tem permissão para salvar. Verifique GITHUB_TOKEN.';
  } else if (error.status === 404 && error.source === 'github') {
    message = 'Repositório do GitHub não encontrado. Verifique GITHUB_REPO e o token.';
  } else if (error.source === 'github' || error.source === 'tmdb' || error.message?.includes('TMDB')) {
    message = error.message;
  }
  res.status(status).json({ error: message });
});

async function start() {
  await ensureDataFile();
  console.log(`Armazenamento: ${HAS_GITHUB_STORAGE ? `GitHub (${GITHUB_REPO}, ramo ${GITHUB_CATALOG_BRANCH})` : 'JSON local'}`);
  console.log(`TMDB: ${HAS_TMDB ? 'configurado' : 'não configurado'}`);
  app.listen(PORT, '0.0.0.0', () => console.log(`Site aberto na porta ${PORT}`));
}

start().catch(error => {
  console.error('Falha ao iniciar:', error);
  process.exit(1);
});
