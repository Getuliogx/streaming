'use strict';

const playerMount = document.querySelector('#playerMount');
const unifiedVideo = document.querySelector('#unifiedVideo');
const playerLoading = document.querySelector('#playerLoading');
const playerBigPlay = document.querySelector('#playerBigPlay');
const playerControls = document.querySelector('#playerControls');
const playerPlayPause = document.querySelector('#playerPlayPause');
const playerProgress = document.querySelector('#playerProgress');
const playerCurrentTime = document.querySelector('#playerCurrentTime');
const playerDuration = document.querySelector('#playerDuration');
const playerMute = document.querySelector('#playerMute');
const playerVolume = document.querySelector('#playerVolume');
const playerFullscreen = document.querySelector('#playerFullscreen');

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
let hlsInstance = null;
let playerReady = false;
let seeking = false;
let controlsTimer = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  })[character]);
}

function formatTime(value) {
  const total = Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function setLoading(visible, text = 'Preparando vídeo…') {
  playerLoading.classList.toggle('hidden', !visible);
  const label = playerLoading.querySelector('b');
  if (label) label.textContent = text;
}

function showControls() {
  playerMount.classList.remove('controls-hidden');
  clearTimeout(controlsTimer);

  if (!unifiedVideo.paused) {
    controlsTimer = setTimeout(() => {
      playerMount.classList.add('controls-hidden');
    }, 2800);
  }
}

function destroyPlayerSource() {
  if (hlsInstance) {
    try {
      hlsInstance.destroy();
    } catch {}
    hlsInstance = null;
  }

  try {
    unifiedVideo.pause();
    unifiedVideo.removeAttribute('src');
    unifiedVideo.load();
  } catch {}

  playerReady = false;
  playerBigPlay.classList.add('hidden');
  playerPlayPause.textContent = '▶';
  playerProgress.value = '0';
  playerCurrentTime.textContent = '0:00';
  playerDuration.textContent = '0:00';
}

function updatePlayButtons() {
  const playing = !unifiedVideo.paused && !unifiedVideo.ended;
  playerPlayPause.textContent = playing ? '❚❚' : '▶';
  playerPlayPause.setAttribute(
    'aria-label',
    playing ? 'Pausar' : 'Reproduzir'
  );

  playerBigPlay.classList.toggle('hidden', playing || !playerReady);
  playerBigPlay.textContent = unifiedVideo.ended ? '↻' : '▶';

  if (playing) showControls();
}

function updateTimeline() {
  playerCurrentTime.textContent = formatTime(unifiedVideo.currentTime);
  playerDuration.textContent = formatTime(unifiedVideo.duration);

  if (!seeking && Number.isFinite(unifiedVideo.duration) && unifiedVideo.duration > 0) {
    playerProgress.value = String(
      Math.round((unifiedVideo.currentTime / unifiedVideo.duration) * 1000)
    );
  }
}

function updateVolumeButton() {
  const muted = unifiedVideo.muted || unifiedVideo.volume === 0;
  playerMute.textContent = muted ? '🔇' : unifiedVideo.volume < 0.5 ? '🔉' : '🔊';
  playerMute.setAttribute(
    'aria-label',
    muted ? 'Ativar som' : 'Silenciar'
  );
}

async function togglePlayback() {
  if (!playerReady) return;

  try {
    if (unifiedVideo.paused || unifiedVideo.ended) {
      if (unifiedVideo.ended) unifiedVideo.currentTime = 0;
      await unifiedVideo.play();
    } else {
      unifiedVideo.pause();
    }
  } catch {
    showError('O navegador não conseguiu iniciar a reprodução.');
  }
}

async function mountUniversalPlayer(item) {
  destroyPlayerSource();
  watchError.classList.add('hidden');
  setLoading(true, 'Preparando vídeo e áudio no player único…');

  const response = await fetch(
    `/api/player-source/${encodeURIComponent(item.id)}`,
    {
      cache: 'no-store'
    }
  );

  const source = await response.json();

  if (!response.ok) {
    throw new Error(
      source.error ||
      'Não foi possível preparar o vídeo para o player único.'
    );
  }

  if (source.player !== 'universal-video') {
    throw new Error('O servidor não retornou o player único.');
  }

  unifiedVideo.poster =
    source.poster ||
    item.episode_image_url ||
    item.backdrop_url ||
    item.cover_url ||
    '';

  if (source.kind === 'hls') {
    if (unifiedVideo.canPlayType('application/vnd.apple.mpegurl')) {
      unifiedVideo.src = source.url;
    } else if (
      window.Hls &&
      window.Hls.isSupported()
    ) {
      hlsInstance = new window.Hls({
        enableWorker: true,
        maxBufferLength: 60
      });

      hlsInstance.loadSource(source.url);
      hlsInstance.attachMedia(unifiedVideo);

      hlsInstance.on(
        window.Hls.Events.ERROR,
        (_, data) => {
          if (data.fatal) {
            showError('Não foi possível carregar o vídeo HLS.');
          }
        }
      );
    } else {
      throw new Error('Este navegador não suporta vídeo HLS.');
    }
  } else {
    unifiedVideo.src = source.url;
  }

  unifiedVideo.load();
}

function showError(message) {
  setLoading(false);
  playerBigPlay.classList.add('hidden');
  watchError.textContent = message;
  watchError.classList.remove('hidden');
}

unifiedVideo.addEventListener('loadedmetadata', () => {
  playerReady = true;
  setLoading(false);
  updateTimeline();
  updatePlayButtons();
  showControls();
});

unifiedVideo.addEventListener('canplay', () => {
  playerReady = true;
  setLoading(false);
  updatePlayButtons();
});

unifiedVideo.addEventListener('waiting', () => {
  if (playerReady && !unifiedVideo.paused) {
    setLoading(true, 'Carregando…');
  }
});

unifiedVideo.addEventListener('playing', () => {
  setLoading(false);
  updatePlayButtons();
});

unifiedVideo.addEventListener('pause', updatePlayButtons);
unifiedVideo.addEventListener('ended', updatePlayButtons);
unifiedVideo.addEventListener('timeupdate', updateTimeline);
unifiedVideo.addEventListener('durationchange', updateTimeline);
unifiedVideo.addEventListener('volumechange', updateVolumeButton);

unifiedVideo.addEventListener('error', () => {
  if (unifiedVideo.error) {
    showError(
      'O servidor não conseguiu preparar o vídeo e o áudio para reprodução.'
    );
  }
});

playerBigPlay.addEventListener('click', togglePlayback);
playerPlayPause.addEventListener('click', togglePlayback);

unifiedVideo.addEventListener('click', togglePlayback);
unifiedVideo.addEventListener('dblclick', () => {
  playerFullscreen.click();
});

playerProgress.addEventListener('input', () => {
  seeking = true;

  if (Number.isFinite(unifiedVideo.duration) && unifiedVideo.duration > 0) {
    const preview =
      (Number(playerProgress.value) / 1000) *
      unifiedVideo.duration;

    playerCurrentTime.textContent = formatTime(preview);
  }
});

playerProgress.addEventListener('change', () => {
  if (Number.isFinite(unifiedVideo.duration) && unifiedVideo.duration > 0) {
    unifiedVideo.currentTime =
      (Number(playerProgress.value) / 1000) *
      unifiedVideo.duration;
  }

  seeking = false;
});

playerMute.addEventListener('click', () => {
  unifiedVideo.muted = !unifiedVideo.muted;
});

playerVolume.addEventListener('input', () => {
  unifiedVideo.volume = Number(playerVolume.value);
  unifiedVideo.muted = unifiedVideo.volume === 0;
});

playerFullscreen.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await playerMount.requestFullscreen();
    }
  } catch {
    showError('Não foi possível abrir a tela cheia.');
  }
});

