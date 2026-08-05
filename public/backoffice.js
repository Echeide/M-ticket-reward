const state = { rows: [], stores: [], tiers: [], selected: null, token: sessionStorage.getItem('admin-token') || '' };
const statusLabels = {
  OCR_QUEUED: 'En espera de lectura',
  OCR_PROCESSING: 'Leyendo ticket',
  READY_FOR_CONFIRMATION: 'Pendiente del usuario',
  NOT_A_RECEIPT: 'No es un ticket',
  AUTO_REJECTED: 'Ticket no autorizado',
  REWARD_PENDING: 'Asignando puntos',
  REWARDED: 'Premiado',
  REWARD_FAILED: 'Procesamiento fallido',
  REVOKE_PENDING: 'Anulación en proceso',
  REVOKED: 'Anulado',
  DUPLICATE: 'Duplicado',
};
const reviewLabels = {
  PENDING: 'Pendiente de revisión',
  CLEARED: 'Validado sin fraude',
  FRAUD: 'Marcado como fraude',
};
if (!state.token && location.hostname === 'localhost') {
  state.token = prompt('Token de gestor local') || '';
  if (state.token) sessionStorage.setItem('admin-token', state.token);
}

function headers(extra = {}) {
  return { ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...extra };
}

async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: headers(options.headers) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Error de backoffice');
  return payload;
}

function filterParams() {
  const params = new URLSearchParams(new FormData(document.querySelector('#filters')));
  for (const [key, value] of [...params]) if (!value) params.delete(key);
  return params;
}

async function load() {
  const params = filterParams();
  const payload = await request(`/api/admin/receipts?${params}`);
  document.querySelector('#manager-email').textContent = payload.manager || '';
  state.rows = payload.receipts;
  document.querySelector('#record-count').textContent = state.rows.length;
  document.querySelector('#receipt-list').innerHTML = state.rows.map((receipt) => `
    <button class="receipt-row" data-id="${receipt.id}">
      <span><strong>${escapeHtml(receipt.publicId)}</strong><small>${escapeHtml(receipt.fields.storeName || 'Sin tienda')}</small></span>
      <span><strong>${formatMoney(receipt.fields.totalCents)}</strong><small>${receipt.reward.pointsAwarded} puntos</small></span>
      <span class="status-chip ${escapeHtml(receipt.status.toLowerCase())}">${escapeHtml(statusLabels[receipt.status] || receipt.status)} · ${escapeHtml(reviewLabels[receipt.review.status] || receipt.review.status)}</span>
    </button>`).join('') || '<p class="empty-state">No hay registros con estos filtros.</p>';
  document.querySelectorAll('.receipt-row').forEach((button) => button.addEventListener('click', () => select(button.dataset.id)));
}

async function loadStores() {
  const payload = await request('/api/admin/stores');
  state.stores = payload.stores;
  populateStoreFilter();
  document.querySelector('#manager-email').textContent = payload.manager || '';
  document.querySelector('#active-store-count').textContent = state.stores.filter((store) => store.active).length;
  document.querySelector('#inactive-store-count').textContent = state.stores.filter((store) => !store.active).length;
  document.querySelector('#linked-receipt-count').textContent = state.stores.reduce((total, store) => total + store.receiptCount, 0);
  document.querySelector('#store-list').innerHTML = state.stores.map((store) => `
    <article class="store-row ${store.active ? '' : 'inactive'}">
      <span><strong>${escapeHtml(store.name)}</strong><small>${escapeHtml(store.code)}</small></span>
      <span class="alias-list">${store.aliases.length ? store.aliases.map((alias) => `<small>${escapeHtml(alias)}</small>`).join('') : '<small>Sin alias</small>'}</span>
      <strong>${store.receiptCount}</strong>
      <span class="status-chip ${store.active ? 'rewarded' : 'duplicate'}">${store.active ? 'ACTIVO' : 'INACTIVO'}</span>
      <button class="secondary-button edit-store" data-id="${store.id}" type="button">Editar</button>
    </article>`).join('') || '<p class="empty-state">Todavía no hay comercios.</p>';
  document.querySelectorAll('.edit-store').forEach((button) => button.addEventListener('click', () => openStoreDialog(button.dataset.id)));
}

