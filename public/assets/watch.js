'use strict';

const playerMount = document.querySelector('#playerMount');
const watchTitle = document.querySelector('#watchTitle');
const watchEyebrow = document.querySelector('#watchEyebrow');
const watchMeta = document.querySelector('#watchMeta');
const watchDescription = document.querySelector('#watchDescription');
const watchError = document.querySelector('#watchError');
const favoriteButton = document.querySelector('#favoriteButton');
const relatedEpisodes = document.querySelector('#relatedEpisodes');
const watchSeasonTabs = document.querySelector('#watchSeasonTabs');
const watchEpisodeList = document.querySelector('#watchEpisodeList');
const previousEpisode = document.querySelector('#previousEpisode');
const nextEpisode = document.querySelector('#nextEpisode');
const seriesBackButton = document.querySelector('#seriesBackButton');

const params = new URLSearchParams(location.search);
const id = Number(params.get('id'));
let currentItem = null;
let seriesEpisodes = [];
let activeSeason = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function extractDriveId(value) {
  const text = String(value || '').trim();
  const match = text.match(/\/d\/([a-zA-Z0-9_-]+)/) || text.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : text;
}

function extractOkId(value) {
  const text = String(value || '').trim();
  const match = text.match(/(?:videoembed|video)\/(\d+)/) || text.match(/(\d{6,})/);
  return match ? match[1] : text;
}

function buildIframe(src, title) {
  const iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.title = title;
  iframe.allow = 'autoplay; fullscreen; picture-in-picture';
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  playerMount.replaceChildren(iframe);
}

function buildVideo(src, isHls = false, poster = '') {
  const video = document.createElement('video');
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  if (poster) video.poster = poster;

  if (isHls && window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ enableWorker: true });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (data.fatal) showError('Não foi possível carregar o vídeo HLS. O servidor do vídeo precisa permitir CORS.');
    });
  } else {
    video.src = src;
  }
  playerMount.replaceChildren(video);
}

function mountPlayer(item) {
  if (item.source_type === 'okru') {
    buildIframe(`https://ok.ru/videoembed/${encodeURIComponent(extractOkId(item.source_url))}`, item.title);
    return;
  }
  if (item.source_type === 'gdrive') {
    buildIframe(`https://drive.google.com/file/d/${encodeURIComponent(extractDriveId(item.source_url))}/preview`, item.title);
    return;
  }
  if (item.source_type === 'hls') {
    buildVideo(item.source_url, true, item.episode_image_url || item.backdrop_url || item.cover_url || '');
    return;
  }
  if (item.source_type === 'iframe') {
    buildIframe(item.source_url, item.title);
    return;
  }
  buildVideo(item.source_url, false, item.episode_image_url || item.backdrop_url || item.cover_url || '');
}

function showError(message) {
  watchError.textContent = message;
  watchError.classList.remove('hidden');
}

function getFavorites() {
  try { return JSON.parse(localStorage.getItem('streamFavorites') || '[]'); }
  catch { return []; }
}

function updateFavoriteButton() {
  const favorites = getFavorites();
  favoriteButton.textContent = favorites.includes(id) ? '♥ Favoritado' : '♡ Favoritar';
}

function addToHistory(item) {
  let history = [];
  try { history = JSON.parse(localStorage.getItem('streamHistory') || '[]'); } catch {}
  history = history.filter(entry => Number(entry.id) !== Number(item.id));
  history.unshift({ id: item.id, title: item.title, watched_at: new Date().toISOString() });
  localStorage.setItem('streamHistory', JSON.stringify(history.slice(0, 50)));
}

function seasonKey(value) {
  return value === null || value === undefined ? 'null' : String(value);
}

function seasonLabel(value) {
  if (value === null || value === undefined) return 'Sem temporada';
  if (Number(value) === 0) return 'Especiais';
  return `Temporada ${value}`;
}

function episodeTitle(item) {
  const raw = String(item.title || '').trim();
  const series = String(item.series_title || '').trim();
  if (!raw || raw.toLocaleLowerCase('pt-BR') === series.toLocaleLowerCase('pt-BR')) {
    return `Episódio ${item.episode ?? ''}`.trim();
  }
  return raw;
}

function episodesForSeason(season) {
  return seriesEpisodes.filter(item => (item.season ?? null) === season);
}

function renderSeasonTabs() {
  const seasons = [...new Set(seriesEpisodes.map(item => item.season ?? null))]
    .sort((a, b) => (a ?? -1) - (b ?? -1));

  watchSeasonTabs.innerHTML = seasons.map(season => `
    <button class="season-button ${season === activeSeason ? 'active' : ''}" type="button" data-season="${seasonKey(season)}">
      ${escapeHtml(seasonLabel(season))}
    </button>`).join('');
}

