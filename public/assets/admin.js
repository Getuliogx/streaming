'use strict';

const loginPanel = document.querySelector('#loginPanel');
const adminPanel = document.querySelector('#adminPanel');
const loginForm = document.querySelector('#loginForm');
const loginMessage = document.querySelector('#loginMessage');
const logoutButton = document.querySelector('#logoutButton');
const titleForm = document.querySelector('#titleForm');
const formHeading = document.querySelector('#formHeading');
const formMessage = document.querySelector('#formMessage');
const resetButton = document.querySelector('#resetButton');
const adminList = document.querySelector('#adminList');
const databaseBadge = document.querySelector('#databaseBadge');
const storageWarning = document.querySelector('#storageWarning');
const contentTypeSelect = document.querySelector('#contentTypeSelect');
const seriesFields = document.querySelector('#seriesFields');
const tmdbSearchForm = document.querySelector('#tmdbSearchForm');
const tmdbQuery = document.querySelector('#tmdbQuery');
const tmdbType = document.querySelector('#tmdbType');
const tmdbMessage = document.querySelector('#tmdbMessage');
const tmdbResults = document.querySelector('#tmdbResults');
const tmdbStatus = document.querySelector('#tmdbStatus');
const playlistUrl = document.querySelector('#playlistUrl');
const importUrlButton = document.querySelector('#importUrlButton');
const playlistUrlMessage = document.querySelector('#playlistUrlMessage');
const playlistFile = document.querySelector('#playlistFile');
const playlistUseFormData = document.querySelector('#playlistUseFormData');
const importPlaylistButton = document.querySelector('#importPlaylistButton');
const playlistMessage = document.querySelector('#playlistMessage');
const importerBuildBadge = document.querySelector('#importerBuildBadge');

let items = [];
let tmdbConfigured = false;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Erro na solicitação.');
  return body;
}

function setMessage(element, text = '', type = '') {
  element.textContent = text;
  element.className = `form-message ${type}`.trim();
}

function updateSeriesFields() {
  const episode = contentTypeSelect.value === 'episode';
  seriesFields.classList.toggle('hidden', !episode);
  titleForm.elements.series_title.required = episode;
}

function showAdmin(session) {
  loginPanel.classList.add('hidden');
  adminPanel.classList.remove('hidden');
  logoutButton.classList.remove('hidden');
  databaseBadge.textContent = session.storage === 'github' ? 'Salvando no GitHub' : 'Somente teste local';
  storageWarning.classList.toggle('hidden', session.githubConfigured);
  storageWarning.textContent = session.githubConfigured
    ? ''
    : 'GITHUB_TOKEN ou GITHUB_REPO não estão configurados. No Render, as alterações não serão permanentes até você configurar os dois.';
  tmdbConfigured = Boolean(session.tmdbConfigured);
  tmdbStatus.textContent = tmdbConfigured ? '— pronto' : '— falta TMDB_API_KEY no Render';
  tmdbSearchForm.querySelectorAll('input, select, button').forEach(element => { element.disabled = !tmdbConfigured; });
}

function showLogin() {
  loginPanel.classList.remove('hidden');
  adminPanel.classList.add('hidden');
  logoutButton.classList.add('hidden');
}

