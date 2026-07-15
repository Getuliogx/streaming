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

let items = [];

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

function showAdmin(session) {
  loginPanel.classList.add('hidden');
  adminPanel.classList.remove('hidden');
  logoutButton.classList.remove('hidden');
  databaseBadge.textContent = session.storage === 'github' ? 'Salvando no GitHub' : 'Somente teste local';
  storageWarning.classList.toggle('hidden', session.githubConfigured);
  storageWarning.textContent = session.githubConfigured
    ? ''
    : 'GITHUB_TOKEN ou GITHUB_REPO não estão configurados. No Render, as alterações não serão permanentes até você configurar os dois.';
}

function showLogin() {
  loginPanel.classList.remove('hidden');
  adminPanel.classList.add('hidden');
  logoutButton.classList.add('hidden');
}

function resetForm() {
  titleForm.reset();
  titleForm.elements.id.value = '';
  titleForm.elements.content_type.value = 'movie';
  titleForm.elements.published.checked = true;
  formHeading.textContent = 'Adicionar vídeo';
  setMessage(formMessage);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderList() {
  if (!items.length) {
    adminList.innerHTML = '<div class="empty-state"><strong>Catálogo vazio</strong><span>Adicione o primeiro vídeo no formulário.</span></div>';
    return;
  }

  adminList.innerHTML = items.map(item => {
    const subtitle = [
      item.series_title,
      item.content_type === 'episode' && item.season !== null ? `T${item.season}` : '',
      item.content_type === 'episode' && item.episode !== null ? `E${item.episode}` : '',
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
  formHeading.textContent = 'Editar vídeo';
  setMessage(formMessage);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function removeItem(id) {
  const item = items.find(entry => Number(entry.id) === Number(id));
  if (!item || !confirm(`Excluir “${item.title}”?`)) return;
  await api(`/api/admin/titles/${id}`, { method: 'DELETE' });
  await loadItems();
  if (Number(titleForm.elements.id.value) === Number(id)) resetForm();
}

adminList.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  if (button.dataset.action === 'edit') editItem(button.dataset.id);
  if (button.dataset.action === 'delete') removeItem(button.dataset.id).catch(error => alert(error.message));
});

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
  const formData = new FormData(titleForm);
  const payload = Object.fromEntries(formData.entries());
  payload.featured = titleForm.elements.featured.checked;
  payload.published = titleForm.elements.published.checked;
  const id = payload.id;
  delete payload.id;

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

(async function init() {
  try {
    const session = await api('/api/admin/session');
    if (!session.authenticated) return showLogin();
    showAdmin(session);
    await loadItems();
  } catch (error) {
    showLogin();
    setMessage(loginMessage, error.message, 'error');
  }
})();