function populateStoreFilter() {
  const select = document.querySelector('#store-filter');
  const selected = select.value;
  const options = state.stores
    .filter((store) => store.active)
    .map((store) => `<option value="${escapeHtml(store.name)}">${escapeHtml(store.name)}</option>`)
    .join('');
  select.innerHTML = `<option value="">Todos los comercios</option>${options}`;
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}

async function loadFilterStores() {
  const payload = await request('/api/admin/stores');
  state.stores = payload.stores;
  document.querySelector('#manager-email').textContent = payload.manager || '';
  populateStoreFilter();
}

async function loadTiers() {
  const payload = await request('/api/admin/reward-tiers');
  state.tiers = payload.tiers;
  document.querySelector('#tier-list').innerHTML = state.tiers.map((tier) => `
    <article class="tier-row ${tier.active ? '' : 'inactive'}">
      <strong>${formatMoney(tier.minimumCents)}</strong>
      <span><strong>${tier.points}</strong> puntos</span>
      <span class="status-chip ${tier.active ? 'rewarded' : 'duplicate'}">${tier.active ? 'ACTIVO' : 'INACTIVO'}</span>
      <button class="secondary-button edit-tier" data-id="${tier.id}" type="button">Editar</button>
    </article>`).join('') || '<p class="empty-state">Todavía no hay tramos configurados.</p>';
  document.querySelectorAll('.edit-tier').forEach((button) => button.addEventListener('click', () => openTierDialog(button.dataset.id)));
}

function openTierDialog(id = '') {
  const tier = state.tiers.find((item) => item.id === id);
  const form = document.querySelector('#tier-form');
  form.reset();
  form.elements.id.value = tier?.id || '';
  form.elements.minimum.value = tier ? (tier.minimumCents / 100).toFixed(2) : '';
  form.elements.points.value = tier?.points ?? '';
  form.elements.active.checked = tier?.active ?? true;
  document.querySelector('#tier-dialog-title').textContent = tier ? 'Editar tramo' : 'Añadir tramo';
  document.querySelector('#tier-form-error').textContent = '';
  document.querySelector('#tier-dialog').showModal();
}

async function saveTier(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const minimumCents = Math.round(Number(String(form.elements.minimum.value).replace(',', '.')) * 100);
  const points = Number(form.elements.points.value);
  const errorNode = document.querySelector('#tier-form-error');
  if (!Number.isInteger(minimumCents) || minimumCents < 0 || !Number.isInteger(points) || points < 0) {
    errorNode.textContent = 'Revisa el importe mínimo y los puntos.';
    return;
  }
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = 'Guardando…';
  try {
    await request(id ? `/api/admin/reward-tiers/${id}` : '/api/admin/reward-tiers', {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minimumCents, points, active: form.elements.active.checked }),
    });
    document.querySelector('#tier-dialog').close();
    await loadTiers();
    const notice = document.querySelector('#admin-notice');
    notice.textContent = id ? 'Tramo actualizado correctamente.' : 'Tramo creado correctamente.';
    notice.classList.add('visible');
    setTimeout(() => notice.classList.remove('visible'), 3500);
  } catch (error) {
    errorNode.textContent = error instanceof Error ? error.message : 'No se pudo guardar el tramo';
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Guardar tramo';
  }
}

function openStoreDialog(id = '') {
  const store = state.stores.find((item) => item.id === id);
  const form = document.querySelector('#store-form');
  form.reset();
  form.elements.id.value = store?.id || '';
  form.elements.name.value = store?.name || '';
  form.elements.code.value = store?.code || '';
  form.elements.aliases.value = (store?.aliases || []).join('\n');
  form.elements.active.checked = store?.active ?? true;
  document.querySelector('#store-dialog-title').textContent = store ? 'Editar comercio' : 'Añadir comercio';
  document.querySelector('#store-form-error').textContent = '';
  document.querySelector('#store-dialog').showModal();
}