function resetForm() {
  titleForm.reset();
  titleForm.elements.id.value = '';
  titleForm.elements.tmdb_id.value = '';
  titleForm.elements.tmdb_type.value = '';
  titleForm.elements.content_type.value = 'movie';
  titleForm.elements.source_type.value = 'auto';
  titleForm.elements.published.checked = true;
  formHeading.textContent = 'Adicionar conteúdo';
  tmdbResults.innerHTML = '';
  setMessage(formMessage);
  updateSeriesFields();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderList() {
  if (!items.length) {
    adminList.innerHTML = '<div class="empty-state"><strong>Catálogo vazio</strong><span>Adicione o primeiro conteúdo no formulário.</span></div>';
    return;
  }

  adminList.innerHTML = items.map(item => {
    const subtitle = [
      item.series_title,
      item.content_type === 'episode' && item.season !== null ? `T${item.season}` : '',
      item.content_type === 'episode' && item.episode !== null ? `E${item.episode}` : '',
      item.category,
      String(item.source_type || '').toUpperCase(),
      item.published ? 'Publicado' : 'Oculto'
    ].filter(Boolean).join(' • ');
    const image = item.cover_url
      ? `<img class="admin-thumb" src="${escapeHtml(item.cover_url)}" alt="">`
      : '<div class="admin-thumb"></div>';
    return `
      <article class="admin-item">
        ${image}
        <div>
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(subtitle)}</p>
        </div>
        <div class="admin-actions">
          <button class="icon-button" type="button" data-action="edit" data-id="${item.id}" title="Editar">✎</button>
          <button class="icon-button danger" type="button" data-action="delete" data-id="${item.id}" title="Excluir">🗑</button>
        </div>
      </article>`;
  }).join('');
}

async function loadItems() {
  items = await api('/api/admin/titles');
  renderList();
}

function editItem(id) {
  const item = items.find(entry => Number(entry.id) === Number(id));
  if (!item) return;
  for (const [key, value] of Object.entries(item)) {
    const field = titleForm.elements[key];
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = Boolean(value);
    else field.value = value ?? '';
  }
  if (!titleForm.elements.source_type.value) titleForm.elements.source_type.value = 'auto';
  formHeading.textContent = 'Editar conteúdo';
  setMessage(formMessage);
  updateSeriesFields();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function removeItem(id) {
  const item = items.find(entry => Number(entry.id) === Number(id));
  if (!item || !confirm(`Excluir “${item.title}”?`)) return;
  await api(`/api/admin/titles/${id}`, { method: 'DELETE' });
  await loadItems();
  if (Number(titleForm.elements.id.value) === Number(id)) resetForm();
}

function formPayload(includeSource = true) {
  const formData = new FormData(titleForm);
  const payload = Object.fromEntries(formData.entries());
  payload.featured = titleForm.elements.featured.checked;
  payload.published = titleForm.elements.published.checked;
  delete payload.id;
  if (!includeSource) {
    delete payload.title;
    delete payload.source_url;
    delete payload.source_type;
    delete payload.featured;
  }
  return payload;
}

function renderTmdbResults(results) {
  if (!results.length) {
    tmdbResults.innerHTML = '<p class="muted">Nenhum resultado encontrado.</p>';
    return;
  }
  tmdbResults.innerHTML = results.map(result => `
    <article class="tmdb-result">
      ${result.cover_url ? `<img src="${escapeHtml(result.cover_url)}" alt="">` : '<div class="tmdb-poster-placeholder"></div>'}
      <div>
        <strong>${escapeHtml(result.title)}</strong>
        <span>${result.media_type === 'tv' ? 'Série' : 'Filme'}${result.year ? ` • ${result.year}` : ''}</span>
      </div>
      <button class="ghost-button" type="button" data-tmdb-id="${result.id}" data-tmdb-type="${result.media_type}">Usar</button>
    </article>`).join('');
}

async function useTmdbResult(id, type) {
  setMessage(tmdbMessage, 'Carregando dados…');
  const data = await api(`/api/admin/tmdb/details?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`);
  titleForm.elements.tmdb_id.value = data.tmdb_id ?? '';
  titleForm.elements.tmdb_type.value = data.tmdb_type ?? '';
  titleForm.elements.description.value = data.description || '';
  titleForm.elements.year.value = data.year ?? '';
  titleForm.elements.genres.value = data.genres || '';
  titleForm.elements.cover_url.value = data.cover_url || '';
  titleForm.elements.backdrop_url.value = data.backdrop_url || '';

  if (data.tmdb_type === 'tv') {
    titleForm.elements.content_type.value = 'episode';
    titleForm.elements.series_title.value = data.title;
    if (!titleForm.elements.id.value || !titleForm.elements.title.value.trim()) titleForm.elements.title.value = 'Episódio 1';
    if (!titleForm.elements.season.value) titleForm.elements.season.value = '1';
    if (!titleForm.elements.episode.value) titleForm.elements.episode.value = '1';
  } else {
    titleForm.elements.content_type.value = 'movie';
    titleForm.elements.title.value = data.title;
    titleForm.elements.series_title.value = '';
    titleForm.elements.season.value = '';
    titleForm.elements.episode.value = '';
  }
  updateSeriesFields();
  setMessage(tmdbMessage, 'Capa e dados preenchidos.', 'success');
}

adminList.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  if (button.dataset.action === 'edit') editItem(button.dataset.id);
  if (button.dataset.action === 'delete') removeItem(button.dataset.id).catch(error => alert(error.message));
});

contentTypeSelect.addEventListener('change', updateSeriesFields);

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  setMessage(loginMessage, 'Entrando…');
  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: loginForm.elements.password.value })
    });
    const session = await api('/api/admin/session');
    showAdmin(session);
    try {
      const build = await api('/api/admin/importer-version');
      if (importerBuildBadge) importerBuildBadge.textContent = `IMPORTADOR UNIVERSAL V${build.version}`;
    } catch {}
    await loadItems();
  } catch (error) {
    setMessage(loginMessage, error.message, 'error');
  }
});

