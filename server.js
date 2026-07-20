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
const MAX_OKRU_PAGES = 90;
const MAX_OKRU_ITEMS = 1500;
const OKRU_TIMEOUT_MS = 25_000;
const OKRU_IMPORT_VERSION = '6.0.0';

let catalogCache = null;
let catalogCacheTime = 0;
let resolvedCatalogBranch = null;
let mutationQueue = Promise.resolve();
const okruCookieJar = new Map();

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

// O painel e os arquivos visuais não ficam presos no cache do navegador após um deploy.
app.use((req, res, next) => {
  if (req.path === '/admin' || req.path.endsWith('.html') || req.path.startsWith('/assets/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

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
  maxAge: 0,
  etag: false,
  lastModified: false
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

function decodeHtmlEntities(value) {
  const named = {
    amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ',
    laquo: '«', raquo: '»', hellip: '…', ndash: '–', mdash: '—'
  };
  return String(value || '')
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function unescapeJsonText(value) {
  const raw = String(value || '');
  try { return JSON.parse(`"${raw.replace(/"/g, '\\"')}"`); }
  catch {
    return raw
      .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\n/g, ' ')
      .replace(/\\t/g, ' ')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
}

function cleanOkruTitle(value) {
  return cleanText(stripHtml(unescapeJsonText(value)), 180)
    .replace(/\s*[|–—-]\s*(?:OK\.?RU|Одноклассники)\s*$/i, '')
    .replace(/^Видео\s*[:—-]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isOkruHost(hostname) {
  return /(^|\.)ok\.ru$/i.test(String(hostname || ''));
}

function normalizeOkruUrl(value) {
  const text = cleanText(value, 4000);
  let url;
  try { url = new URL(text); } catch { throw new Error('Cole um link válido do OK.ru.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !isOkruHost(url.hostname)) {
    throw new Error('O link precisa ser do OK.ru.');
  }
  if (!/^\/video\//i.test(url.pathname)) {
    throw new Error('Use um link de vídeo ou de playlist do OK.ru, como https://ok.ru/video/c123456.');
  }
  url.protocol = 'https:';
  url.hash = '';
  return url;
}

function okruMobileUrl(url) {
  const mobile = new URL(url.toString());
  mobile.hostname = 'm.ok.ru';
  return mobile;
}

function getOkruCookieHeader() {
  return [...okruCookieJar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function storeOkruCookies(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  for (const value of values) {
    const first = String(value || '').split(';', 1)[0];
    const index = first.indexOf('=');
    if (index <= 0) continue;
    const name = first.slice(0, index).trim();
    const cookieValue = first.slice(index + 1).trim();
    if (name && cookieValue) okruCookieJar.set(name, cookieValue);
  }
}

async function fetchOkruHtml(inputUrl) {
  let current = new URL(inputUrl.toString());
  for (let redirect = 0; redirect < 8; redirect += 1) {
    if (!isOkruHost(current.hostname)) throw new Error('O OK.ru redirecionou para um endereço não permitido.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OKRU_TIMEOUT_MS);
    let response;
    try {
      const cookie = getOkruCookieHeader();
      response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7,ru;q=0.5',
          Referer: 'https://ok.ru/',
          ...(cookie ? { Cookie: cookie } : {})
        }
      });
      storeOkruCookies(response);
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('O OK.ru demorou demais para responder. Tente novamente.');
      throw new Error(`Não foi possível abrir o link do OK.ru: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      current = new URL(response.headers.get('location'), current);
      continue;
    }
    if (!response.ok) throw new Error(`O OK.ru recusou o acesso à playlist (${response.status}). Ela precisa ser pública.`);
    return { html: await response.text(), finalUrl: current };
  }
  throw new Error('O OK.ru fez redirecionamentos demais.');
}

function unwrapOkruJson(raw) {
  const text = String(raw || '').trim()
    .replace(/^while\s*\(\s*1\s*\)\s*;?/i, '')
    .replace(/^for\s*\(\s*;;\s*\)\s*;?/i, '')
    .trim();
  const starts = [text.indexOf('{'), text.indexOf('[')].filter(index => index >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  return start >= 0 ? text.slice(start) : text;
}

function deepFindObject(root, predicate) {
  const queue = [root];
  const visited = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    if (predicate(value)) return value;
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') queue.push(child);
    }
  }
  return null;
}

async function fetchOkruVideoMetadata(id) {
  const metadataUrl = new URL('https://ok.ru/dk');
  metadataUrl.searchParams.set('cmd', 'videoPlayerMetadata');
  metadataUrl.searchParams.set('mid', String(id));

  try {
    const response = await fetchOkruHtml(metadataUrl);
    const parsed = JSON.parse(unwrapOkruJson(response.html));
    const movie = deepFindObject(parsed, value => {
      const title = value.title || value.name || value.movieTitle;
      return Boolean(title && (value.id || value.movieId || value.poster || value.posterUrl || value.duration));
    }) || deepFindObject(parsed, value => Boolean(value.title || value.movieTitle));

    const title = cleanOkruTitle(movie?.title || movie?.movieTitle || movie?.name || '');
    const poster = cleanHttpUrl(movie?.poster || movie?.posterUrl || movie?.thumbnail || movie?.image || '', 2000);
    if (title || poster) return { title, poster };
  } catch {}

  try {
    const page = await fetchOkruHtml(new URL(`https://ok.ru/video/${id}`));
    return {
      title: extractOkruPageTitle(page.html),
      poster: cleanHttpUrl(extractMetaContent(page.html, 'property', 'og:image'), 2000)
    };
  } catch {
    return { title: '', poster: '' };
  }
}

function extractTagAttribute(attributes, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = String(attributes || '').match(pattern);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
}

function extractMetaContent(html, key, value) {
  const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const property = extractTagAttribute(tag, key);
    if (property.toLowerCase() === String(value).toLowerCase()) {
      return decodeHtmlEntities(extractTagAttribute(tag, 'content'));
    }
  }
  return '';
}

function extractOkruPageTitle(html) {
  const og = extractMetaContent(html, 'property', 'og:title') || extractMetaContent(html, 'name', 'title');
  if (og) return cleanOkruTitle(og);
  const title = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  return cleanOkruTitle(title);
}

function isGenericVideoTitle(title, id = '') {
  const value = cleanOkruTitle(title).toLocaleLowerCase('pt-BR');
  if (!value) return true;
  return value === String(id) || /^(?:vídeo|video|assistir|ok\.ru)(?:\s+\d+)?$/i.test(value);
}

function extractExpectedVideoCount(html) {
  const text = stripHtml(String(html || ''));
  const candidates = [];
  const patterns = [
    /\b([\d.,\s]{1,12})\s*(?:vídeos?|videos?|video|ролик(?:ов|а)?|видео)\b/gi,
    /"(?:videoCount|videosCount|totalCount|total)"\s*:\s*"?(\d{1,6})"?/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(pattern === patterns[0] ? text : String(html || '')))) {
      const number = Number(String(match[1]).replace(/\D/g, ''));
      if (Number.isInteger(number) && number > 0 && number <= MAX_OKRU_ITEMS) candidates.push(number);
    }
  }
  return candidates.length ? Math.max(...candidates) : null;
}

function extractNearbyOkruTitle(source, index, id) {
  const before = source.slice(Math.max(0, index - 1200), index);
  const after = source.slice(index, Math.min(source.length, index + 2200));
  const area = `${before}${after}`;
  const attribute = area.match(/(?:data-title|aria-label|title)\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
  const json = area.match(/"(?:title|name|movieTitle|videoTitle)"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  const visiblePatterns = [
    /class\s*=\s*(?:"[^"]*(?:video-card_n|video-card_name|video-title|card-title)[^"]*"|'[^']*(?:video-card_n|video-card_name|video-title|card-title)[^']*')[^>]*>([\s\S]{1,400}?)<\//i,
    /<a\b[^>]*href\s*=\s*(?:"|')[^"']*\/video\/\d+[^"']*(?:"|')[^>]*>([\s\S]{1,500}?)<\/a>/i,
    /<h[1-6]\b[^>]*>([\s\S]{1,400}?)<\/h[1-6]>/i
  ];
  let visible = '';
  for (const pattern of visiblePatterns) {
    const found = after.match(pattern) || before.match(pattern);
    if (found?.[1]) { visible = stripHtml(found[1]); break; }
  }
  const value = attribute?.[1] || attribute?.[2] || json?.[1] || visible || '';
  const cleaned = cleanOkruTitle(value);
  return isGenericVideoTitle(cleaned, id) ? '' : cleaned;
}

function parseOkruListing(html, baseUrl) {
  const videos = new Map();
  const pageLinks = new Set();
  const source = String(html || '');
  const collectionMatch = String(baseUrl.pathname || '').match(/\/video\/c(\d+)/i);
  const collectionId = collectionMatch?.[1] || '';

  function addVideo(id, title = '', poster = '') {
    if (!/^\d{6,}$/.test(String(id || ''))) return;
    const numericId = String(id);
    const cleaned = cleanOkruTitle(title);
    const previous = videos.get(numericId) || { id: numericId, title: '', poster: '' };
    if (!previous.title || isGenericVideoTitle(previous.title, numericId)) previous.title = cleaned || previous.title;
    if (!previous.poster && poster) previous.poster = cleanHttpUrl(decodeHtmlEntities(poster), 2000);
    videos.set(numericId, previous);
  }

  function addPageLink(value) {
    const decoded = decodeHtmlEntities(String(value || '').replace(/\\\//g, '/'));
    if (!decoded) return;
    let resolved;
    try { resolved = new URL(decoded, baseUrl); } catch { return; }
    if (!isOkruHost(resolved.hostname)) return;
    const sameCollection = collectionId && resolved.toString().includes(`c${collectionId}`);
    const pageHint = /(?:^|[?&])(st\.page|page|p)=\d+/i.test(resolved.search)
      || /\/(?:page|p)\/\d+/i.test(resolved.pathname)
      || /showmore|loadmore|pagination/i.test(resolved.toString());
    if (sameCollection || pageHint) pageLinks.add(resolved.toString());
  }

  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let anchor;
  while ((anchor = anchorRegex.exec(source))) {
    const attrs = anchor[1];
    const hrefRaw = decodeHtmlEntities(extractTagAttribute(attrs, 'href'));
    if (!hrefRaw) continue;
    let resolved;
    try { resolved = new URL(hrefRaw, baseUrl); } catch { continue; }
    if (!isOkruHost(resolved.hostname)) continue;

    const videoMatch = resolved.pathname.match(/^\/video(?:embed)?\/(\d{6,})(?:\/|$)/i);
    if (videoMatch) {
      const title = extractTagAttribute(attrs, 'data-title')
        || extractTagAttribute(attrs, 'aria-label')
        || extractTagAttribute(attrs, 'title')
        || stripHtml(anchor[2])
        || extractNearbyOkruTitle(source, anchor.index, videoMatch[1]);
      const poster = extractTagAttribute(attrs, 'data-poster') || extractTagAttribute(attrs, 'data-image');
      addVideo(videoMatch[1], title, poster);
      continue;
    }
    addPageLink(resolved.toString());
  }

  // Links e ações usados no layout atual do OK.ru, inclusive openMovie('ID', ...).
  const idPatterns = [
    /\/video(?:embed)?\/(\d{6,})/gi,
    /\\\/video(?:embed)?\\\/(\d{6,})/gi,
    /openMovie\s*\(\s*['"](\d{6,})['"]/gi,
    /(?:data-(?:video|movie)(?:-?id)?|videoId|movieId|video_id)\\?["']?\s*(?:=|:)\s*\\?["']?(\d{6,})/gi
  ];
  let match;
  for (const pattern of idPatterns) {
    while ((match = pattern.exec(source))) {
      const id = match[1];
      addVideo(id, extractNearbyOkruTitle(source, match.index, id));
    }
  }

  const jsonPatterns = [
    /"(?:videoId|movieId|video_id)"\s*:\s*"?(\d{6,})"?[\s\S]{0,900}?"(?:title|name|movieTitle|videoTitle)"\s*:\s*"((?:\\.|[^"\\])*)"/gi,
    /"(?:title|name|movieTitle|videoTitle)"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,900}?"(?:videoId|movieId|video_id)"\s*:\s*"?(\d{6,})"?/gi
  ];
  while ((match = jsonPatterns[0].exec(source))) addVideo(match[1], match[2]);
  while ((match = jsonPatterns[1].exec(source))) addVideo(match[2], match[1]);

  const hrefPatterns = [
    /(?:href|url)\\?["']?\s*(?:=|:)\s*\\?["']([^"'\s>]*(?:st\.page|\/video\/c\d+)[^"'\s>]*)/gi,
    /(?:https?:)?\\?\/\\?\/m?\.?(?:ok\.ru)[^"'\s<]*(?:st\.page|\/video\/c\d+)[^"'\s<]*/gi
  ];
  for (const pattern of hrefPatterns) {
    while ((match = pattern.exec(source))) addPageLink(match[1] || match[0]);
  }

  return {
    videos,
    pageLinks,
    pageTitle: extractOkruPageTitle(source),
    expectedCount: extractExpectedVideoCount(source)
  };
}

async function mapWithConcurrency(values, limit, worker) {
  const output = new Array(values.length);
  let cursor = 0;
  async function run() {
    while (cursor < values.length) {
      const index = cursor++;
      try { output[index] = await worker(values[index], index); }
      catch { output[index] = values[index]; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
  return output;
}

async function enrichOkruVideoMetadata(entries) {
  const targets = entries.slice(0, MAX_OKRU_ITEMS);
  const enriched = await mapWithConcurrency(targets, 5, async entry => {
    const currentTitle = cleanOkruTitle(entry.title);
    const looksTruncated = /(?:\.\.\.|…)$/.test(currentTitle);
    if (currentTitle && !looksTruncated && !isGenericVideoTitle(currentTitle, entry.id)) return entry;
    const metadata = await fetchOkruVideoMetadata(entry.id);
    const metadataTitle = cleanOkruTitle(metadata.title);
    return {
      ...entry,
      title: metadataTitle && !isGenericVideoTitle(metadataTitle, entry.id) ? metadataTitle : currentTitle,
      poster: entry.poster || metadata.poster || ''
    };
  });
  const byId = new Map(enriched.map(item => [item.id, item]));
  return entries.map(item => byId.get(item.id) || item);
}

function mergeOkruParsed(parsed, videos) {
  for (const [id, value] of parsed.videos) {
    const old = videos.get(id);
    if (!old) videos.set(id, value);
    else videos.set(id, {
      ...old,
      title: (!old.title || isGenericVideoTitle(old.title, id)) ? (value.title || old.title) : old.title,
      poster: old.poster || value.poster || ''
    });
  }
}

async function readOkruCollection(rawUrl) {
  const original = normalizeOkruUrl(rawUrl);
  const directVideo = original.pathname.match(/^\/video\/(\d{6,})(?:\/|$)/i);
  if (directVideo) {
    const page = await fetchOkruHtml(original);
    return {
      title: extractOkruPageTitle(page.html),
      entries: [{
        id: directVideo[1],
        title: extractOkruPageTitle(page.html),
        poster: cleanHttpUrl(extractMetaContent(page.html, 'property', 'og:image'), 2000)
      }],
      expectedCount: 1,
      complete: true
    };
  }

  if (!/^\/video\/c\d+/i.test(original.pathname)) {
    throw new Error('Esse endereço não parece ser uma playlist/canal do OK.ru. Use um link no formato https://ok.ru/video/c123456.');
  }

  const desktopBase = new URL(original.toString());
  desktopBase.hostname = 'ok.ru';
  const mobileBase = okruMobileUrl(original);
  const queue = [desktopBase, mobileBase];
  const visited = new Set();
  const videos = new Map();
  let collectionTitle = '';
  let expectedCount = null;

  async function readCandidate(current) {
    const key = current.toString();
    if (visited.has(key)) return 0;
    visited.add(key);
    const before = videos.size;
    const page = await fetchOkruHtml(current);
    const parsed = parseOkruListing(page.html, page.finalUrl);
    if (!collectionTitle && parsed.pageTitle) collectionTitle = parsed.pageTitle;
    if (parsed.expectedCount) expectedCount = Math.max(expectedCount || 0, parsed.expectedCount);
    mergeOkruParsed(parsed, videos);
    for (const link of parsed.pageLinks) {
      if (!visited.has(link) && queue.length < MAX_OKRU_PAGES * 4) queue.push(new URL(link));
    }
    return videos.size - before;
  }

  while (queue.length && visited.size < MAX_OKRU_PAGES * 4 && videos.size < MAX_OKRU_ITEMS) {
    const current = queue.shift();
    try { await readCandidate(current); }
    catch (error) {
      if (visited.size <= 2 && !videos.size) continue;
    }
    if (expectedCount && videos.size >= expectedCount) break;
  }

  // O OK.ru muda o parâmetro de paginação entre os layouts. Testa as variantes
  // desktop e móvel até completar a quantidade informada na própria página.
  const strategies = ['st.page', 'page', 'p'];
  for (const base of [desktopBase, mobileBase]) {
    for (const parameter of strategies) {
      let emptyPages = 0;
      for (let pageNumber = 0; pageNumber <= MAX_OKRU_PAGES && videos.size < MAX_OKRU_ITEMS; pageNumber += 1) {
        if (expectedCount && videos.size >= expectedCount) break;
        const candidate = new URL(base.toString());
        candidate.searchParams.set(parameter, String(pageNumber));
        try {
          const added = await readCandidate(candidate);
          emptyPages = added ? 0 : emptyPages + 1;
        } catch {
          emptyPages += 1;
        }
        if (emptyPages >= 5) break;
      }
    }
  }

  if (!videos.size) {
    throw new Error('Não encontrei vídeos nessa playlist do OK.ru. Ela precisa estar pública e visível sem login.');
  }

  const entries = await enrichOkruVideoMetadata([...videos.values()].slice(0, MAX_OKRU_ITEMS));
  return {
    title: collectionTitle,
    entries,
    expectedCount,
    complete: !expectedCount || entries.length >= expectedCount
  };
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
    episode_image_url: cleanHttpUrl(body.episode_image_url, 2000),
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

async function createManyTitles(records, options = {}) {
  const updateExisting = Boolean(options.updateExisting);
  const removeSourceUrls = new Set((options.removeSourceUrls || []).map(value => String(value || '').trim()).filter(Boolean));

  return mutateCatalog(`Importar playlist: ${records.length} itens`, items => {
    let removed = 0;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (removeSourceUrls.has(String(items[index].source_url || '').trim())) {
        items.splice(index, 1);
        removed += 1;
      }
    }

    let nextId = items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
    const existingByUrl = new Map();
    items.forEach((item, index) => {
      const url = String(item.source_url || '').trim();
      if (url) existingByUrl.set(url, index);
    });

    const now = new Date().toISOString();
    const created = [];
    let updated = 0;
    let skipped = 0;

    for (const record of records) {
      const existingIndex = existingByUrl.get(record.source_url);
      if (existingIndex !== undefined) {
        if (updateExisting) {
          const previous = items[existingIndex];
          items[existingIndex] = {
            ...previous,
            ...record,
            id: previous.id,
            created_at: previous.created_at || now,
            updated_at: now
          };
          updated += 1;
        } else {
          skipped += 1;
        }
        continue;
      }

      const item = { id: nextId++, ...record, created_at: now, updated_at: now };
      items.push(item);
      created.push(item);
      existingByUrl.set(record.source_url, items.length - 1);
    }
    return { added: created.length, updated, skipped, removed, items: created };
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

function parseEpisodeInfo(rawTitle, knownSeriesTitle = '') {
  const title = cleanOkruTitle(rawTitle);
  const patterns = [
    /\bS(?:EASON)?\s*0*(\d{1,3})\s*[._ -]*E(?:P(?:ISODE|IS[ÓO]DIO)?)?\s*0*(\d{1,4})\b/i,
    /\b0*(\d{1,3})\s*x\s*0*(\d{1,4})\b/i,
    /\bT(?:EMPORADA)?\s*0*(\d{1,3})\s*[._ -]*(?:E|EP|EPIS[ÓO]DIO)\s*0*(\d{1,4})\b/i,
    /\b0*(\d{1,3})[ªº]?\s*TEMPORADA.{0,20}?0*(\d{1,4})[ºª]?\s*(?:EPIS[ÓO]DIO|EP)\b/i,
    /\bTEMPORADA\s*0*(\d{1,3}).{0,20}?EPIS[ÓO]DIO\s*0*(\d{1,4})\b/i
  ];
  const match = patterns.map(pattern => title.match(pattern)).find(Boolean);

  let season = null;
  let episode = null;
  let markerStart = -1;
  let markerLength = 0;

  if (match) {
    season = Number(match[1]);
    episode = Number(match[2]);
    markerStart = match.index || 0;
    markerLength = match[0].length;
  } else {
    const episodeOnlyPatterns = [
      /\b(?:EP|EP\.|EPIS[ÓO]DIO|CAP[ÍI]TULO)\s*0*(\d{1,4})\b/i,
      /\b0*(\d{1,4})[ºª]?\s*EPIS[ÓO]DIO\b/i
    ];
    const episodeOnly = episodeOnlyPatterns.map(pattern => title.match(pattern)).find(Boolean);
    if (episodeOnly) {
      episode = Number(episodeOnly[1]);
      markerStart = episodeOnly.index || 0;
      markerLength = episodeOnly[0].length;
    }
  }

  if (episode === null) return null;

  let before = title.slice(0, markerStart).replace(/[._\-–—:|]+/g, ' ').replace(/\s+/g, ' ').trim();
  let after = title.slice(markerStart + markerLength).replace(/^[\s._\-–—:|]+/, '').trim();
  const known = cleanText(knownSeriesTitle, 180);
  if (known && before.toLocaleLowerCase('pt-BR').startsWith(known.toLocaleLowerCase('pt-BR'))) {
    before = before.slice(known.length).replace(/^[\s._\-–—:|]+/, '').trim();
  }
  const seriesTitle = known || before;
  const episodeTitle = after || (before && !known ? '' : `Episódio ${episode}`);

  return { seriesTitle, season, episode, episodeTitle };
}

function removeSeriesPrefix(title, seriesTitle) {
  const raw = cleanOkruTitle(title);
  const series = cleanText(seriesTitle, 180);
  if (!series) return raw;
  const escaped = series.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return raw.replace(new RegExp(`^${escaped}\\s*(?:[-–—:|]\\s*)?`, 'i'), '').trim() || raw;
}

function buildRecordsFromOkru(entries, defaults = {}, collectionTitle = '') {
  const defaultSeries = cleanText(defaults.series_title, 180);
  const inferredCollectionTitle = cleanOkruTitle(collectionTitle)
    .replace(/\s*(?:vídeos?|video|playlist|canal)\s*$/i, '')
    .trim();
  const contentTypeRequested = cleanText(defaults.content_type, 20);
  const treatAsSeries = Boolean(defaultSeries || contentTypeRequested === 'episode');
  const fallbackSeries = defaultSeries || (treatAsSeries ? inferredCollectionTitle : '');
  const defaultSeason = cleanNullableInt(defaults.season) ?? 1;
  const firstEpisode = cleanNullableInt(defaults.episode) ?? 1;
  const common = {
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
    const rawTitle = cleanOkruTitle(entry.title) || `Vídeo ${index + 1}`;
    const info = parseEpisodeInfo(rawTitle, fallbackSeries);
    const isEpisode = treatAsSeries || Boolean(info?.seriesTitle);
    const seriesTitle = isEpisode ? (fallbackSeries || info?.seriesTitle || inferredCollectionTitle) : '';
    const season = isEpisode ? (info?.season ?? defaultSeason) : null;
    const episode = isEpisode ? (info?.episode ?? (firstEpisode + index)) : null;
    let title = rawTitle;
    if (isEpisode) {
      title = cleanOkruTitle(info?.episodeTitle || removeSeriesPrefix(rawTitle, seriesTitle));
      const normalizedTitle = title.toLocaleLowerCase('pt-BR');
      const normalizedSeries = seriesTitle.toLocaleLowerCase('pt-BR');
      const onlyEpisodeMarker = /^(?:t(?:emporada)?\s*\d+\s*[-–—.:| ]*)?(?:e|ep|epis[óo]dio)\s*\d+$/i.test(title);
      if (!title
        || normalizedTitle === normalizedSeries
        || onlyEpisodeMarker
        || isGenericVideoTitle(title, entry.id)) {
        title = `Episódio ${episode}`;
      }
    }

    return normalizeTitle({
      ...common,
      title,
      series_title: seriesTitle,
      content_type: isEpisode && seriesTitle ? 'episode' : 'movie',
      season,
      episode,
      source_url: `https://ok.ru/video/${entry.id}`,
      source_type: 'okru',
      cover_url: common.cover_url || cleanHttpUrl(entry.poster, 2000)
    });
  });
}

async function enrichEpisodeRecordsWithTmdb(records) {
  if (!HAS_TMDB || !records.length) return records;
  const sample = records.find(record => record.tmdb_type === 'tv' && record.tmdb_id && record.content_type === 'episode');
  if (!sample) return records;
  const seasons = [...new Set(records.map(record => record.season).filter(Number.isInteger))];
  const episodeData = new Map();
  await mapWithConcurrency(seasons, 3, async season => {
    try {
      const data = await tmdbRequest(`/tv/${sample.tmdb_id}/season/${season}`);
      for (const episode of data.episodes || []) {
        episodeData.set(`${season}:${episode.episode_number}`, episode);
      }
    } catch {}
  });
  return records.map(record => {
    const tmdbEpisode = episodeData.get(`${record.season}:${record.episode}`);
    if (!tmdbEpisode) return record;
    const currentTitle = cleanText(record.title, 180);
    const fallbackTitle = /^(?:epis[óo]dio|ep)\s*\d+$/i.test(currentTitle) || isGenericVideoTitle(currentTitle);
    return {
      ...record,
      // Preserva o nome que veio do OK.ru. O TMDB só completa quando o título é genérico.
      title: fallbackTitle && tmdbEpisode.name ? cleanText(tmdbEpisode.name, 180) : currentTitle,
      episode_image_url: tmdbImage(tmdbEpisode.still_path, 'w780') || record.episode_image_url || '',
      description: record.description || cleanText(tmdbEpisode.overview, 5000)
    };
  });
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

  const defaultSeason = cleanNullableInt(defaults.season) ?? (defaultSeries ? 1 : null);
  const firstEpisode = cleanNullableInt(defaults.episode) ?? 1;

  return entries.map((entry, index) => {
    const rawTitle = cleanOkruTitle(entry.title || `Vídeo ${index + 1}`);
    const episodeInfo = parseEpisodeInfo(rawTitle, defaultSeries);
    const isEpisode = Boolean(defaultSeries || episodeInfo || defaultContentType === 'episode');
    const seriesTitle = defaultSeries || episodeInfo?.seriesTitle || '';
    const contentType = isEpisode && seriesTitle ? 'episode' : 'movie';
    const episodeNumber = episodeInfo?.episode ?? (defaultSeries ? firstEpisode + index : null);
    const episodeTitle = cleanOkruTitle(episodeInfo?.episodeTitle || removeSeriesPrefix(rawTitle, seriesTitle))
      || (episodeNumber !== null ? `Episódio ${episodeNumber}` : rawTitle);

    return normalizeTitle({
      ...defaultRecord,
      title: contentType === 'episode' ? episodeTitle : rawTitle,
      series_title: contentType === 'episode' ? seriesTitle : '',
      content_type: contentType,
      season: contentType === 'episode' ? (episodeInfo?.season ?? defaultSeason) : null,
      episode: contentType === 'episode' ? episodeNumber : null,
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
    let records = parsePlaylist(req.body.content, req.body.defaults || {});
    records = await enrichEpisodeRecordsWithTmdb(records);
    const result = await createManyTitles(records);
    res.status(201).json({ ...result, parsed: records.length });
  } catch (error) {
    if (/playlist|Nenhum|link|Digite|Cole|inválido|série/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

app.post('/api/admin/import-okru', requireAdmin, async (req, res, next) => {
  try {
    const defaults = req.body.defaults || {};
    const collection = await readOkruCollection(req.body.url);
    let records = buildRecordsFromOkru(collection.entries, defaults, collection.title);
    records = await enrichEpisodeRecordsWithTmdb(records);
    const playlistUrl = normalizeOkruUrl(req.body.url).toString();
    const result = await createManyTitles(records, {
      updateExisting: true,
      removeSourceUrls: [playlistUrl]
    });
    res.status(201).json({
      ...result,
      parsed: records.length,
      playlist_title: collection.title || '',
      found: collection.entries.length,
      expected: collection.expectedCount || null,
      complete: collection.complete !== false,
      importer_version: OKRU_IMPORT_VERSION
    });
  } catch (error) {
    if (/OK\.ru|playlist|canal|link|pública|vídeo|endereço|recusou|demorou/i.test(error.message)) {
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

app.get('/api/admin/importer-version', requireAdmin, (req, res) => res.json({ version: OKRU_IMPORT_VERSION }));

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

if (require.main === module) {
  start().catch(error => {
    console.error('Falha ao iniciar:', error);
    process.exit(1);
  });
}

module.exports = {
  app,
  parseEpisodeInfo,
  parseOkruListing,
  buildRecordsFromOkru,
  parsePlaylist,
  extractOkruPageTitle,
  extractExpectedVideoCount,
  readOkruCollection,
  enrichEpisodeRecordsWithTmdb
};
