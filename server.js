'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs/promises');
const dns = require('dns').promises;
const net = require('net');
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
const MAX_OKRU_PAGES = 140;
const MAX_OKRU_ITEMS = 2500;
const MAX_GENERIC_PAGES = 50;
const MAX_GENERIC_ITEMS = 2500;
const MAX_REMOTE_BYTES = 8 * 1024 * 1024;
const GENERIC_TIMEOUT_MS = 25_000;
const OKRU_TIMEOUT_MS = 25_000;
const IMPORTER_VERSION = '10.1.0';

let catalogCache = null;
let catalogCacheTime = 0;
let resolvedCatalogBranch = null;
let mutationQueue = Promise.resolve();
const okruCookieJar = new Map();
const seriesTmdbCache = new Map();

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

function hasEpisodeMarker(value) {
  const text = cleanOkruTitle(value);
  return /\bS(?:EASON)?\s*0*\d{1,3}\s*[._ -]*E(?:P(?:ISODE|IS[ÓO]DIO)?)?\s*0*\d{1,4}\b/i.test(text)
    || /\b0*\d{1,3}\s*x\s*0*\d{1,4}\b/i.test(text)
    || /\bT(?:EMPORADA)?\s*0*\d{1,3}\s*[._ -]*(?:E|EP|EPIS[ÓO]DIO)\s*0*\d{1,4}\b/i.test(text)
    || /\b(?:EP|EP\.|EPIS[ÓO]DIO|CAP[ÍI]TULO)\s*0*\d{1,4}\b/i.test(text);
}

function isGenericVideoTitle(title, id = '') {
  const value = cleanOkruTitle(title).toLocaleLowerCase('pt-BR');
  if (!value) return true;
  if (value === String(id)) return true;

  const uiOnly = /^(?:view|views?|watch|play|preview|open|more|ver|assistir|reproduzir|abrir|abrir vídeo|abrir video|vídeo|video|ok\.ru|thumbnail|poster|imagem|image|foto|photo|detalhes?)(?:\s+\d+)?$/i;
  if (uiOnly.test(value)) return true;

  if (/^\d{1,3}:\d{2}(?::\d{2})?$/.test(value)) return true;
  if (/^\d[\d.,\s]*\s*(?:views?|visualiza(?:ç|c)(?:ão|oes|ões)|просмотр(?:ов|а)?)$/i.test(value)) return true;
  if (/^(?:\d{1,2}\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|янв|фев|мар|апр|май|июн|июл|авг|сен|окт|ноя|дек)[a-zа-я]*\.?\s+\d{2,4}$/i.test(value)) return true;
  return false;
}

