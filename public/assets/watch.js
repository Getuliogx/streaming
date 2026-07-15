'use strict';

const playerMount = document.querySelector('#playerMount');
const watchTitle = document.querySelector('#watchTitle');
const watchEyebrow = document.querySelector('#watchEyebrow');
const watchMeta = document.querySelector('#watchMeta');
const watchDescription = document.querySelector('#watchDescription');
const watchError = document.querySelector('#watchError');
const favoriteButton = document.querySelector('#favoriteButton');

const params = new URLSearchParams(location.search);
const id = Number(params.get('id'));
let currentItem = null;

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

function buildVideo(src, isHls = false) {
  const video = document.createElement('video');
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.crossOrigin = 'anonymous';

  if (isHls && window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ enableWorker: true });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (data.fatal) showError('Não foi possível carregar o vídeo HLS.');
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
    buildVideo(item.source_url, true);
    return;
  }
  buildVideo(item.source_url, false);
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
    const response = await fetch(`/api/catalog/${id}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Conteúdo não encontrado.');
    currentItem = body;
    document.title = `${body.title} | Minha Stream`;
    watchTitle.textContent = body.title;
    watchEyebrow.textContent = body.series_title || (body.content_type === 'episode' ? 'EPISÓDIO' : 'FILME / VÍDEO');
    const meta = [];
    if (body.year) meta.push(body.year);
    if (body.season !== null) meta.push(`Temporada ${body.season}`);
    if (body.episode !== null) meta.push(`Episódio ${body.episode}`);
    if (body.genres) meta.push(body.genres);
    watchMeta.textContent = meta.join(' • ');
    watchDescription.textContent = body.description || 'Sem descrição.';
    mountPlayer(body);
    addToHistory(body);
    updateFavoriteButton();
  } catch (error) {
    playerMount.innerHTML = '';
    watchTitle.textContent = 'Não foi possível abrir';
    showError(error.message);
  }
}

loadItem();
