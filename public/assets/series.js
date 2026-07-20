'use strict';

const params = new URLSearchParams(location.search);
const requestedTitle = params.get('title') || '';
const requestedSeasonValue = params.get('season');
const requestedSeason = requestedSeasonValue === null || requestedSeasonValue === '' ? null : Number(requestedSeasonValue);
const requestedEpisodeId = Number(params.get('episode'));

const seriesHero = document.querySelector('#seriesHero');
const seriesPoster = document.querySelector('#seriesPoster');
const seriesTitle = document.querySelector('#seriesTitle');
const seriesMeta = document.querySelector('#seriesMeta');
const seriesDescription = document.querySelector('#seriesDescription');
const seasonTabs = document.querySelector('#seasonTabs');
const seasonSelect = document.querySelector('#seasonSelect');
const episodeSelect = document.querySelector('#episodeSelect');
const playSelectedEpisode = document.querySelector('#playSelectedEpisode');
const episodeGrid = document.querySelector('#episodeGrid');
const seriesError = document.querySelector('#seriesError');

let episodes = [];
let activeSeason = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function seasonKey(value) {
  return value === null || value === undefined ? 'null' : String(value);
}

function seasonLabel(value) {
  if (value === null || value === undefined) return 'Sem temporada';
  if (Number(value) === 0) return 'Especiais';
  return `Temporada ${value}`;
}

function episodeLabel(item) {
  const number = item.episode !== null && item.episode !== undefined ? `Episódio ${item.episode}` : 'Episódio';
  return item.title ? `${number} — ${item.title}` : number;
}

function firstFilled(key) {
  return episodes.find(item => item[key])?.[key] || '';
}

function showError(message) {
  seriesError.textContent = message;
  seriesError.classList.remove('hidden');
}

function getSeasons() {
  return [...new Set(episodes.map(item => item.season ?? null))]
    .sort((a, b) => (a ?? -1) - (b ?? -1));
}

function episodesForSeason(season) {
  return episodes.filter(item => (item.season ?? null) === season);
}

function renderSeriesInfo() {
  const title = episodes[0]?.series_title || requestedTitle;
  const cover = firstFilled('cover_url');
  const backdrop = firstFilled('backdrop_url') || cover;
  const year = firstFilled('year');
  const genres = firstFilled('genres');
  const description = firstFilled('description');
  const seasons = new Set(episodes.map(item => item.season ?? null));

  document.title = `${title} | Minha Stream`;
  seriesTitle.textContent = title;
  seriesMeta.textContent = [
    year,
    genres,
    `${seasons.size} ${seasons.size === 1 ? 'temporada' : 'temporadas'}`,
    `${episodes.length} ${episodes.length === 1 ? 'episódio' : 'episódios'}`
  ].filter(Boolean).join(' • ');
  seriesDescription.textContent = description || 'Sem descrição.';

  if (cover) seriesPoster.innerHTML = `<img src="${escapeHtml(cover)}" alt="Capa de ${escapeHtml(title)}">`;
  else seriesPoster.innerHTML = `<div class="poster-placeholder">${escapeHtml(title)}</div>`;

  if (backdrop) seriesHero.style.backgroundImage = `url("${String(backdrop).replaceAll('"', '%22')}")`;
}

function chooseInitialSeason() {
  const seasons = getSeasons();
  if (!seasons.length) return null;
  if (Number.isFinite(requestedSeason) && seasons.includes(requestedSeason)) return requestedSeason;
  if (Number.isInteger(requestedEpisodeId)) {
    const requestedEpisode = episodes.find(item => Number(item.id) === requestedEpisodeId);
    if (requestedEpisode) return requestedEpisode.season ?? null;
  }
  return seasons[0];
}

function renderSeasonControls() {
  const seasons = getSeasons();
  seasonSelect.innerHTML = seasons.map(season => `
    <option value="${seasonKey(season)}" ${season === activeSeason ? 'selected' : ''}>
      ${escapeHtml(seasonLabel(season))}
    </option>`).join('');

  seasonTabs.innerHTML = seasons.map(season => `
    <button class="season-button ${season === activeSeason ? 'active' : ''}" type="button" data-season="${seasonKey(season)}">
      ${escapeHtml(seasonLabel(season))}
    </button>`).join('');
}

