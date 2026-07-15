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
const HAS_GITHUB_STORAGE = Boolean(GITHUB_TOKEN && /^[^/\s]+\/[^/\s]+$/.test(GITHUB_REPO));
const ALLOWED_CONTENT_TYPES = new Set(['movie', 'episode']);
const ALLOWED_SOURCE_TYPES = new Set(['okru', 'gdrive', 'direct', 'hls']);

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
      imgSrc: ["'self'", 'data:', 'https:'],
      mediaSrc: ["'self'", 'blob:', 'https:', 'http:'],
      frameSrc: ["'self'", 'https://ok.ru', 'https://drive.google.com'],
      connectSrc: ["'self'", 'https:', 'http:'],
      fontSrc: ["'self'", 'data:']
    }
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(compression());
app.use(express.json({ limit: '300kb' }));
app.use(express.urlencoded({ extended: false }));
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

function detectSourceType(url) {
  const value = String(url || '').toLowerCase();
  if (value.includes('ok.ru/')) return 'okru';
  if (value.includes('drive.google.com/') || value.includes('docs.google.com/')) return 'gdrive';
  if (/\.m3u8(?:$|[?#])/i.test(value)) return 'hls';
  return 'direct';
}

function normalizeTitle(body) {
  const sourceUrl = cleanText(body.source_url, 4000);
  const contentType = cleanText(body.content_type, 20) || 'movie';
  const sourceType = ALLOWED_SOURCE_TYPES.has(cleanText(body.source_type, 20))
    ? cleanText(body.source_type, 20)
    : detectSourceType(sourceUrl);

  const record = {
    title: cleanText(body.title, 180),
    series_title: cleanText(body.series_title, 180),
    description: cleanText(body.description, 5000),
    year: cleanNullableInt(body.year),
    genres: cleanText(body.genres, 300),
    cover_url: cleanText(body.cover_url, 2000),
    backdrop_url: cleanText(body.backdrop_url, 2000),
    content_type: contentType,
    season: cleanNullableInt(body.season),
    episode: cleanNullableInt(body.episode),
    source_type: sourceType,
    source_url: sourceUrl,
    featured: Boolean(body.featured),
    published: body.published !== false
  };

  if (!record.title) throw new Error('Digite o título.');
  if (!record.source_url) throw new Error('Cole o link do vídeo.');
  if (!ALLOWED_CONTENT_TYPES.has(record.content_type)) throw new Error('Tipo de conteúdo inválido.');
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

async function createTitle(record) {
  return mutateCatalog(`Adicionar: ${record.title}`, items => {
    const nextId = items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
    const now = new Date().toISOString();
    const created = { id: nextId, ...record, created_at: now, updated_at: now };
    items.push(created);
    return created;
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

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  return res.status(401).json({ error: 'Entre com a senha do painel.' });
}

function storageLabel() {
  return HAS_GITHUB_STORAGE ? 'github' : 'local';
}

app.get('/health', (req, res) => res.json({ ok: true, storage: storageLabel() }));

app.get('/api/catalog', async (req, res, next) => {
  try {
    const search = cleanText(req.query.search, 120);
    res.json(await listTitles({ publishedOnly: true, search }));
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
    githubConfigured: HAS_GITHUB_STORAGE
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

app.post('/api/admin/titles', requireAdmin, async (req, res, next) => {
  try {
    const record = normalizeTitle(req.body);
    res.status(201).json(await createTitle(record));
  } catch (error) {
    if (/Digite|Cole|inválido/i.test(error.message)) return res.status(400).json({ error: error.message });
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
    if (/Digite|Cole|inválido/i.test(error.message)) return res.status(400).json({ error: error.message });
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

app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.use((error, req, res, next) => {
  console.error(error);
  let message = 'Erro interno no servidor.';
  if (error.status === 401 || error.status === 403) {
    message = 'O token do GitHub não tem permissão para salvar. Verifique GITHUB_TOKEN.';
  } else if (error.status === 404 && HAS_GITHUB_STORAGE) {
    message = 'Repositório do GitHub não encontrado. Verifique GITHUB_REPO e o token.';
  } else if (error.message?.includes('GitHub')) {
    message = error.message;
  }
  res.status(500).json({ error: message });
});

async function start() {
  await ensureDataFile();
  console.log(`Armazenamento: ${HAS_GITHUB_STORAGE ? `GitHub (${GITHUB_REPO}, ramo ${GITHUB_CATALOG_BRANCH})` : 'JSON local'}`);
  app.listen(PORT, '0.0.0.0', () => console.log(`Site aberto na porta ${PORT}`));
}

start().catch(error => {
  console.error('Falha ao iniciar:', error);
  process.exit(1);
});