function scoreOkruTitleCandidate(value, id = '') {
  const title = cleanOkruTitle(value);
  if (!title || isGenericVideoTitle(title, id)) return -1000;

  let score = 0;
  if (hasEpisodeMarker(title)) score += 120;
  if (/\b(?:temporada|epis[óo]dio|episode|season)\b/i.test(title)) score += 30;
  if (/[A-Za-zÀ-ÿА-Яа-я]/.test(title)) score += 15;
  if (title.length >= 8 && title.length <= 180) score += 15;
  if (title.length > 180) score -= 40;
  if (/https?:\/\//i.test(title)) score -= 80;
  if (/\b(?:views?|visualiza(?:ç|c)(?:ão|oes|ões))\b/i.test(title)) score -= 25;
  if (/^(?:sem título|untitled)$/i.test(title)) score -= 80;
  return score;
}

function chooseBestOkruTitle(candidates, id = '') {
  let best = '';
  let bestScore = -1000;
  for (const candidate of candidates || []) {
    const cleaned = cleanOkruTitle(candidate);
    const score = scoreOkruTitleCandidate(cleaned, id);
    if (score > bestScore || (score === bestScore && cleaned.length > best.length)) {
      best = cleaned;
      bestScore = score;
    }
  }
  return bestScore > -1000 ? best : '';
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

function extractOkruCardArea(source, index) {
  const html = String(source || '');
  const divPattern = /<div\b([^>]*)>/gi;
  let match;
  let cardStart = -1;

  while ((match = divPattern.exec(html))) {
    if (match.index > index) break;
    const classes = extractTagAttribute(match[1], 'class').split(/\s+/).filter(Boolean);
    if (classes.includes('video-card')) cardStart = match.index;
  }

  if (cardStart < 0) return '';
  divPattern.lastIndex = Math.max(cardStart + 1, index + 1);
  let nextCard = -1;
  while ((match = divPattern.exec(html))) {
    const classes = extractTagAttribute(match[1], 'class').split(/\s+/).filter(Boolean);
    if (classes.includes('video-card')) {
      nextCard = match.index;
      break;
    }
    if (match.index > cardStart + 12000) break;
  }

  const end = nextCard >= 0 ? nextCard : Math.min(html.length, cardStart + 12000);
  return html.slice(cardStart, end);
}

function extractNearbyOkruTitle(source, index, id) {
  const cardArea = extractOkruCardArea(source, index);
  const before = source.slice(Math.max(0, index - 1000), index);
  const after = source.slice(index, Math.min(source.length, index + 2200));
  const area = cardArea || `${before}${after}`;
  const candidates = [];

  const attributePattern = /(?:data-title|aria-label|title)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  let match;
  while ((match = attributePattern.exec(area))) candidates.push(match[1] || match[2] || '');

  const jsonPattern = /"(?:title|name|movieTitle|videoTitle)"\s*:\s*"((?:\\.|[^"\\])*)"/gi;
  while ((match = jsonPattern.exec(area))) candidates.push(match[1]);

  const classPattern = /class\s*=\s*(?:"[^"]*(?:video-card_n|video-card_name|video-card_title|video-card_t|video-title|card-title|card_name|caption)[^"]*"|'[^']*(?:video-card_n|video-card_name|video-card_title|video-card_t|video-title|card-title|card_name|caption)[^']*')[^>]*>([\s\S]{1,600}?)<\//gi;
  while ((match = classPattern.exec(area))) candidates.push(stripHtml(match[1]));

  const textNodePattern = />([^<>]{1,320})</g;
  while ((match = textNodePattern.exec(area))) {
    const visible = decodeHtmlEntities(match[1]).replace(/\s+/g, ' ').trim();
    if (visible && (hasEpisodeMarker(visible) || /\b(?:epis[óo]dio|episode|temporada|season)\b/i.test(visible))) {
      candidates.push(visible);
    }
  }

  const rawEpisodePattern = /([^<>"']{0,160}\bS(?:EASON)?\s*0*\d{1,3}\s*[._ -]*E(?:P(?:ISODE|IS[ÓO]DIO)?)?\s*0*\d{1,4}[^<>"']{0,220})/gi;
  while ((match = rawEpisodePattern.exec(decodeHtmlEntities(area)))) candidates.push(match[1]);

  return chooseBestOkruTitle(candidates, id);
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
    const previousScore = scoreOkruTitleCandidate(previous.title, numericId);
    const newScore = scoreOkruTitleCandidate(cleaned, numericId);
    if (!previous.title || newScore > previousScore) previous.title = cleaned || previous.title;
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
      const title = chooseBestOkruTitle([
        extractTagAttribute(attrs, 'data-title'),
        extractTagAttribute(attrs, 'aria-label'),
        extractTagAttribute(attrs, 'title'),
        stripHtml(anchor[2]),
        extractNearbyOkruTitle(source, anchor.index, videoMatch[1])
      ], videoMatch[1]);
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
    const currentScore = scoreOkruTitleCandidate(currentTitle, entry.id);
    const looksTruncated = /(?:\.\.\.|…)$/.test(currentTitle);
    const weakTitle = currentScore < 40 || !hasEpisodeMarker(currentTitle);

    if (currentTitle && !looksTruncated && !weakTitle) return entry;

    const metadata = await fetchOkruVideoMetadata(entry.id);
    const metadataTitle = cleanOkruTitle(metadata.title);
    const metadataScore = scoreOkruTitleCandidate(metadataTitle, entry.id);
    return {
      ...entry,
      title: metadataScore > currentScore ? metadataTitle : currentTitle,
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
    else {
      const oldScore = scoreOkruTitleCandidate(old.title, id);
      const newScore = scoreOkruTitleCandidate(value.title, id);
      videos.set(id, {
        ...old,
        title: newScore > oldScore ? (value.title || old.title) : old.title,
        poster: old.poster || value.poster || ''
      });
    }
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
    category: cleanText(body.category, 300),
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
    items = items.filter(item => [item.title, item.series_title, item.genres, item.category]
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
    category: cleanText(defaults.category, 300),
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
    const episodeOverview = cleanText(tmdbEpisode.overview, 5000);

    return {
      ...record,
      title: fallbackTitle && tmdbEpisode.name
        ? cleanText(tmdbEpisode.name, 180)
        : currentTitle,
      episode_image_url:
        tmdbImage(tmdbEpisode.still_path, 'w780') ||
        record.episode_image_url ||
        '',
      // Para episódios importados, a descrição do episódio tem prioridade.
      // Isso impede que a descrição geral da série seja repetida em todos.
      description: episodeOverview || cleanText(record.description, 5000)
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
    category: cleanText(defaults.category, 300),
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
      genres: defaultRecord.genres,
      category: defaultRecord.category || entry.group_title,
      cover_url: defaultRecord.cover_url || entry.cover_url,
      source_url: entry.source_url,
      source_type: detectSourceType(entry.source_url),
      published: defaultRecord.published
    });
  });
}



function isPrivateIp(address) {
  const value = String(address || '').toLowerCase();
  if (!value) return true;
  if (net.isIPv4(value)) {
    const parts = value.split('.').map(Number);
    const [a, b] = parts;
    return a === 10
      || a === 127
      || a === 0
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }
  if (net.isIPv6(value)) {
    return value === '::1'
      || value === '::'
      || value.startsWith('fc')
      || value.startsWith('fd')
      || value.startsWith('fe8')
      || value.startsWith('fe9')
      || value.startsWith('fea')
      || value.startsWith('feb')
      || value.startsWith('::ffff:127.')
      || value.startsWith('::ffff:10.')
      || value.startsWith('::ffff:192.168.');
  }
  return true;
}

