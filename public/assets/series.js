'use strict';

const params = new URLSearchParams(location.search);
const requestedTitle = params.get('title') || '';
const requestedSeasonValue = params.get('season');
const requestedSeason =
  requestedSeasonValue === null || requestedSeasonValue === ''
    ? null
    : Number(requestedSeasonValue);
const requestedEpisodeId = Number(params.get('episode'));

const seriesHero = document.querySelector('#seriesHero');
const seriesPoster = document.querySelector('#seriesPoster');
const seriesTitle = document.querySelector('#seriesTitle');
const seriesMeta = document.querySelector('#seriesMeta');
const seriesDescription = document.querySelector('#seriesDescription');
const seasonTabs = document.querySelector('#seasonTabs');
const episodeGrid = document.querySelector('#episodeGrid');
const seriesError = document.querySelector('#seriesError');

const seriesPlayerSection = document.querySelector('#seriesPlayerSection');
const seriesPlayerMount = document.querySelector('#seriesPlayerMount');
const seriesPlayerEyebrow = document.querySelector('#seriesPlayerEyebrow');
const seriesPlayerTitle = document.querySelector('#seriesPlayerTitle');
const seriesPlayerMeta = document.querySelector('#seriesPlayerMeta');
const seriesPlayerDescription = document.querySelector('#seriesPlayerDescription');
const previousSeriesEpisode = document.querySelector('#previousSeriesEpisode');
const nextSeriesEpisode = document.querySelector('#nextSeriesEpisode');

let episodes = [];
let seriesInfo = {};
let activeSeason = null;
let activeEpisodeId = null;
let hlsInstance = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  })[character]);
}

function seasonKey(value) {
  return value === null || value === undefined
    ? 'null'
    : String(value);
}

