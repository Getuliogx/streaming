'use strict';

const catalogContent = document.querySelector('#catalogContent');
const emptyState = document.querySelector('#emptyState');
const resultCount = document.querySelector('#resultCount');
const searchInput = document.querySelector('#searchInput');
const hero = document.querySelector('#hero');
const heroTitle = document.querySelector('#heroTitle');
const heroDescription = document.querySelector('#heroDescription');
const heroButton = document.querySelector('#heroButton');
const pageEyebrow = document.querySelector('#pageEyebrow');
const pageTitle = document.querySelector('#pageTitle');
const filterBar = document.querySelector('#filterBar');
const mainNav = document.querySelector('#mainNav');

let catalog = [];
let displayItems = [];

const params = new URLSearchParams(location.search);
const allowedViews = new Set(['home', 'movies', 'series', 'categories', 'genres', 'az']);
let currentView = allowedViews.has(params.get('view')) ? params.get('view') : 'home';
let currentFilter = params.get('filter') || '';
let currentLetter = (params.get('letter') || '').toLocaleUpperCase('pt-BR');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function firstFilled(items, key) {
  return items.find(item => item[key])?.[key] || '';
}

function splitValues(value) {
  return String(value || '')
    .split(/[,;|]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function normalized(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR');
}

function groupCatalog(items) {
  const result = [];
  const seriesMap = new Map();

  for (const item of items) {
    if (item.content_type === 'episode' && String(item.series_title || '').trim()) {
      const key = item.series_title.trim().toLocaleLowerCase('pt-BR');
      if (!seriesMap.has(key)) seriesMap.set(key, []);
      seriesMap.get(key).push(item);
    } else {
      result.push({ kind: 'movie', ...item });
    }
  }

  for (const episodes of seriesMap.values()) {
    episodes.sort((a, b) => (Number(a.season) || 0) - (Number(b.season) || 0)
      || (Number(a.episode) || 0) - (Number(b.episode) || 0));
    const seasons = new Set(episodes.map(item => item.season ?? 0));
    const preferred = episodes.find(item => item.featured) || episodes[0];
    result.push({
      kind: 'series',
      id: preferred.id,
      title: preferred.series_title,
      series_title: preferred.series_title,
      description: firstFilled(episodes, 'description'),
      year: firstFilled(episodes, 'year'),
      genres: firstFilled(episodes, 'genres'),
      category: firstFilled(episodes, 'category'),
      cover_url: firstFilled(episodes, 'cover_url'),
      backdrop_url: firstFilled(episodes, 'backdrop_url'),
      featured: episodes.some(item => item.featured),
      episode_count: episodes.length,
      season_count: seasons.size
    });
  }

  return result.sort((a, b) => Number(b.featured) - Number(a.featured)
    || String(a.title || '').localeCompare(String(b.title || ''), 'pt-BR'));
}

function itemMeta(item) {
  const parts = [];
  if (item.year) parts.push(item.year);
  if (item.kind === 'series') {
    parts.push(`${item.season_count} ${item.season_count === 1 ? 'temporada' : 'temporadas'}`);
    parts.push(`${item.episode_count} ${item.episode_count === 1 ? 'episódio' : 'episódios'}`);
  } else if (item.genres) {
    parts.push(splitValues(item.genres)[0]);
  }
  if (item.category && parts.length < 3) parts.push(splitValues(item.category)[0]);
  return parts.filter(Boolean).join(' • ') || (item.kind === 'series' ? 'Série' : 'Filme');
}

function itemHref(item) {
  return item.kind === 'series'
    ? `/series.html?title=${encodeURIComponent(item.series_title)}`
    : `/watch.html?id=${item.id}`;
}

function cardHtml(item) {
  const poster = item.cover_url
    ? `<img src="${escapeHtml(item.cover_url)}" alt="" loading="lazy">`
    : `<div class="poster-placeholder">${escapeHtml(item.title)}</div>`;
  const chip = item.kind === 'series' ? 'SÉRIE' : 'FILME';
  return `
    <a class="catalog-card" href="${itemHref(item)}">
      <div class="poster">${poster}<span class="type-chip">${chip}</span></div>
      <h3 class="card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h3>
      <p class="card-meta">${escapeHtml(itemMeta(item))}</p>
    </a>`;
}

function renderHero(items) {
  if (currentView !== 'home') {
    hero.classList.add('hidden');
    return;
  }
  const featured = items.find(item => item.featured) || items[0];
  if (!featured) {
    hero.classList.add('hidden');
    return;
  }
  heroTitle.textContent = featured.title;
  heroDescription.textContent = featured.description || `Veja ${featured.title}.`;
  heroButton.href = itemHref(featured);
  heroButton.textContent = featured.kind === 'series' ? '▶ Ver temporadas' : '▶ Assistir';
  if (featured.backdrop_url || featured.cover_url) {
    hero.style.backgroundImage = `url("${String(featured.backdrop_url || featured.cover_url).replaceAll('"', '%22')}")`;
  } else {
    hero.style.backgroundImage = '';
  }
  hero.classList.remove('hidden');
}

function setViewText(eyebrow, title) {
  pageEyebrow.textContent = eyebrow;
  pageTitle.textContent = title;
}

function updateUrl() {
  const next = new URL(location.href);
  if (currentView === 'home') next.searchParams.delete('view');
  else next.searchParams.set('view', currentView);
  if (currentFilter) next.searchParams.set('filter', currentFilter);
  else next.searchParams.delete('filter');
  if (currentLetter) next.searchParams.set('letter', currentLetter);
  else next.searchParams.delete('letter');
  history.replaceState({}, '', next);
}

function makeFilterButton(label, active, dataAttribute, value) {
  return `<button class="filter-chip${active ? ' active' : ''}" type="button" ${dataAttribute}="${escapeHtml(value)}">${escapeHtml(label)}</button>`;
}

function uniqueValues(items, key) {
  const values = new Map();
  for (const item of items) {
    for (const value of splitValues(item[key])) {
      const keyName = normalized(value);
      if (!values.has(keyName)) values.set(keyName, value);
    }
  }
  return [...values.values()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function renderFilterBar(items) {
  filterBar.innerHTML = '';
  if (currentView === 'categories') {
    const categories = uniqueValues(items, 'category');
    filterBar.innerHTML = makeFilterButton('Todas', !currentFilter, 'data-filter-value', '')
      + categories.map(value => makeFilterButton(value, normalized(currentFilter) === normalized(value), 'data-filter-value', value)).join('');
  } else if (currentView === 'genres') {
    const genres = uniqueValues(items, 'genres');
    filterBar.innerHTML = makeFilterButton('Todos', !currentFilter, 'data-filter-value', '')
      + genres.map(value => makeFilterButton(value, normalized(currentFilter) === normalized(value), 'data-filter-value', value)).join('');
  } else if (currentView === 'az') {
    const letters = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
    filterBar.innerHTML = makeFilterButton('Todos', !currentLetter, 'data-letter-value', '')
      + letters.map(value => makeFilterButton(value, currentLetter === value, 'data-letter-value', value)).join('');
  }
  filterBar.classList.toggle('hidden', !filterBar.innerHTML);
}

function groupSectionHtml(title, items, subtitle = '') {
  if (!items.length) return '';
  return `
    <section class="catalog-group">
      <div class="group-heading">
        <div>
          <h3>${escapeHtml(title)}</h3>
          ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
        </div>
        <span>${items.length} ${items.length === 1 ? 'título' : 'títulos'}</span>
      </div>
      <div class="catalog-grid">${items.map(cardHtml).join('')}</div>
    </section>`;
}

function filterBySearch(items) {
  const query = normalized(searchInput.value.trim());
  if (!query) return items;
  return items.filter(item => [item.title, item.genres, item.category, item.description]
    .some(value => normalized(value).includes(query)));
}

function titleStartsWith(item, letter) {
  const first = normalized(item.title).charAt(0).toLocaleUpperCase('pt-BR');
  if (letter === '#') return !/^[A-Z]$/i.test(first);
  return first === normalized(letter).toLocaleUpperCase('pt-BR');
}

function renderCatalog() {
  let items = filterBySearch(displayItems);
  renderFilterBar(displayItems);
  let html = '';

  if (currentView === 'movies') {
    setViewText('FILMES', 'Todos os filmes');
    items = items.filter(item => item.kind === 'movie');
    html = groupSectionHtml('Filmes', items);
  } else if (currentView === 'series') {
    setViewText('SÉRIES', 'Todas as séries');
    items = items.filter(item => item.kind === 'series');
    html = groupSectionHtml('Séries', items);
  } else if (currentView === 'categories') {
    setViewText('CATEGORIAS', currentFilter || 'Escolha uma categoria');
    const categories = uniqueValues(items, 'category');
    if (currentFilter) {
      items = items.filter(item => splitValues(item.category).some(value => normalized(value) === normalized(currentFilter)));
      html = groupSectionHtml(currentFilter, items);
    } else {
      html = categories.map(category => {
        const group = items.filter(item => splitValues(item.category).some(value => normalized(value) === normalized(category)));
        return groupSectionHtml(category, group);
      }).join('');
      const uncategorized = items.filter(item => !splitValues(item.category).length);
      if (uncategorized.length) html += groupSectionHtml('Sem categoria', uncategorized);
    }
  } else if (currentView === 'genres') {
    setViewText('GÊNEROS', currentFilter || 'Escolha um gênero');
    const genres = uniqueValues(items, 'genres');
    if (currentFilter) {
      items = items.filter(item => splitValues(item.genres).some(value => normalized(value) === normalized(currentFilter)));
      html = groupSectionHtml(currentFilter, items);
    } else {
      html = genres.map(genre => {
        const group = items.filter(item => splitValues(item.genres).some(value => normalized(value) === normalized(genre)));
        return groupSectionHtml(genre, group);
      }).join('');
      const withoutGenre = items.filter(item => !splitValues(item.genres).length);
      if (withoutGenre.length) html += groupSectionHtml('Sem gênero', withoutGenre);
    }
  } else if (currentView === 'az') {
    setViewText('A–Z', currentLetter ? `Títulos com ${currentLetter}` : 'Todos em ordem alfabética');
    items = [...items].sort((a, b) => String(a.title).localeCompare(String(b.title), 'pt-BR'));
    if (currentLetter) items = items.filter(item => titleStartsWith(item, currentLetter));
    html = groupSectionHtml(currentLetter || 'A–Z', items);
  } else {
    currentView = 'home';
    setViewText('CATÁLOGO', 'Filmes e séries');
    const series = items.filter(item => item.kind === 'series');
    const movies = items.filter(item => item.kind === 'movie');
    html = groupSectionHtml('Séries', series, 'Escolha a temporada e o episódio')
      + groupSectionHtml('Filmes', movies, 'Filmes e vídeos cadastrados');
  }

  resultCount.textContent = `${items.length} ${items.length === 1 ? 'título' : 'títulos'}`;
  emptyState.classList.toggle('hidden', Boolean(html));
  catalogContent.innerHTML = html;
  updateUrl();

  for (const link of mainNav.querySelectorAll('[data-view]')) {
    link.classList.toggle('active', link.dataset.view === currentView);
  }
}

function setView(view) {
  currentView = allowedViews.has(view) ? view : 'home';
  currentFilter = '';
  currentLetter = '';
  renderHero(displayItems);
  renderCatalog();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function loadCatalog() {
  try {
    const response = await fetch('/api/catalog', { cache: 'no-store' });
    if (!response.ok) throw new Error('Falha ao carregar catálogo.');
    catalog = await response.json();
    displayItems = groupCatalog(catalog);
    renderHero(displayItems);
    renderCatalog();
  } catch (error) {
    catalogContent.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`;
  }
}

mainNav.addEventListener('click', event => {
  const link = event.target.closest('[data-view]');
  if (!link) return;
  event.preventDefault();
  setView(link.dataset.view);
});

filterBar.addEventListener('click', event => {
  const filter = event.target.closest('[data-filter-value]');
  const letter = event.target.closest('[data-letter-value]');
  if (filter) {
    currentFilter = filter.dataset.filterValue;
    renderCatalog();
  }
  if (letter) {
    currentLetter = letter.dataset.letterValue;
    renderCatalog();
  }
});

searchInput.addEventListener('input', renderCatalog);
loadCatalog();