playerMount.addEventListener('mousemove', showControls);
playerMount.addEventListener('touchstart', showControls, {
  passive: true
});

playerMount.addEventListener('keydown', event => {
  if (event.target.matches('input, button, a')) return;

  if (event.code === 'Space' || event.code === 'KeyK') {
    event.preventDefault();
    togglePlayback();
  }

  if (event.code === 'ArrowRight') {
    unifiedVideo.currentTime = Math.min(
      unifiedVideo.duration || 0,
      unifiedVideo.currentTime + 10
    );
  }

  if (event.code === 'ArrowLeft') {
    unifiedVideo.currentTime = Math.max(
      0,
      unifiedVideo.currentTime - 10
    );
  }

  if (event.code === 'KeyM') {
    unifiedVideo.muted = !unifiedVideo.muted;
  }

  if (event.code === 'KeyF') {
    playerFullscreen.click();
  }
});

function getFavorites() {
  try {
    return JSON.parse(
      localStorage.getItem('streamFavorites') ||
      '[]'
    );
  } catch {
    return [];
  }
}

function updateFavoriteButton() {
  const favorites = getFavorites();

  favoriteButton.textContent =
    favorites.includes(id)
      ? '♥ Favoritado'
      : '♡ Favoritar';
}

function addToHistory(item) {
  let history = [];

  try {
    history = JSON.parse(
      localStorage.getItem('streamHistory') ||
      '[]'
    );
  } catch {}

  history = history.filter(
    entry =>
      Number(entry.id) !==
      Number(item.id)
  );

  history.unshift({
    id: item.id,
    title: item.title,
    watched_at: new Date().toISOString()
  });

  localStorage.setItem(
    'streamHistory',
    JSON.stringify(history.slice(0, 50))
  );
}

