'use strict';

const catalogGrid = document.querySelector('#catalogGrid');
const emptyState = document.querySelector('#emptyState');
const resultCount = document.querySelector('#resultCount');
const searchInput = document.querySelector('#searchInput');
const hero = document.querySelector('#hero');
const heroTitle = document.querySelector('#heroTitle');
const heroDescription = document.querySelector('#heroDescription');
const heroButton = document.querySelector('#heroButton');

let catalog = [];
let displayItems = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function firstFilled(items, key) {
  return items.find(item => item[key])?.[key] || '';
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
      result.push({ kind: 'item', ...item });
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
    parts.push(item.genres.split(',')[0].trim());
  }
  return parts.join(' • ') || (item.kind === 'series' ? 'Série' : 'Vídeo');
}

function itemHref(item) {
  return item.kind === 'series'
    ? `/series.html?title=${encodeURIComponent(item.series_title)}`
    : `/watch.html?id=${item.id}`;
}

function renderHero(items) {
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

function renderCatalog(items) {
  resultCount.textContent = `${items.length} ${items.length === 1 ? 'título' : 'títulos'}`;
  emptyState.classList.toggle('hidden', items.length > 0);
  catalogGrid.innerHTML = items.map(item => {
    const poster = item.cover_url
      ? `<img src="${escapeHtml(item.cover_url)}" alt="" loading="lazy">`
      : `<div class="poster-placeholder">${escapeHtml(item.title)}</div>`;
    return `
      <a class="catalog-card" href="${itemHref(item)}">
        <div class="poster">${poster}${item.kind === 'series' ? '<span class="type-chip">SÉRIE</span>' : ''}</div>
        <h3 class="card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h3>
        <p class="card-meta">${escapeHtml(itemMeta(item))}</p>
      </a>`;
  }).join('');
}

function filterCatalog() {
  const query = searchInput.value.trim().toLocaleLowerCase('pt-BR');
  const filtered = query ? displayItems.filter(item => [item.title, item.genres]
    .some(value => String(value || '').toLocaleLowerCase('pt-BR').includes(query))) : displayItems;
  renderCatalog(filtered);
}

async function loadCatalog() {
  try {
    const response = await fetch('/api/catalog');
    if (!response.ok) throw new Error('Falha ao carregar catálogo.');
    catalog = await response.json();
    displayItems = groupCatalog(catalog);
    renderHero(displayItems);
    renderCatalog(displayItems);
  } catch (error) {
    catalogGrid.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`;
  }
}

searchInput.addEventListener('input', filterCatalog);
loadCatalog();