function seasonLabel(value) {
  if (value === null || value === undefined) return 'Sem temporada';
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

function firstFilled(key) {
  return episodes.find(item => item[key])?.[key] || '';
}

function showError(message) {
  seriesError.textContent = message;
  seriesError.classList.remove('hidden');
}

function clearError() {
  seriesError.textContent = '';
  seriesError.classList.add('hidden');
}

function getSeasons() {
  return [...new Set(
    episodes.map(item => item.season ?? null)
  )].sort((a, b) => (a ?? -1) - (b ?? -1));
}

function episodesForSeason(season) {
  return episodes.filter(
    item => (item.season ?? null) === season
  );
}

function extractDriveId(value) {
  const text = String(value || '').trim();
  const match =
    text.match(/\/d\/([a-zA-Z0-9_-]+)/) ||
    text.match(/[?&]id=([a-zA-Z0-9_-]+)/);

  return match ? match[1] : text;
}

function extractOkId(value) {
  const text = String(value || '').trim();
  const match =
    text.match(/(?:videoembed|video)\/(\d+)/) ||
    text.match(/(\d{6,})/);

  return match ? match[1] : text;
}

function destroyCurrentPlayer() {
  if (hlsInstance) {
    try {
      hlsInstance.destroy();
    } catch {}
    hlsInstance = null;
  }

  const video = seriesPlayerMount.querySelector('video');
  if (video) {
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {}
  }
}

function buildIframe(src, title) {
  destroyCurrentPlayer();

  const iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.title = title;
  iframe.allow = 'autoplay; fullscreen; picture-in-picture';
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';

  seriesPlayerMount.replaceChildren(iframe);
}

function buildVideo(src, isHls = false, poster = '') {
  destroyCurrentPlayer();

  const video = document.createElement('video');
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.autoplay = false;

  if (poster) video.poster = poster;

  if (
    isHls &&
    window.Hls &&
    window.Hls.isSupported()
  ) {
    hlsInstance = new window.Hls({
      enableWorker: true
    });

    hlsInstance.loadSource(src);
    hlsInstance.attachMedia(video);

    hlsInstance.on(
      window.Hls.Events.ERROR,
      (_, data) => {
        if (data.fatal) {
          showError(
            'Não foi possível carregar o vídeo HLS. O servidor do vídeo precisa permitir CORS.'
          );
        }
      }
    );
  } else {
    video.src = src;
  }

  seriesPlayerMount.replaceChildren(video);
}

function mountPlayer(item) {
  clearError();

  if (item.source_type === 'okru') {
    buildIframe(
      `https://ok.ru/videoembed/${encodeURIComponent(
        extractOkId(item.source_url)
      )}`,
      episodeTitle(item)
    );
    return;
  }

  if (item.source_type === 'gdrive') {
    buildIframe(
      `https://drive.google.com/file/d/${encodeURIComponent(
        extractDriveId(item.source_url)
      )}/preview`,
      episodeTitle(item)
    );
    return;
  }

  if (item.source_type === 'hls') {
    buildVideo(
      item.source_url,
      true,
      item.episode_image_url ||
        item.backdrop_url ||
        item.cover_url ||
        ''
    );
    return;
  }

  if (item.source_type === 'iframe') {
    buildIframe(
      item.source_url,
      episodeTitle(item)
    );
    return;
  }

  buildVideo(
    item.source_url,
    false,
    item.episode_image_url ||
      item.backdrop_url ||
      item.cover_url ||
      ''
  );
}

function renderSeriesInfo() {
  const title =
    seriesInfo.title ||
    episodes[0]?.series_title ||
    requestedTitle;

  const cover =
    seriesInfo.cover_url ||
    firstFilled('cover_url');

  const backdrop =
    seriesInfo.backdrop_url ||
    firstFilled('backdrop_url') ||
    cover;

  const year =
    seriesInfo.year ||
    firstFilled('year');

  const genres =
    seriesInfo.genres ||
    firstFilled('genres');

  const description =
    seriesInfo.description ||
    '';

  const seasons = new Set(
    episodes.map(item => item.season ?? null)
  );

  document.title = `${title} | Minha Stream`;
  seriesTitle.textContent = title;

  seriesMeta.textContent = [
    year,
    genres,
    `${seasons.size} ${
      seasons.size === 1
        ? 'temporada'
        : 'temporadas'
    }`,
    `${episodes.length} ${
      episodes.length === 1
        ? 'episódio'
        : 'episódios'
    }`
  ].filter(Boolean).join(' • ');

  seriesDescription.textContent =
    description ||
    'Escolha um episódio abaixo para ver a descrição dele.';

  if (cover) {
    seriesPoster.innerHTML =
      `<img src="${escapeHtml(cover)}" alt="Capa de ${escapeHtml(title)}">`;
  } else {
    seriesPoster.innerHTML =
      `<div class="poster-placeholder">${escapeHtml(title)}</div>`;
  }

  if (backdrop) {
    seriesHero.style.backgroundImage =
      `url("${String(backdrop).replaceAll('"', '%22')}")`;
  }
}

function chooseInitialSeason() {
  const seasons = getSeasons();

  if (!seasons.length) return null;

  if (
    Number.isFinite(requestedSeason) &&
    seasons.includes(requestedSeason)
  ) {
    return requestedSeason;
  }

  if (Number.isInteger(requestedEpisodeId)) {
    const requestedEpisode = episodes.find(
      item => Number(item.id) === requestedEpisodeId
    );

    if (requestedEpisode) {
      return requestedEpisode.season ?? null;
    }
  }

  return seasons[0];
}

function chooseInitialEpisode() {
  if (Number.isInteger(requestedEpisodeId)) {
    const requested = episodes.find(
      item => Number(item.id) === requestedEpisodeId
    );

    if (requested) return requested;
  }

  return (
    episodesForSeason(activeSeason)[0] ||
    episodes[0] ||
    null
  );
}

function renderSeasonTabs() {
  seasonTabs.innerHTML = getSeasons()
    .map(season => `
      <button
        class="season-button ${
          season === activeSeason ? 'active' : ''
        }"
        type="button"
        data-season="${seasonKey(season)}"
      >
        ${escapeHtml(seasonLabel(season))}
      </button>
    `)
    .join('');
}

function renderEpisodes() {
  const filtered = episodesForSeason(activeSeason);

  episodeGrid.innerHTML = filtered.map(item => {
    const active =
      Number(item.id) === Number(activeEpisodeId);

    const image =
      item.episode_image_url ||
      item.backdrop_url ||
      item.cover_url ||
      '';

    const episodeNumber =
      item.episode !== null &&
      item.episode !== undefined
        ? `E${item.episode}`
        : 'EP';

    const seasonNumber =
      item.season !== null &&
      item.season !== undefined
        ? `T${item.season}`
        : '';

    const badge = [
      seasonNumber,
      episodeNumber
    ].filter(Boolean).join(' • ');

    const thumb = image
      ? `<img src="${escapeHtml(image)}" alt="Capa do episódio ${escapeHtml(item.episode ?? '')}" loading="lazy">`
      : `<div class="episode-thumb-placeholder">${escapeHtml(episodeNumber)}</div>`;

    return `
      <button
        class="episode-visual-card ${
          active ? 'active' : ''
        }"
        type="button"
        data-episode-id="${item.id}"
      >
        <div class="episode-thumb">
          ${thumb}
          <span class="episode-badge">${escapeHtml(badge)}</span>
          <span class="episode-play-icon">${
            active ? '▶' : '▷'
          }</span>
        </div>

        <div class="episode-visual-content">
          <p>
            ${escapeHtml(seasonLabel(item.season))}
            •
            ${escapeHtml(
              item.episode !== null &&
              item.episode !== undefined
                ? `Episódio ${item.episode}`
                : 'Episódio'
            )}
          </p>

          <h3>${escapeHtml(episodeTitle(item))}</h3>

          <span>
            ${escapeHtml(
              item.description ||
              'Sem descrição cadastrada para este episódio.'
            )}
          </span>
        </div>
      </button>
    `;
  }).join('');
}

function updatePlayerDetails(item) {
  seriesPlayerEyebrow.textContent = [
    seasonLabel(item.season),
    item.episode !== null &&
    item.episode !== undefined
      ? `Episódio ${item.episode}`
      : 'Episódio'
  ].join(' • ');

  seriesPlayerTitle.textContent =
    episodeTitle(item);

  seriesPlayerMeta.textContent = [
    item.year,
    item.genres
  ].filter(Boolean).join(' • ');

  seriesPlayerDescription.textContent =
    item.description ||
    'Sem descrição cadastrada para este episódio.';
}

function updatePreviousNext() {
  const index = episodes.findIndex(
    item =>
      Number(item.id) ===
      Number(activeEpisodeId)
  );

  const previous =
    index > 0
      ? episodes[index - 1]
      : null;

  const next =
    index >= 0 &&
    index < episodes.length - 1
      ? episodes[index + 1]
      : null;

  previousSeriesEpisode.classList.toggle(
    'hidden',
    !previous
  );

  nextSeriesEpisode.classList.toggle(
    'hidden',
    !next
  );

  previousSeriesEpisode.dataset.episodeId =
    previous ? String(previous.id) : '';

  nextSeriesEpisode.dataset.episodeId =
    next ? String(next.id) : '';
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
      Number(entry.id) !== Number(item.id)
  );

  history.unshift({
    id: item.id,
    title: episodeTitle(item),
    watched_at: new Date().toISOString()
  });

  localStorage.setItem(
    'streamHistory',
    JSON.stringify(history.slice(0, 50))
  );
}