function renderEpisodeSelect(preferredId = null) {
  const filtered = episodesForSeason(activeSeason);
  episodeSelect.innerHTML = filtered.map(item => `
    <option value="${item.id}">${escapeHtml(episodeLabel(item))}</option>`).join('');

  const preferred = filtered.find(item => Number(item.id) === Number(preferredId)) || filtered[0];
  if (preferred) episodeSelect.value = String(preferred.id);
  updatePlayButton();
}

function updatePlayButton() {
  const selectedId = Number(episodeSelect.value);
  const selected = episodes.find(item => Number(item.id) === selectedId);
  if (!selected) {
    playSelectedEpisode.href = '#';
    playSelectedEpisode.classList.add('disabled');
    return;
  }
  playSelectedEpisode.href = `/watch.html?id=${selected.id}`;
  playSelectedEpisode.classList.remove('disabled');
  playSelectedEpisode.textContent = `▶ Assistir ${selected.episode !== null && selected.episode !== undefined ? `episódio ${selected.episode}` : 'episódio'}`;
}

function renderEpisodes() {
  const filtered = episodesForSeason(activeSeason);
  episodeGrid.innerHTML = filtered.map(item => {
    const image = item.backdrop_url || item.cover_url || '';
    const episodeNumber = item.episode !== null && item.episode !== undefined ? `E${item.episode}` : 'EP';
    const seasonNumber = item.season !== null && item.season !== undefined ? `T${item.season}` : '';
    const badge = [seasonNumber, episodeNumber].filter(Boolean).join(' • ');
    const thumb = image
      ? `<img src="${escapeHtml(image)}" alt="" loading="lazy">`
      : `<div class="episode-thumb-placeholder">${escapeHtml(episodeNumber)}</div>`;

    return `
      <a class="episode-visual-card" href="/watch.html?id=${item.id}">
        <div class="episode-thumb">
          ${thumb}
          <span class="episode-badge">${escapeHtml(badge)}</span>
          <span class="episode-play-icon">▶</span>
        </div>
        <div class="episode-visual-content">
          <p>${escapeHtml(seasonLabel(item.season))} • ${escapeHtml(item.episode !== null && item.episode !== undefined ? `Episódio ${item.episode}` : 'Episódio')}</p>
          <h3>${escapeHtml(item.title || `Episódio ${item.episode ?? ''}`)}</h3>
          <span>${escapeHtml(item.description || 'Clique para assistir.')}</span>
        </div>
      </a>`;
  }).join('');
}

function setSeason(nextSeason, preferredEpisodeId = null) {
  activeSeason = nextSeason;
  renderSeasonControls();
  renderEpisodeSelect(preferredEpisodeId);
  renderEpisodes();
}

seasonTabs.addEventListener('click', event => {
  const button = event.target.closest('button[data-season]');
  if (!button) return;
  const nextSeason = button.dataset.season === 'null' ? null : Number(button.dataset.season);
  setSeason(nextSeason);
});

seasonSelect.addEventListener('change', () => {
  const nextSeason = seasonSelect.value === 'null' ? null : Number(seasonSelect.value);
  setSeason(nextSeason);
});

episodeSelect.addEventListener('change', updatePlayButton);

async function loadSeries() {
  if (!requestedTitle.trim()) {
    showError('O nome da série não foi informado.');
    return;
  }

  try {
    const response = await fetch(`/api/series?title=${encodeURIComponent(requestedTitle)}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Série não encontrada.');

    episodes = body.episodes || [];
    if (!episodes.length) throw new Error('Essa série ainda não tem episódios publicados.');

    renderSeriesInfo();
    activeSeason = chooseInitialSeason();
    setSeason(activeSeason, Number.isInteger(requestedEpisodeId) ? requestedEpisodeId : null);
  } catch (error) {
    seriesTitle.textContent = 'Não foi possível abrir a série';
    showError(error.message);
  }
}

loadSeries();