function seasonKey(value) {
  return value === null ||
    value === undefined
    ? 'null'
    : String(value);
}

function seasonLabel(value) {
  if (value === null || value === undefined) {
    return 'Sem temporada';
  }

  if (Number(value) === 0) return 'Especiais';

  return `Temporada ${value}`;
}

function episodeTitle(item) {
  const raw = String(item.title || '').trim();
  const series = String(item.series_title || '').trim();

  if (
    !raw ||
    raw.toLocaleLowerCase('pt-BR') ===
      series.toLocaleLowerCase('pt-BR')
  ) {
    return `Episódio ${item.episode ?? ''}`.trim();
  }

  return raw;
}

function episodesForSeason(season) {
  return seriesEpisodes.filter(
    item =>
      (item.season ?? null) === season
  );
}

function renderSeasonTabs() {
  const seasons = [...new Set(
    seriesEpisodes.map(
      item => item.season ?? null
    )
  )].sort(
    (a, b) =>
      (a ?? -1) - (b ?? -1)
  );

  watchSeasonTabs.innerHTML = seasons.map(season => `
    <button
      class="season-button ${
        season === activeSeason ? 'active' : ''
      }"
      type="button"
      data-season="${seasonKey(season)}"
    >
      ${escapeHtml(seasonLabel(season))}
    </button>
  `).join('');
}

function renderWatchEpisodes() {
  const filtered = episodesForSeason(activeSeason);

  watchEpisodeList.innerHTML = filtered.map(item => {
    const active =
      Number(item.id) === id;

    const image =
      item.episode_image_url ||
      item.backdrop_url ||
      item.cover_url ||
      '';

    const number =
      item.episode !== null &&
      item.episode !== undefined
        ? `E${item.episode}`
        : 'EP';

    const thumb = image
      ? `<img src="${escapeHtml(image)}" alt="Capa do episódio ${escapeHtml(item.episode ?? '')}" loading="lazy">`
      : `<div class="episode-thumb-placeholder">${escapeHtml(number)}</div>`;

    return `
      <a
        class="watch-episode-card ${
          active ? 'active' : ''
        }"
        href="/watch.html?id=${item.id}"
      >
        <div class="watch-episode-thumb">
          ${thumb}
          <span>${active ? 'ASSISTINDO' : number}</span>
          <b>▶</b>
        </div>

        <div>
          <small>
            ${escapeHtml(seasonLabel(item.season))}
            •
            ${escapeHtml(
              item.episode !== null &&
              item.episode !== undefined
                ? `Episódio ${item.episode}`
                : 'Episódio'
            )}
          </small>

          <strong>${escapeHtml(episodeTitle(item))}</strong>
        </div>
      </a>
    `;
  }).join('');
}

function setSeason(season) {
  activeSeason = season;
  renderSeasonTabs();
  renderWatchEpisodes();
}