function renderWatchEpisodes() {
  const filtered = episodesForSeason(activeSeason);
  watchEpisodeList.innerHTML = filtered.map(item => {
    const active = Number(item.id) === id;
    const image = item.episode_image_url || item.backdrop_url || item.cover_url || '';
    const number = item.episode !== null && item.episode !== undefined ? `E${item.episode}` : 'EP';
    const thumb = image
      ? `<img src="${escapeHtml(image)}" alt="Capa do episódio ${escapeHtml(item.episode ?? '')}" loading="lazy">`
      : `<div class="episode-thumb-placeholder">${escapeHtml(number)}</div>`;

    return `
      <a class="watch-episode-card ${active ? 'active' : ''}" href="/watch.html?id=${item.id}">
        <div class="watch-episode-thumb">
          ${thumb}
          <span>${active ? 'ASSISTINDO' : number}</span>
          <b>▶</b>
        </div>
        <div>
          <small>${escapeHtml(seasonLabel(item.season))} • ${escapeHtml(item.episode !== null && item.episode !== undefined ? `Episódio ${item.episode}` : 'Episódio')}</small>
          <strong>${escapeHtml(episodeTitle(item))}</strong>
        </div>
      </a>`;
  }).join('');
}

function setSeason(season) {
  activeSeason = season;
  renderSeasonTabs();
  renderWatchEpisodes();
}

function updatePreviousNext() {
  const index = seriesEpisodes.findIndex(item => Number(item.id) === id);
  const previous = index > 0 ? seriesEpisodes[index - 1] : null;
  const next = index >= 0 && index < seriesEpisodes.length - 1 ? seriesEpisodes[index + 1] : null;

  previousEpisode.classList.toggle('hidden', !previous);
  nextEpisode.classList.toggle('hidden', !next);
  if (previous) previousEpisode.href = `/watch.html?id=${previous.id}`;
  if (next) nextEpisode.href = `/watch.html?id=${next.id}`;
}

async function loadRelatedEpisodes(seriesTitle) {
  try {
    const response = await fetch(`/api/series?title=${encodeURIComponent(seriesTitle)}`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Não foi possível carregar os episódios.');

    seriesEpisodes = (body.episodes || []).sort((a, b) => (Number(a.season) || 0) - (Number(b.season) || 0)
      || (Number(a.episode) || 0) - (Number(b.episode) || 0)
      || Number(a.id) - Number(b.id));

    activeSeason = currentItem.season ?? seriesEpisodes[0]?.season ?? null;
    renderSeasonTabs();
    renderWatchEpisodes();
    updatePreviousNext();
    relatedEpisodes.classList.remove('hidden');
    seriesBackButton.href = `/series.html?title=${encodeURIComponent(seriesTitle)}&season=${activeSeason ?? ''}&episode=${id}`;
    seriesBackButton.classList.remove('hidden');
  } catch (error) {
    console.error(error);
  }
}

watchSeasonTabs.addEventListener('click', event => {
  const button = event.target.closest('button[data-season]');
  if (!button) return;
  const season = button.dataset.season === 'null' ? null : Number(button.dataset.season);
  setSeason(season);
});

favoriteButton.addEventListener('click', () => {
  const favorites = getFavorites();
  const next = favorites.includes(id) ? favorites.filter(itemId => itemId !== id) : [id, ...favorites];
  localStorage.setItem('streamFavorites', JSON.stringify(next));
  updateFavoriteButton();
});

async function loadItem() {
  if (!Number.isInteger(id) || id < 1) {
    showError('Link de conteúdo inválido.');
    return;
  }

  try {
    const response = await fetch(`/api/catalog/${id}`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Conteúdo não encontrado.');

    currentItem = body;
    const visibleTitle = body.content_type === 'episode' ? episodeTitle(body) : body.title;
    document.title = `${visibleTitle} | Minha Stream`;
    watchTitle.textContent = visibleTitle;
    watchEyebrow.textContent = body.series_title || (body.content_type === 'episode' ? 'EPISÓDIO' : 'FILME / VÍDEO');

    const meta = [];
    if (body.year) meta.push(body.year);
    if (body.season !== null && body.season !== undefined) meta.push(`Temporada ${body.season}`);
    if (body.episode !== null && body.episode !== undefined) meta.push(`Episódio ${body.episode}`);
    if (body.genres) meta.push(body.genres);
    watchMeta.textContent = meta.join(' • ');
    watchDescription.textContent = body.description || 'Sem descrição.';

    mountPlayer(body);
    addToHistory(body);
    updateFavoriteButton();
    if (body.content_type === 'episode' && body.series_title) await loadRelatedEpisodes(body.series_title);
  } catch (error) {
    playerMount.innerHTML = '';
    watchTitle.textContent = 'Não foi possível abrir';
    showError(error.message);
  }
}

loadItem();