async function saveStore(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const existing = state.stores.find((store) => store.id === id);
  const active = form.elements.active.checked;
  if (existing?.active && !active && !confirm('Al desactivar este comercio, sus nuevos tickets no podrán recibir puntos. ¿Continuar?')) return;
  const body = {
    name: form.elements.name.value,
    code: form.elements.code.value,
    aliases: form.elements.aliases.value.split('\n').map((value) => value.trim()).filter(Boolean),
    active,
  };
  const errorNode = document.querySelector('#store-form-error');
  const submitButton = form.querySelector('[type="submit"]');
  errorNode.textContent = '';
  submitButton.disabled = true;
  submitButton.textContent = 'Guardando…';
  try {
    await request(id ? `/api/admin/stores/${id}` : '/api/admin/stores', {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    document.querySelector('#store-dialog').close();
    await loadStores();
    const notice = document.querySelector('#admin-notice');
    notice.textContent = id ? 'Comercio actualizado correctamente.' : 'Comercio creado correctamente.';
    notice.classList.add('visible');
    setTimeout(() => notice.classList.remove('visible'), 3500);
  } catch (error) {
    errorNode.textContent = error instanceof Error ? error.message : 'No se pudo guardar el comercio';
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Guardar comercio';
  }
}

function formatMoney(cents) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format((cents || 0) / 100);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function canReprocess(receipt) {
  if (['AUTO_REJECTED', 'NOT_A_RECEIPT', 'READY_FOR_CONFIRMATION'].includes(receipt.status)) return true;
  return receipt.status === 'REWARD_FAILED' &&
    Array.isArray(receipt.reasons) && receipt.reasons.includes('OCR_PROCESSING_FAILED');
}

function showNotice(message) {
  const notice = document.querySelector('#admin-notice');
  notice.textContent = message;
  notice.classList.add('visible');
  setTimeout(() => notice.classList.remove('visible'), 3500);
}

async function select(id, suppliedReceipt = null) {
  state.selected = suppliedReceipt || state.rows.find((row) => row.id === id);
  const receipt = state.selected;
  if (!receipt) return;
  const reprocessable = canReprocess(receipt);
  const panel = document.querySelector('#review-panel');
  panel.className = 'review-panel';
  panel.innerHTML = `
    <div class="ticket-image-wrap">
      <button class="image-reprocess-button" id="reprocess-ticket" type="button"
        aria-label="Volver a comprobar el ticket" title="${reprocessable ? 'Volver a comprobar el ticket' : 'No disponible para tickets con puntos asignados o duplicados'}"
        ${reprocessable ? '' : 'disabled'}>
        <svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"></path><path d="M21 3v5h-5"></path>
        </svg>
      </button>
      <img id="ticket-image" alt="Ticket ${receipt.publicId}" />
    </div>
    <div class="review-data">
      <p class="eyebrow">${escapeHtml(receipt.publicId)}</p>
      <h2>${escapeHtml(receipt.fields.storeName || 'Sin tienda')}</h2>
      <dl><div><dt>Usuario</dt><dd>${escapeHtml(receipt.user.displayName || receipt.user.subject)}</dd></div><div><dt>Correo</dt><dd>${escapeHtml(receipt.user.email || 'No compartido')}</dd></div><div><dt>Número</dt><dd>${escapeHtml(receipt.fields.ticketNumber || '—')}</dd></div><div><dt>Fecha</dt><dd>${escapeHtml(receipt.fields.purchaseDate || '—')}</dd></div><div><dt>Importe</dt><dd>${formatMoney(receipt.fields.totalCents)}</dd></div><div><dt>Riesgo</dt><dd>${receipt.riskScore}/100</dd></div><div><dt>Puntos</dt><dd>${receipt.reward.pointsAwarded}</dd></div><div><dt>Estado</dt><dd>${escapeHtml(statusLabels[receipt.status] || receipt.status)}</dd></div><div><dt>Revisión</dt><dd>${escapeHtml(reviewLabels[receipt.review.status] || receipt.review.status)}</dd></div></dl>
      <label>Motivo o nota<textarea id="review-reason" rows="3" placeholder="Obligatorio para revocar"></textarea></label>
      <div class="review-actions"><button class="secondary-button" id="clear-review" ${receipt.review.status !== 'PENDING' ? 'disabled' : ''}>Revisado sin fraude</button><button class="danger-button" id="revoke" ${receipt.status !== 'REWARDED' ? 'disabled' : ''}>Fraude: revocar puntos</button></div>
    </div>`;
  const image = await fetch(`/api/admin/receipts/${id}/image`, { headers: headers() });
  if (image.ok) document.querySelector('#ticket-image').src = URL.createObjectURL(await image.blob());
  document.querySelector('#clear-review').addEventListener('click', () => review('CLEAR'));
  document.querySelector('#revoke').addEventListener('click', () => review('REVOKE'));
  if (reprocessable) document.querySelector('#reprocess-ticket').addEventListener('click', reprocessSelected);
}

async function reprocessSelected() {
  const receiptId = state.selected.id;
  const button = document.querySelector('#reprocess-ticket');
  button.disabled = true;
  button.classList.add('loading');
  button.setAttribute('aria-label', 'Comprobando de nuevo el ticket');
  try {
    await request(`/api/admin/receipts/${receiptId}/reprocess`, { method: 'POST' });
    showNotice('El ticket se está comprobando de nuevo.');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const updated = (await request(`/api/admin/receipts/${receiptId}`)).receipt;
      if (!['OCR_QUEUED', 'OCR_PROCESSING'].includes(updated.status)) {
        await load();
        await select(receiptId, updated);
        showNotice('Comprobación del ticket actualizada.');
        return;
      }
    }
    const updated = (await request(`/api/admin/receipts/${receiptId}`)).receipt;
    await load();
    await select(receiptId, updated);
    showNotice('El ticket sigue procesándose; consulta de nuevo en unos instantes.');
  } catch (error) {
    button.disabled = false;
    button.classList.remove('loading');
    alert(error instanceof Error ? error.message : 'No se pudo volver a comprobar el ticket');
  }
}

async function review(action) {
  const reason = document.querySelector('#review-reason').value.trim();
  if (action === 'REVOKE' && !reason) return alert('Indica el motivo de la revocación.');
  if (action === 'REVOKE' && !confirm('Se retirarán los puntos concedidos. ¿Continuar?')) return;
  await request(`/api/admin/receipts/${state.selected.id}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, reason }),
  });
  await load();
  select(state.selected.id);
}

function updateFilterCount() {
  const params = filterParams();
  params.delete('user');
  const count = [...params].length;
  const badge = document.querySelector('#filter-count');
  badge.textContent = count;
  badge.hidden = count === 0;
}

document.querySelector('#filters').addEventListener('submit', (event) => {
  event.preventDefault();
  if (document.querySelector('#filters-dialog').open) document.querySelector('#filters-dialog').close();
  updateFilterCount();
  load().catch((error) => alert(error.message));
});
document.querySelector('#open-filters').addEventListener('click', () => document.querySelector('#filters-dialog').showModal());
document.querySelector('#close-filters-dialog').addEventListener('click', () => document.querySelector('#filters-dialog').close());
document.querySelector('#clear-filters').addEventListener('click', () => {
  document.querySelector('#filters').reset();
  document.querySelector('[name="attention"]').checked = false;
  updateFilterCount();
  document.querySelector('#filters-dialog').close();
  load().catch((error) => alert(error.message));
});
document.querySelector('#export-csv').addEventListener('click', async () => {
  const params = filterParams();
  const response = await fetch(`/api/admin/receipts.csv?${params}`, { headers: headers() });
  if (!response.ok) return alert('No se pudo exportar');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await response.blob());
  link.download = 'tickets.csv';
  link.click();
});
document.querySelectorAll('[data-admin-view]').forEach((button) => button.addEventListener('click', async () => {
  const view = button.dataset.adminView;
  document.querySelectorAll('[data-admin-view]').forEach((item) => item.classList.toggle('active', item === button));
  document.querySelectorAll('.admin-view').forEach((item) => item.classList.toggle('active', item.id === `${view}-view`));
  if (view === 'stores') await loadStores().catch((error) => alert(error.message));
  if (view === 'tiers') await loadTiers().catch((error) => alert(error.message));
}));
document.querySelector('#new-store').addEventListener('click', () => openStoreDialog());
document.querySelector('#store-form').addEventListener('submit', saveStore);
document.querySelector('#close-store-dialog').addEventListener('click', () => document.querySelector('#store-dialog').close());
document.querySelector('#cancel-store').addEventListener('click', () => document.querySelector('#store-dialog').close());
document.querySelector('#new-tier').addEventListener('click', () => openTierDialog());
document.querySelector('#tier-form').addEventListener('submit', saveTier);
document.querySelector('#close-tier-dialog').addEventListener('click', () => document.querySelector('#tier-dialog').close());
document.querySelector('#cancel-tier').addEventListener('click', () => document.querySelector('#tier-dialog').close());
load().catch((error) => alert(error.message));
loadFilterStores().catch((error) => alert(error.message));
