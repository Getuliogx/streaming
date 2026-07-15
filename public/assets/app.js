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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function itemMeta(item) {
  const parts = [];
  if (item.year) parts.push(item.year);
  if (item.content_type === 'episode') {
    if (item.season !== null) parts.push(`T${item.season}`);
    if (item.episode !== null) parts.push(`E${item.episode}`);
  }
  if (item.genres) parts.push(item.genres.split(',')[0].trim());
  return parts.join(' • ') || 'Vídeo';
}

function renderHero(items) {
  const featured = items.find(item => item.featured) || items[0];
  if (!featured) {
    hero.classList.add('hidden');
    return;
  }
  heroTitle.textContent = featured.series_title || featured.title;
  heroDescription.textContent = featured.description || `Assista ${featured.title}.`;
  heroButton.href = `/watch.html?id=${featured.id}`;
  if (featured.backdrop_url || featured.cover_url) {
    hero.style.backgroundImage = `url("${String(featured.backdrop_url || featured.cover_url).replaceAll('"', '%22')}")`;
  }
  hero.classList.remove('hidden');
}

function renderCatalog(items) {
  resultCount.textContent = `${items.length} ${items.length === 1 ? 'item' : 'itens'}`;
  emptyState.classList.toggle('hidden', items.length > 0);
  catalogGrid.innerHTML = items.map(item => {
    const displayTitle = item.content_type === 'episode' && item.series_title
      ? `${item.series_title} — ${item.title}`
      : item.title;
    const poster = item.cover_url
      ? `<img src="${escapeHtml(item.cover_url)}" alt="" loading="lazy">`
      : `<div class="poster-placeholder">${escapeHtml(displayTitle)}</div>`;
    return `
      <a class="catalog-card" href="/watch.html?id=${item.id}">
        <div class="poster">${poster}</div>
        <h3 class="card-title" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</h3>
        <p class="card-meta">${escapeHtml(itemMeta(item))}</p>
      </a>`;
  }).join('');
}

function filterCatalog() {
  const query = searchInput.value.trim().toLocaleLowerCase('pt-BR');
  const filtered = query ? catalog.filter(item => [item.title, item.series_title, item.genres]
    .some(value => String(value || '').toLocaleLowerCase('pt-BR').includes(query))) : catalog;
  renderCatalog(filtered);
}

async function loadCatalog() {
  try {
    const response = await fetch('/api/catalog');
    if (!response.ok) throw new Error('Falha ao carregar catálogo.');
    catalog = await response.json();
    renderHero(catalog);
    renderCatalog(catalog);
  } catch (error) {
    catalogGrid.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`;
  }
}

searchInput.addEventListener('input', filterCatalog);
loadCatalog();