function selectEpisode(item, options = {}) {
  if (!item) return;

  activeEpisodeId = Number(item.id);
  activeSeason = item.season ?? null;

  renderSeasonTabs();
  renderEpisodes();
  updatePlayerDetails(item);
  updatePreviousNext();
  mountPlayer(item);
  addToHistory(item);

  const nextUrl = new URL(location.href);
  nextUrl.searchParams.set(
    'title',
    item.series_title || requestedTitle
  );
  nextUrl.searchParams.set(
    'season',
    item.season ?? ''
  );
  nextUrl.searchParams.set(
    'episode',
    item.id
  );

  history.replaceState(
    null,
    '',
    nextUrl.pathname +
      nextUrl.search +
      nextUrl.hash
  );

  if (options.scroll !== false) {
    seriesPlayerSection.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  }
}

function selectEpisodeById(id, options = {}) {
  const item = episodes.find(
    episode =>
      Number(episode.id) === Number(id)
  );

  if (item) selectEpisode(item, options);
}

function setSeason(nextSeason) {
  activeSeason = nextSeason;
  renderSeasonTabs();
  renderEpisodes();
}

seasonTabs.addEventListener('click', event => {
  const button = event.target.closest(
    'button[data-season]'
  );

  if (!button) return;

  const nextSeason =
    button.dataset.season === 'null'
      ? null
      : Number(button.dataset.season);

  setSeason(nextSeason);
});

episodeGrid.addEventListener('click', event => {
  const button = event.target.closest(
    'button[data-episode-id]'
  );

  if (!button) return;

  selectEpisodeById(
    button.dataset.episodeId
  );
});

previousSeriesEpisode.addEventListener(
  'click',
  () => {
    selectEpisodeById(
      previousSeriesEpisode.dataset.episodeId
    );
  }
);

nextSeriesEpisode.addEventListener(
  'click',
  () => {
    selectEpisodeById(
      nextSeriesEpisode.dataset.episodeId
    );
  }
);

async function loadSeries() {
  if (!requestedTitle.trim()) {
    showError(
      'O nome da série não foi informado.'
    );
    return;
  }

  try {
    const response = await fetch(
      `/api/series?title=${encodeURIComponent(
        requestedTitle
      )}`,
      {
        cache: 'no-store'
      }
    );

    const body = await response.json();

    if (!response.ok) {
      throw new Error(
        body.error ||
        'Série não encontrada.'
      );
    }

    episodes = (body.episodes || [])
      .sort(
        (a, b) =>
          (Number(a.season) || 0) -
            (Number(b.season) || 0) ||
          (Number(a.episode) || 0) -
            (Number(b.episode) || 0) ||
          Number(a.id) - Number(b.id)
      );

    seriesInfo = body.series || {};

    if (!episodes.length) {
      throw new Error(
        'Essa série ainda não tem episódios publicados.'
      );
    }

    renderSeriesInfo();

    activeSeason = chooseInitialSeason();
    renderSeasonTabs();
    renderEpisodes();

    const initialEpisode =
      chooseInitialEpisode();

    if (initialEpisode) {
      selectEpisode(
        initialEpisode,
        {
          scroll: false
        }
      );
    }
  } catch (error) {
    seriesTitle.textContent =
      'Não foi possível abrir a série';

    showError(error.message);
  }
}

window.addEventListener(
  'beforeunload',
  destroyCurrentPlayer
);

loadSeries();