logoutButton.addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch {}
  showLogin();
});

resetButton.addEventListener('click', resetForm);

titleForm.addEventListener('submit', async event => {
  event.preventDefault();
  setMessage(formMessage, 'Salvando…');
  const payload = formPayload(true);
  const id = titleForm.elements.id.value;

  try {
    await api(id ? `/api/admin/titles/${id}` : '/api/admin/titles', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });
    setMessage(formMessage, 'Salvo com sucesso.', 'success');
    await loadItems();
    setTimeout(resetForm, 500);
  } catch (error) {
    setMessage(formMessage, error.message, 'error');
  }
});

tmdbSearchForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!tmdbConfigured) return;
  const query = tmdbQuery.value.trim();
  if (query.length < 2) {
    setMessage(tmdbMessage, 'Digite pelo menos 2 letras.', 'error');
    return;
  }
  setMessage(tmdbMessage, 'Buscando…');
  tmdbResults.innerHTML = '';
  try {
    const results = await api(`/api/admin/tmdb/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(tmdbType.value)}`);
    renderTmdbResults(results);
    setMessage(tmdbMessage, `${results.length} resultado(s).`, 'success');
  } catch (error) {
    setMessage(tmdbMessage, error.message, 'error');
  }
});

tmdbResults.addEventListener('click', event => {
  const button = event.target.closest('button[data-tmdb-id]');
  if (!button) return;
  useTmdbResult(button.dataset.tmdbId, button.dataset.tmdbType).catch(error => {
    setMessage(tmdbMessage, error.message, 'error');
  });
});

importUrlButton.addEventListener('click', async () => {
  const url = playlistUrl.value.trim();
  if (!url) {
    setMessage(playlistUrlMessage, 'Cole o link da playlist, página ou feed.', 'error');
    return;
  }

  setMessage(playlistUrlMessage, 'Abrindo o link e procurando todos os vídeos… Isso pode demorar um pouco.');
  importUrlButton.disabled = true;
  try {
    const defaults = playlistUseFormData.checked ? formPayload(false) : { published: true };
    const result = await api('/api/admin/import-url', {
      method: 'POST',
      body: JSON.stringify({ url, defaults })
    });
    const expectedText = result.expected ? ` de ${result.expected}` : '';
    const pageText = result.pages ? ` em ${result.pages} página(s)` : '';
    const incompleteText = result.complete === false
      ? ' A página ainda indicou mais resultados, mas o limite seguro de leitura foi atingido. Importe novamente para atualizar sem duplicar.'
      : '';
    setMessage(
      playlistUrlMessage,
      `${result.found}${expectedText} vídeo(s) encontrado(s)${pageText}. Formato: ${result.format}. ${result.added} novo(s), ${result.updated || 0} atualizado(s), ${result.removed || 0} item(ns) antigo(s) removido(s) e ${result.skipped} repetido(s).${incompleteText}`,
      result.complete === false ? 'error' : 'success'
    );
    await loadItems();
  } catch (error) {
    setMessage(playlistUrlMessage, error.message, 'error');
  } finally {
    importUrlButton.disabled = false;
  }
});

importPlaylistButton.addEventListener('click', async () => {
  const file = playlistFile.files?.[0];
  if (!file) {
    setMessage(playlistMessage, 'Escolha um arquivo de playlist.', 'error');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    setMessage(playlistMessage, 'A playlist deve ter no máximo 5 MB.', 'error');
    return;
  }

  setMessage(playlistMessage, 'Lendo e importando…');
  importPlaylistButton.disabled = true;
  try {
    const content = await file.text();
    const defaults = playlistUseFormData.checked ? formPayload(false) : { published: true };
    const result = await api('/api/admin/import-playlist', {
      method: 'POST',
      body: JSON.stringify({ content, defaults })
    });
    setMessage(
      playlistMessage,
      `${result.added} item(ns) adicionado(s). ${result.skipped} link(s) repetido(s) ignorado(s).`,
      'success'
    );
    await loadItems();
  } catch (error) {
    setMessage(playlistMessage, error.message, 'error');
  } finally {
    importPlaylistButton.disabled = false;
  }
});

(async function init() {
  updateSeriesFields();
  try {
    const session = await api('/api/admin/session');
    if (!session.authenticated) return showLogin();
    showAdmin(session);
    try {
      const build = await api('/api/admin/importer-version');
      if (importerBuildBadge) importerBuildBadge.textContent = `IMPORTADOR UNIVERSAL V${build.version}`;
    } catch {}
    await loadItems();
  } catch (error) {
    showLogin();
    setMessage(loginMessage, error.message, 'error');
  }
})();
