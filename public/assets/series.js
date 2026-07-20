'use strict';

const params = new URLSearchParams(location.search);
const requestedTitle = params.get('title') || '';
const requestedSeason = Number(params.get('season'));
const seriesHero = document.querySelector('#seriesHero');
const seriesPoster = document.querySelector('#seriesPoster');
const seriesTitle = document.querySelector('#seriesTitle');
const seriesMeta = document.querySelector('#seriesMeta');
const seriesDescription = document.querySelector('#seriesDescription');
const seasonTabs = document.querySelector('#seasonTabs');
const episodeGrid = document.querySelector('#episodeGrid');
const seriesError = document.querySelector('#seriesError');

let episodes = [];
let activeSeason = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function seasonLabel(value) {
  if (value === null || value === undefined) return 'Sem temporada';
  if (Number(value) === 0) return 'Especiais';
  return `Temporada ${value}`;
}

function firstFilled(key) {
  return episodes.find(item => item[key])?.[key] || '';
}

function showError(message) {
  seriesError.textContent = message;
  seriesError.classList.remove('hidden');
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
  seriesMeta.textContent = [year, genres, `${seasons.size} ${seasons.size === 1 ? 'temporada' : 'temporadas'}`, `${episodes.length} episódios`]
    .filter(Boolean).join(' • ');
  seriesDescription.textContent = description || 'Sem descrição.';
  if (cover) seriesPoster.innerHTML = `<img src="${escapeHtml(cover)}" alt="Capa de ${escapeHtml(title)}">`;
  else seriesPoster.innerHTML = `<div class="poster-placeholder">${escapeHtml(title)}</div>`;
  if (backdrop) seriesHero.style.backgroundImage = `url("${String(backdrop).replaceAll('"', '%22')}")`;
}

function renderSeasonTabs() {
  const seasons = [...new Set(episodes.map(item => item.season ?? null))]
    .sort((a, b) => (a ?? -1) - (b ?? -1));
  if (!seasons.includes(activeSeason) || (activeSeason === null && Number.isFinite(requestedSeason) && seasons.includes(requestedSeason))) {
    activeSeason = Number.isFinite(requestedSeason) && seasons.includes(requestedSeason) ? requestedSeason : seasons[0];
  }

  seasonTabs.innerHTML = seasons.map(season => `
    <button class="season-button ${season === activeSeason ? 'active' : ''}" type="button" data-season="${season === null ? 'null' : season}">
      ${escapeHtml(seasonLabel(season))}
    </button>`).join('');
}

function renderEpisodes() {
  const filtered = episodes.filter(item => (item.season ?? null) === activeSeason);
  episodeGrid.innerHTML = filtered.map(item => {
    const number = item.episode !== null && item.episode !== undefined ? `Episódio ${item.episode}` : 'Episódio';
    return `
      <article class="episode-card">
        <div class="episode-number">${escapeHtml(number)}</div>
        <div class="episode-content">
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.description || 'Sem descrição.')}</p>
        </div>
        <a class="primary-button" href="/watch.html?id=${item.id}">▶ Assistir</a>
      </article>`;
  }).join('');
}

seasonTabs.addEventListener('click', event => {
  const button = event.target.closest('button[data-season]');
  if (!button) return;
  activeSeason = button.dataset.season === 'null' ? null : Number(button.dataset.season);
  renderSeasonTabs();
  renderEpisodes();
});

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
    renderSeasonTabs();
    renderEpisodes();
  } catch (error) {
    seriesTitle.textContent = 'Não foi possível abrir a série';
    showError(error.message);
  }
}

loadSeries();