async function assertPublicRemoteUrl(input) {
  let url;
  try { url = input instanceof URL ? new URL(input.toString()) : new URL(String(input || '')); }
  catch { throw new Error('Cole um link válido começando com http:// ou https://.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('O link precisa começar com http:// ou https://.');
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Endereço local não pode ser importado pelo servidor.');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Endereço de rede privada não pode ser importado.');
    return url;
  }
  let addresses;
  try { addresses = await dns.lookup(host, { all: true, verbatim: true }); }
  catch { throw new Error('Não foi possível localizar o endereço desse site.'); }
  if (!addresses.length || addresses.some(entry => isPrivateIp(entry.address))) {
    throw new Error('Esse endereço aponta para uma rede privada e foi bloqueado por segurança.');
  }
  return url;
}

async function fetchPublicResource(inputUrl) {
  let current = await assertPublicRemoteUrl(inputUrl);
  for (let redirect = 0; redirect < 8; redirect += 1) {
    current = await assertPublicRemoteUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GENERIC_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/json,application/xml,text/xml,text/plain,application/vnd.apple.mpegurl,audio/mpegurl,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7'
        }
      });
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('O site demorou demais para responder.');
      throw new Error(`Não foi possível abrir o link: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      current = new URL(response.headers.get('location'), current);
      continue;
    }
    if (!response.ok) throw new Error(`O site recusou o acesso (${response.status}). A página precisa ser pública.`);
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_REMOTE_BYTES) throw new Error('A playlist ou página é grande demais para importar.');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_REMOTE_BYTES) throw new Error('A playlist ou página ultrapassou 8 MB.');
    return {
      body: buffer.toString('utf8'),
      contentType: String(response.headers.get('content-type') || '').toLowerCase(),
      finalUrl: current,
      status: response.status
    };
  }
  throw new Error('O site fez redirecionamentos demais.');
}

function resolveRemoteUrl(value, baseUrl) {
  const raw = decodeHtmlEntities(String(value || '').trim()).replace(/^['"]|['"]$/g, '');
  if (!raw || raw.startsWith('javascript:') || raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('#')) return '';
  try {
    const url = new URL(raw, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    return url.toString();
  } catch { return ''; }
}

function isImageOrAssetUrl(value) {
  return /\.(?:jpe?g|png|gif|webp|svg|ico|css|js|woff2?|ttf|map)(?:$|[?#])/i.test(String(value || ''));
}

function isLikelyVideoPageUrl(value) {
  const text = String(value || '').toLowerCase();
  if (!text || isImageOrAssetUrl(text)) return false;
  if (/\.(?:mp4|m4v|webm|ogv|ogg|mov|mkv|avi|mp3|m4a|aac|m3u8|mpd)(?:$|[?#])/i.test(text)) return true;
  if (/(?:youtube\.com\/(?:watch|embed|shorts)|youtu\.be\/|vimeo\.com\/|dailymotion\.com\/(?:video|embed)|dai\.ly\/|ok\.ru\/video\/|drive\.google\.com\/(?:file|open)|archive\.org\/(?:details|embed)|streamable\.com\/|rumble\.com\/|odysee\.com\/|vk\.com\/video|twitch\.tv\/videos\/)/i.test(text)) return true;
  return /\/(?:video|videos|watch|embed|player|episode|episodio|filme|movie|stream)(?:\/|\?|$)/i.test(text);
}

function cleanImportedTitle(value, fallback = '') {
  const title = cleanOkruTitle(value)
    .replace(/^(?:assistir|watch|play|view|abrir)\s*[:\-–—]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title || /^(?:view|watch|play|abrir|vídeo|video|link|clique aqui)$/i.test(title)) return cleanOkruTitle(fallback);
  return title;
}

function addGenericEntry(map, entry, baseUrl, fallbackTitle = '') {
  const sourceUrl = resolveRemoteUrl(entry.source_url || entry.url || entry.src || '', baseUrl);
  if (!sourceUrl || isImageOrAssetUrl(sourceUrl)) return;
  const existing = map.get(sourceUrl);
  const title = cleanImportedTitle(entry.title || entry.name || entry.label || '', fallbackTitle);
  const coverUrl = resolveRemoteUrl(entry.cover_url || entry.poster || entry.thumbnail || entry.image || '', baseUrl);
  const candidate = {
    source_url: sourceUrl,
    title,
    cover_url: isImageOrAssetUrl(coverUrl) ? coverUrl : '',
    group_title: cleanText(entry.group_title || entry.category || '', 300)
  };
  if (!existing || (!existing.title && candidate.title) || (!existing.cover_url && candidate.cover_url)) {
    map.set(sourceUrl, { ...(existing || {}), ...candidate });
  }
}

function parseJsonPlaylist(body, baseUrl) {
  let root;
  try { root = JSON.parse(String(body || '').replace(/^﻿/, '')); }
  catch { return []; }
  const entries = new Map();
  const seen = new Set();
  const walk = (value, depth = 0, parentTitle = '') => {
    if (depth > 10 || value === null || value === undefined) return;
    if (typeof value === 'string') return;
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, parentTitle);
      return;
    }
    const title = value.title || value.name || value.label || value.episodeTitle || value.headline || parentTitle || '';
    const cover = value.thumbnailUrl || value.thumbnail || value.poster || value.poster_url || value.cover || value.cover_url || value.image || '';
    const strongUrlKeys = ['contentUrl', 'embedUrl', 'videoUrl', 'video_url', 'streamUrl', 'stream_url', 'source_url', 'src', 'file'];
    let foundStrongUrl = false;
    for (const key of strongUrlKeys) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        addGenericEntry(entries, { source_url: candidate, title, cover_url: cover, group_title: value.category || value.group || '' }, baseUrl);
        foundStrongUrl = true;
      }
    }
    if (!foundStrongUrl) {
      for (const key of ['url', 'href', 'link']) {
        const candidate = value[key];
        if (typeof candidate === 'string' && candidate.trim()) {
          addGenericEntry(entries, { source_url: candidate, title, cover_url: cover, group_title: value.category || value.group || '' }, baseUrl);
        }
      }
    }
    for (const child of Object.values(value)) walk(child, depth + 1, title);
  };
  walk(root);
  return [...entries.values()].slice(0, MAX_GENERIC_ITEMS);
}

function extractXmlTag(block, names) {
  for (const name of names) {
    const escaped = name.replace(':', '\:');
    const match = String(block || '').match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
    if (match) return stripHtml(match[1]);
  }
  return '';
}

function extractXmlAttribute(block, names, attribute = 'url') {
  for (const name of names) {
    const escaped = name.replace(':', '\:');
    const match = String(block || '').match(new RegExp(`<${escaped}\\b[^>]*\\b${attribute}=["']([^"']+)["'][^>]*>`, 'i'));
    if (match) return match[1];
  }
  return '';
}

function parseXmlPlaylist(body, baseUrl) {
  const text = String(body || '');
  const blocks = [...text.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi)].map(match => match[1]);
  const entries = new Map();
  for (const block of blocks) {
    const title = extractXmlTag(block, ['title', 'media:title']);
    const sourceUrl = extractXmlAttribute(block, ['enclosure', 'media:content'], 'url')
      || extractXmlAttribute(block, ['link'], 'href')
      || extractXmlTag(block, ['link', 'guid']);
    const coverUrl = extractXmlAttribute(block, ['media:thumbnail'], 'url')
      || extractXmlTag(block, ['image', 'thumbnail']);
    addGenericEntry(entries, { source_url: sourceUrl, title, cover_url: coverUrl }, baseUrl);
  }
  return [...entries.values()].slice(0, MAX_GENERIC_ITEMS);
}

function getHtmlMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta\\b[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${escaped}["'][^>]*>`, 'i')
  ];
  for (const pattern of patterns) {
    const match = String(html || '').match(pattern);
    if (match) return decodeHtmlEntities(match[1]);
  }
  return '';
}