function updatePreviousNext() {
  const index = seriesEpisodes.findIndex(
    item =>
      Number(item.id) === id
  );

  const previous =
    index > 0
      ? seriesEpisodes[index - 1]
      : null;

  const next =
    index >= 0 &&
    index < seriesEpisodes.length - 1
      ? seriesEpisodes[index + 1]
      : null;

  previousEpisode.classList.toggle(
    'hidden',
    !previous
  );

  nextEpisode.classList.toggle(
    'hidden',
    !next
  );

  if (previous) {
    previousEpisode.href =
      `/watch.html?id=${previous.id}`;
  }

  if (next) {
    nextEpisode.href =
      `/watch.html?id=${next.id}`;
  }
}

async function loadRelatedEpisodes(seriesTitle) {
  try {
    const response = await fetch(
      `/api/series?title=${encodeURIComponent(seriesTitle)}`,
      {
        cache: 'no-store'
      }
    );

    const body = await response.json();

    if (!response.ok) {
      throw new Error(
        body.error ||
        'Não foi possível carregar os episódios.'
      );
    }

    seriesEpisodes = (body.episodes || [])
      .sort(
        (a, b) =>
          (Number(a.season) || 0) -
            (Number(b.season) || 0) ||
          (Number(a.episode) || 0) -
            (Number(b.episode) || 0) ||
          Number(a.id) -
            Number(b.id)
      );

    activeSeason =
      currentItem.season ??
      seriesEpisodes[0]?.season ??
      null;

    renderSeasonTabs();
    renderWatchEpisodes();
    updatePreviousNext();
    relatedEpisodes.classList.remove('hidden');

    seriesBackButton.href =
      `/series.html?title=${encodeURIComponent(seriesTitle)}` +
      `&season=${activeSeason ?? ''}`;

    seriesBackButton.classList.remove('hidden');
  } catch (error) {
    console.error(error);
  }
}

watchSeasonTabs.addEventListener('click', event => {
  const button = event.target.closest(
    'button[data-season]'
  );

  if (!button) return;

  const season =
    button.dataset.season === 'null'
      ? null
      : Number(button.dataset.season);

  setSeason(season);
});

favoriteButton.addEventListener('click', () => {
  const favorites = getFavorites();

  const next = favorites.includes(id)
    ? favorites.filter(
        itemId =>
          itemId !== id
      )
    : [id, ...favorites];

  localStorage.setItem(
    'streamFavorites',
    JSON.stringify(next)
  );

  updateFavoriteButton();
});

async function loadItem() {
  if (!Number.isInteger(id) || id < 1) {
    showError('Link de conteúdo inválido.');
    return;
  }

  try {
    const response = await fetch(
      `/api/catalog/${id}`,
      {
        cache: 'no-store'
      }
    );

    const body = await response.json();

    if (!response.ok) {
      throw new Error(
        body.error ||
        'Conteúdo não encontrado.'
      );
    }

    currentItem = body;

    const visibleTitle =
      body.content_type === 'episode'
        ? episodeTitle(body)
        : body.title;

    document.title =
      `${visibleTitle} | Minha Stream`;

    watchTitle.textContent = visibleTitle;

    watchEyebrow.textContent =
      body.series_title ||
      (
        body.content_type === 'episode'
          ? 'EPISÓDIO'
          : 'FILME / VÍDEO'
      );

    const meta = [];

    if (body.year) meta.push(body.year);

    if (
      body.season !== null &&
      body.season !== undefined
    ) {
      meta.push(`Temporada ${body.season}`);
    }

    if (
      body.episode !== null &&
      body.episode !== undefined
    ) {
      meta.push(`Episódio ${body.episode}`);
    }

    if (body.genres) meta.push(body.genres);

    watchMeta.textContent = meta.join(' • ');

    watchDescription.textContent =
      body.description ||
      'Sem descrição.';

    await mountUniversalPlayer(body);
    addToHistory(body);
    updateFavoriteButton();

    if (
      body.content_type === 'episode' &&
      body.series_title
    ) {
      await loadRelatedEpisodes(
        body.series_title
      );
    }
  } catch (error) {
    destroyPlayerSource();
    watchTitle.textContent =
      'Não foi possível abrir';

    showError(error.message);
  }
}

window.addEventListener(
  'beforeunload',
  destroyPlayerSource
);

updateVolumeButton();
showControls();
loadItem();