function getHtmlPageTitle(html) {
  return cleanImportedTitle(getHtmlMeta(html, 'og:title') || getHtmlMeta(html, 'twitter:title') || (String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''), '');
}

function parseHtmlPlaylist(html, baseUrl) {
  const text = String(html || '');
  const entries = new Map();
  const pageTitle = getHtmlPageTitle(text);
  const pageImage = getHtmlMeta(text, 'og:image') || getHtmlMeta(text, 'twitter:image');

  for (const match of text.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const item of parseJsonPlaylist(decodeHtmlEntities(match[1]), baseUrl)) addGenericEntry(entries, item, baseUrl, pageTitle);
  }

  const mediaTagRegex = /<(iframe|video|source)\b([^>]*)>/gi;
  for (const match of text.matchAll(mediaTagRegex)) {
    const attrs = match[2] || '';
    const sourceUrl = attrs.match(/\b(?:src|data-src|data-lazy-src)=["']([^"']+)["']/i)?.[1] || '';
    const title = attrs.match(/\b(?:title|aria-label)=["']([^"']+)["']/i)?.[1] || pageTitle;
    const poster = attrs.match(/\bposter=["']([^"']+)["']/i)?.[1] || pageImage;
    addGenericEntry(entries, { source_url: sourceUrl, title, cover_url: poster }, baseUrl, pageTitle);
  }

  const anchorRegex = /<a\b([^>]*)\bhref=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of text.matchAll(anchorRegex)) {
    const attrs = `${match[1] || ''} ${match[3] || ''}`;
    const sourceUrl = resolveRemoteUrl(match[2], baseUrl);
    const inner = match[4] || '';
    const explicitTitle = attrs.match(/\b(?:title|aria-label|data-title)=["']([^"']+)["']/i)?.[1] || '';
    const imageAlt = inner.match(/<img\b[^>]*\balt=["']([^"']+)["']/i)?.[1] || '';
    const visibleText = stripHtml(inner);
    const classText = attrs.match(/\bclass=["']([^"']+)["']/i)?.[1] || '';
    const likely = isLikelyVideoPageUrl(sourceUrl) || /video|watch|episode|episodio|filme|movie|player|embed/i.test(classText);
    if (!likely) continue;
    const image = inner.match(/<img\b[^>]*(?:src|data-src|data-lazy-src)=["']([^"']+)["']/i)?.[1] || pageImage;
    addGenericEntry(entries, {
      source_url: sourceUrl,
      title: explicitTitle || imageAlt || visibleText,
      cover_url: image
    }, baseUrl, pageTitle);
  }

  const scriptUrlRegex = /["'](?:contentUrl|embedUrl|videoUrl|video_url|streamUrl|stream_url|playerUrl|file|source_url)["']\s*:\s*["']([^"']+)["']/gi;
  for (const match of text.matchAll(scriptUrlRegex)) {
    addGenericEntry(entries, { source_url: unescapeJsonText(match[1]), title: pageTitle, cover_url: pageImage }, baseUrl, pageTitle);
  }

  const nextPages = [];
  for (const match of text.matchAll(/<a\b([^>]*)\bhref=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = `${match[1] || ''} ${match[3] || ''}`;
    const label = `${attrs} ${stripHtml(match[4] || '')}`;
    if (!/\b(?:rel=["']?next|next|próxima|proxima|seguinte|mais vídeos|more videos|load more)\b/i.test(label)) continue;
    const nextUrl = resolveRemoteUrl(match[2], baseUrl);
    if (nextUrl) nextPages.push(nextUrl);
  }

  return { entries: [...entries.values()].slice(0, MAX_GENERIC_ITEMS), nextPages: [...new Set(nextPages)], title: pageTitle };
}

function buildRecordsFromGenericEntries(entries, defaults = {}, collectionTitle = '') {
  const defaultSeries = cleanText(defaults.series_title, 180);
  const contentTypeRequested = cleanText(defaults.content_type, 20);
  const treatAsSeries = Boolean(defaultSeries || contentTypeRequested === 'episode');
  const inferredSeries = cleanImportedTitle(collectionTitle, '').replace(/\s*(?:playlist|vídeos?|videos?|canal|episodes?|episódios?)\s*$/i, '').trim();
  const fallbackSeries = defaultSeries || (treatAsSeries ? inferredSeries : '');
  const defaultSeason = cleanNullableInt(defaults.season) ?? 1;
  const firstEpisode = cleanNullableInt(defaults.episode) ?? 1;
  const common = {
    description: cleanText(defaults.description, 5000),
    year: cleanNullableInt(defaults.year),
    genres: cleanText(defaults.genres, 300),
    category: cleanText(defaults.category, 300),
    cover_url: cleanHttpUrl(defaults.cover_url, 2000),
    backdrop_url: cleanHttpUrl(defaults.backdrop_url, 2000),
    tmdb_id: cleanNullableInt(defaults.tmdb_id),
    tmdb_type: ALLOWED_TMDB_TYPES.has(cleanText(defaults.tmdb_type, 20)) ? cleanText(defaults.tmdb_type, 20) : '',
    featured: false,
    published: defaults.published !== false
  };

  return entries.slice(0, MAX_GENERIC_ITEMS).map((entry, index) => {
    const rawTitle = cleanImportedTitle(entry.title, `Vídeo ${index + 1}`);
    const info = parseEpisodeInfo(rawTitle, fallbackSeries);
    const isEpisode = treatAsSeries || Boolean(info?.seriesTitle);
    const seriesTitle = isEpisode ? (fallbackSeries || info?.seriesTitle || '') : '';
    const season = isEpisode ? (info?.season ?? defaultSeason) : null;
    const episode = isEpisode ? (info?.episode ?? (firstEpisode + index)) : null;
    const title = isEpisode
      ? (cleanImportedTitle(info?.episodeTitle || removeSeriesPrefix(rawTitle, seriesTitle), '') || `Episódio ${episode}`)
      : rawTitle;
    return normalizeTitle({
      ...common,
      title,
      series_title: seriesTitle,
      content_type: isEpisode && seriesTitle ? 'episode' : 'movie',
      season,
      episode,
      source_url: entry.source_url,
      source_type: detectSourceType(entry.source_url),
      cover_url: common.cover_url || cleanHttpUrl(entry.cover_url, 2000),
      category: common.category || cleanText(entry.group_title, 300)
    });
  });
}

async function readGenericCollection(inputUrl) {
  const startUrl = await assertPublicRemoteUrl(inputUrl);
  if (isOkruHost(startUrl.hostname) && /^\/video\/c\d+/i.test(startUrl.pathname)) {
    const collection = await readOkruCollection(startUrl.toString());
    return { format: 'okru', title: collection.title, entries: collection.entries.map(item => ({
      source_url: `https://ok.ru/video/${item.id}`,
      title: item.title,
      cover_url: item.poster || ''
    })), pages: null, expected: collection.expectedCount || null, complete: collection.complete !== false };
  }

  if (/\.(?:mp4|m4v|webm|ogv|ogg|mov|mkv|mp3|m4a|aac|mpd)(?:$|[?#])/i.test(startUrl.toString())) {
    return { format: 'direct', title: '', entries: [{ source_url: startUrl.toString(), title: '' }], pages: 1, complete: true };
  }

  const first = await fetchPublicResource(startUrl);
  const body = first.body;
  const type = first.contentType;
  const finalUrl = first.finalUrl;

  if (/json/.test(type) || /^[\s﻿]*[\[{]/.test(body)) {
    const entries = parseJsonPlaylist(body, finalUrl);
    if (entries.length) return { format: 'json', title: '', entries, pages: 1, complete: true };
  }

  if (/xml|rss|atom/.test(type) || /<(?:rss|feed|channel)\b/i.test(body)) {
    const entries = parseXmlPlaylist(body, finalUrl);
    if (entries.length) return { format: 'rss/xml', title: extractXmlTag(body, ['title']), entries, pages: 1, complete: true };
  }

  const looksM3u = /#EXTM3U|#EXTINF:/i.test(body) || /mpegurl/.test(type) || /\.(?:m3u|m3u8|txt)(?:$|[?#])/i.test(finalUrl.toString());
  if (looksM3u) {
    if (/#EXT-X-(?:TARGETDURATION|MEDIA-SEQUENCE|STREAM-INF)/i.test(body)) {
      return { format: 'hls', title: '', entries: [{ source_url: finalUrl.toString(), title: '' }], pages: 1, complete: true };
    }
    const records = parsePlaylist(body, {});
    return { format: 'm3u/txt', title: '', entries: records.map(record => ({ source_url: record.source_url, title: record.title, cover_url: record.cover_url, group_title: record.category })), pages: 1, complete: true };
  }

  if (!/html/.test(type) && !/<html\b|<a\b|<iframe\b|<video\b/i.test(body)) {
    const urls = [...body.matchAll(/https?:\/\/[^\s<>"']+/gi)].map(match => match[0]);
    const entries = new Map();
    for (const url of urls) addGenericEntry(entries, { source_url: url, title: '' }, finalUrl, '');
    if (entries.size) return { format: 'texto', title: '', entries: [...entries.values()], pages: 1, complete: true };
  }

  const queue = [finalUrl.toString()];
  const visited = new Set();
  const allEntries = new Map();
  let collectionTitle = '';
  let pages = 0;
  while (queue.length && pages < MAX_GENERIC_PAGES && allEntries.size < MAX_GENERIC_ITEMS) {
    const pageUrl = queue.shift();
    if (visited.has(pageUrl)) continue;
    visited.add(pageUrl);
    const resource = pages === 0 && pageUrl === finalUrl.toString() ? first : await fetchPublicResource(pageUrl);
    pages += 1;
    const parsed = parseHtmlPlaylist(resource.body, resource.finalUrl);
    collectionTitle ||= parsed.title;
    for (const entry of parsed.entries) addGenericEntry(allEntries, entry, resource.finalUrl, parsed.title || collectionTitle);
    for (const next of parsed.nextPages) {
      try {
        const nextUrl = new URL(next);
        if (nextUrl.hostname === finalUrl.hostname && !visited.has(nextUrl.toString()) && queue.length < MAX_GENERIC_PAGES) queue.push(nextUrl.toString());
      } catch {}
    }
  }
  if (!allEntries.size) throw new Error('Não encontrei links de vídeo nessa página. Ela pode carregar tudo por JavaScript, exigir login ou bloquear o servidor.');
  return { format: 'página HTML', title: collectionTitle, entries: [...allEntries.values()].slice(0, MAX_GENERIC_ITEMS), pages, complete: queue.length === 0 };
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

function comparableDescription(value) {
  return cleanText(value, 5000)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ')
    .trim();
}

function likelySeriesDescriptionFromCatalog(episodes) {
  const counts = new Map();

  for (const item of episodes) {
    const description = cleanText(item.description, 5000);
    const key = comparableDescription(description);
    if (!key) continue;

    const current = counts.get(key) || {
      count: 0,
      description
    };

    current.count += 1;
    counts.set(key, current);
  }

  const repeated = [...counts.values()]
    .filter(entry => entry.count >= 2)
    .sort((a, b) => b.count - a.count)[0];

  return repeated ? repeated.description : '';
}

async function loadTmdbSeriesBundle(tmdbId, seasons) {
  const normalizedSeasons = [...new Set(seasons.filter(Number.isInteger))]
    .sort((a, b) => a - b);

  const cacheKey = `${tmdbId}:${normalizedSeasons.join(',')}`;
  const cached = seriesTmdbCache.get(cacheKey);

  if (cached && Date.now() - cached.createdAt < 20 * 60 * 1000) {
    return cached.value;
  }

  const detailsPromise = tmdbRequest(`/tv/${tmdbId}`).catch(() => null);
  const seasonResults = await mapWithConcurrency(
    normalizedSeasons,
    3,
    async season => {
      try {
        return {
          season,
          data: await tmdbRequest(`/tv/${tmdbId}/season/${season}`)
        };
      } catch {
        return {
          season,
          data: null
        };
      }
    }
  );

  const details = await detailsPromise;
  const episodeData = new Map();

  for (const result of seasonResults) {
    for (const episode of result.data?.episodes || []) {
      episodeData.set(
        `${result.season}:${episode.episode_number}`,
        episode
      );
    }
  }

  const value = {
    details,
    episodeData
  };

  seriesTmdbCache.set(cacheKey, {
    createdAt: Date.now(),
    value
  });

  while (seriesTmdbCache.size > 30) {
    seriesTmdbCache.delete(seriesTmdbCache.keys().next().value);
  }

  return value;
}

async function hydrateSeriesForPublic(episodes) {
  const repeatedDescription = likelySeriesDescriptionFromCatalog(episodes);
  const repeatedDescriptionKey = comparableDescription(repeatedDescription);
  const sample = episodes.find(item =>
    item.content_type === 'episode' &&
    Number.isInteger(Number(item.tmdb_id)) &&
    Number(item.tmdb_id) > 0 &&
    (!item.tmdb_type || item.tmdb_type === 'tv')
  );

  let details = null;
  let episodeData = new Map();

  if (HAS_TMDB && sample) {
    const bundle = await loadTmdbSeriesBundle(
      Number(sample.tmdb_id),
      episodes.map(item => Number(item.season)).filter(Number.isInteger)
    );

    details = bundle.details;
    episodeData = bundle.episodeData;
  }

  const seriesDescription =
    cleanText(details?.overview, 5000) ||
    repeatedDescription ||
    '';

  const seriesDescriptionKey = comparableDescription(seriesDescription);

  const hydratedEpisodes = episodes.map(item => {
    const tmdbEpisode = episodeData.get(`${item.season}:${item.episode}`);
    const storedDescription = cleanText(item.description, 5000);
    const storedKey = comparableDescription(storedDescription);

    const storedLooksLikeSeriesDescription = Boolean(
      storedKey &&
      (
        storedKey === repeatedDescriptionKey ||
        storedKey === seriesDescriptionKey
      )
    );

    const episodeDescription =
      cleanText(tmdbEpisode?.overview, 5000) ||
      (storedLooksLikeSeriesDescription ? '' : storedDescription);

    const currentTitle = cleanText(item.title, 180);
    const genericTitle =
      /^(?:epis[óo]dio|ep)\s*\d+$/i.test(currentTitle) ||
      isGenericVideoTitle(currentTitle);

    return {
      ...item,
      title:
        genericTitle && tmdbEpisode?.name
          ? cleanText(tmdbEpisode.name, 180)
          : currentTitle,
      episode_image_url:
        tmdbImage(tmdbEpisode?.still_path, 'w780') ||
        item.episode_image_url ||
        '',
      description: episodeDescription
    };
  });

  const first = hydratedEpisodes[0] || {};

  return {
    title: first.series_title || details?.name || '',
    description: seriesDescription,
    year:
      details?.first_air_date && /^\d{4}/.test(details.first_air_date)
        ? Number(details.first_air_date.slice(0, 4))
        : first.year || null,
    genres:
      Array.isArray(details?.genres) && details.genres.length
        ? details.genres.map(genre => genre.name).join(', ')
        : first.genres || '',
    cover_url:
      tmdbImage(details?.poster_path, 'w500') ||
      first.cover_url ||
      '',
    backdrop_url:
      tmdbImage(details?.backdrop_path, 'original') ||
      first.backdrop_url ||
      first.cover_url ||
      '',
    episodes: hydratedEpisodes
  };
}

async function resolveImportDefaults(defaults = {}, target = {}) {
  const targetSeriesTitle = cleanText(target.series_title, 180);

  if (!targetSeriesTitle) {
    return defaults;
  }

  const requestedSeason = cleanNullableInt(target.season);
  const catalog = await readCatalog({ force: true });
  const normalizedTarget = targetSeriesTitle.toLocaleLowerCase('pt-BR');

  const matching = catalog.filter(item =>
    item.content_type === 'episode' &&
    cleanText(item.series_title, 180).toLocaleLowerCase('pt-BR') === normalizedTarget &&
    (
      requestedSeason === null ||
      cleanNullableInt(item.season) === requestedSeason
    )
  );

  if (!matching.length) {
    throw new Error('A playlist/série escolhida não existe mais.');
  }

  const season = requestedSeason ?? cleanNullableInt(matching[0].season) ?? 1;
  const sameSeason = matching.filter(item =>
    (cleanNullableInt(item.season) ?? 1) === season
  );

  const sample =
    sameSeason.find(item => item.tmdb_type === 'tv' && item.tmdb_id) ||
    sameSeason[0] ||
    matching[0];

  const nextEpisode =
    sameSeason.reduce(
      (maximum, item) =>
        Math.max(maximum, cleanNullableInt(item.episode) ?? 0),
      0
    ) + 1;

  return {
    ...defaults,
    content_type: 'episode',
    series_title: sample.series_title,
    season,
    episode: nextEpisode,
    // Não copia a descrição geral da série para os novos episódios.
    description: '',
    year: sample.year ?? defaults.year ?? null,
    genres: sample.genres || defaults.genres || '',
    category: sample.category || defaults.category || '',
    cover_url: sample.cover_url || defaults.cover_url || '',
    backdrop_url: sample.backdrop_url || defaults.backdrop_url || '',
    tmdb_id: sample.tmdb_id ?? defaults.tmdb_id ?? null,
    tmdb_type: sample.tmdb_type || defaults.tmdb_type || ''
  };
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

    if (!episodes.length) {
      return res.status(404).json({
        error: 'Série não encontrada.'
      });
    }

    const series = await hydrateSeriesForPublic(episodes);

    res.json({
      title: series.title,
      series: {
        title: series.title,
        description: series.description,
        year: series.year,
        genres: series.genres,
        cover_url: series.cover_url,
        backdrop_url: series.backdrop_url
      },
      episodes: series.episodes
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/catalog/:id', async (req, res, next) => {
  try {
    let item = await findTitle(req.params.id, true);

    if (!item) {
      return res.status(404).json({
        error: 'Conteúdo não encontrado.'
      });
    }

    // Também corrige a descrição quando um episódio é aberto diretamente.
    if (
      item.content_type === 'episode' &&
      item.series_title
    ) {
      const seriesEpisodes = await findSeries(
        item.series_title,
        true
      );

      const hydrated = await hydrateSeriesForPublic(
        seriesEpisodes
      );

      item =
        hydrated.episodes.find(
          episode =>
            Number(episode.id) ===
            Number(item.id)
        ) ||
        item;
    }

    res.json(item);
  } catch (error) {
    next(error);
  }
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
    const defaults = await resolveImportDefaults(
      req.body.defaults || {},
      req.body.target || {}
    );

    let records = parsePlaylist(req.body.content, defaults);
    records = await enrichEpisodeRecordsWithTmdb(records);

    const result = await createManyTitles(records, {
      updateExisting: true
    });

    res.status(201).json({
      ...result,
      parsed: records.length,
      target_series: defaults.series_title || '',
      target_season: defaults.season ?? null,
      importer_version: IMPORTER_VERSION
    });
  } catch (error) {
    if (/playlist|Nenhum|link|Digite|Cole|inválido|série/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});


app.post('/api/admin/import-url', requireAdmin, async (req, res, next) => {
  try {
    const target = req.body.target || {};
    const appendingToExisting =
      Boolean(cleanText(target.series_title, 180));

    const defaults = await resolveImportDefaults(
      req.body.defaults || {},
      target
    );

    const inputUrl = cleanText(req.body.url, 4000);
    if (!inputUrl) return res.status(400).json({ error: 'Cole o link da playlist, feed ou página.' });
    const collection = await readGenericCollection(inputUrl);
    let records = buildRecordsFromGenericEntries(collection.entries, defaults, collection.title);
    records = await enrichEpisodeRecordsWithTmdb(records);
    const result = await createManyTitles(records, {
      updateExisting: true,
      removeSourceUrls: appendingToExisting
        ? []
        : [cleanHttpUrl(inputUrl, 4000)]
    });
    res.status(201).json({
      ...result,
      parsed: records.length,
      found: collection.entries.length,
      format: collection.format,
      pages: collection.pages,
      expected: collection.expected || null,
      complete: collection.complete !== false,
      importer_version: IMPORTER_VERSION,
      target_series: defaults.series_title || '',
      target_season: defaults.season ?? null
    });
  } catch (error) {
    if (/link|playlist|página|site|vídeo|feed|pública|acesso|endereço|JavaScript|login|bloque/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

app.post('/api/admin/import-okru', requireAdmin, async (req, res, next) => {
  try {
    const target = req.body.target || {};
    const appendingToExisting =
      Boolean(cleanText(target.series_title, 180));

    const defaults = await resolveImportDefaults(
      req.body.defaults || {},
      target
    );

    const collection = await readOkruCollection(req.body.url);
    let records = buildRecordsFromOkru(collection.entries, defaults, collection.title);
    records = await enrichEpisodeRecordsWithTmdb(records);
    const playlistUrl = normalizeOkruUrl(req.body.url).toString();
    const result = await createManyTitles(records, {
      updateExisting: true,
      removeSourceUrls: appendingToExisting
        ? []
        : [playlistUrl]
    });
    res.status(201).json({
      ...result,
      parsed: records.length,
      playlist_title: collection.title || '',
      found: collection.entries.length,
      expected: collection.expectedCount || null,
      complete: collection.complete !== false,
      importer_version: IMPORTER_VERSION,
      target_series: defaults.series_title || '',
      target_season: defaults.season ?? null
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

app.get('/api/admin/importer-version', requireAdmin, (req, res) => res.json({ version: IMPORTER_VERSION }));

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
  isGenericVideoTitle,
  chooseBestOkruTitle,
  readOkruCollection,
  enrichEpisodeRecordsWithTmdb,
  parseJsonPlaylist,
  parseXmlPlaylist,
  parseHtmlPlaylist,
  buildRecordsFromGenericEntries,
  readGenericCollection
};
