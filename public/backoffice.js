const state = {
  rows: [], stores: [], spaces: [], tiers: [], ticketUsers: [], settings: [], adminUsers: [], trainingSamples: [], trainingProfile: null, selected: null,
  currentAdmin: null,
  pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1, hasPrevious: false, hasNext: false },
  ticketUserPagination: { page: 1, pageSize: 50, total: 0, totalPages: 1, hasPrevious: false, hasNext: false },
  reviewing: false,
  trainingEvaluationRunning: false,
  trainingEvaluationSampleId: '',
  token: sessionStorage.getItem('admin-token') || '',
};
let storeLogoPreviewObjectUrl = '';
let trainingDraftFiles = [];
const trainingReceiptPicker = {
  receipts: [],
  query: '',
  page: 1,
  pagination: { page: 1, total: 0, totalPages: 1, hasPrevious: false, hasNext: false },
};
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
  CLEARED: 'Resuelto',
  FRAUD: 'Marcado como fraude',
};
const adminRoleLabels = {
  SUPERADMIN: 'Superadministrador',
  ADMIN: 'Administrador',
  OPERATOR: 'Operador',
};
const reasonLabels = {
  OCR_PROCESSING_FAILED: 'La lectura automática ha fallado y necesita revisión.',
  OCR_VERIFICATION_REQUIRED: 'El OCR no ha podido verificar todos los datos. No se ha rechazado automáticamente.',
  OCR_MISSING_TICKET_NUMBER: 'Falta el número de ticket.',
  OCR_MISSING_TICKET_NUMBER_OR_TIME: 'Falta un número de ticket o una hora de compra verificable.',
  OCR_UNVERIFIED_TICKET_NUMBER: 'El número no coincide con su evidencia visible.',
  OCR_MISSING_DATE: 'Falta la fecha de compra.',
  OCR_UNVERIFIED_DATE: 'La fecha no coincide con su evidencia visible.',
  OCR_MISSING_TOTAL: 'Falta el importe total.',
  OCR_UNVERIFIED_TOTAL: 'El importe no coincide con su evidencia visible.',
  DECLARED_STORE_MISMATCH: 'El comercio reconocido no coincide con el indicado por el usuario.',
  DECLARED_STORE_UNVERIFIED: 'El comercio indicado no se ha podido confirmar en la cabecera visible.',
  DECLARED_TICKET_NUMBER_MISMATCH: 'El número reconocido no coincide con el indicado por el usuario.',
  DECLARED_TOTAL_MISMATCH: 'El total reconocido no coincide con el indicado por el usuario.',
  NOT_A_RECEIPT: 'La imagen no parece un ticket de compra.',
  DUPLICATE: 'El ticket ya había sido utilizado.',
  DUPLICATE_IMAGE: 'La misma imagen ya había sido enviada.',
  STORE_NOT_ALLOWED: 'El comercio no está autorizado.',
  TICKET_NUMBER_REQUIRED: 'No se ha reconocido el número del ticket.',
  TICKET_NUMBER_OR_TIME_REQUIRED: 'No se ha reconocido un número de ticket ni una hora de compra verificable.',
  INVALID_TOTAL: 'El importe no es válido.',
  INVALID_DATE: 'No se ha reconocido una fecha válida.',
  FUTURE_DATE: 'La fecha está fuera del periodo permitido.',
  TICKET_TOO_OLD: 'La fecha del ticket supera el periodo permitido.',
  DAILY_STORE_LIMIT: 'El usuario alcanzó el límite diario para este establecimiento.',
  OCR_REPROCESS_REQUESTED: 'La nueva comprobación está en curso.',
};

function receiptStatusLabel(receipt) {
  if (receipt.verificationRequired) return 'Lectura pendiente de revisión';
  return statusLabels[receipt.status] || receipt.status;
}

function isOperator() {
  return state.currentAdmin?.role === 'OPERATOR';
}
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

function applyRolePermissions() {
  const operator = isOperator();
  document.body.dataset.adminRole = state.currentAdmin?.role || '';
  document.querySelector('#manager-email').textContent = state.currentAdmin?.email || '';
  document.querySelector('#manager-role').textContent = adminRoleLabels[state.currentAdmin?.role] || '';
  document.querySelectorAll('[data-operator-hidden]').forEach((element) => { element.hidden = operator; });
  document.querySelector('#new-store').hidden = operator;
  document.querySelector('#stores-read-only').hidden = !operator;
  document.querySelector('#settings-read-only').hidden = !operator;
  document.querySelector('.admin-users-card').hidden = operator;
  document.querySelectorAll('#settings-view input, #settings-view textarea').forEach((control) => {
    control.disabled = operator;
  });
  document.querySelectorAll('#settings-view form button[type="submit"]').forEach((button) => {
    button.hidden = operator;
  });
}

async function loadAdminSession() {
  const payload = await request('/api/admin/session');
  state.currentAdmin = payload.current;
  applyRolePermissions();
}

function closeDialogOnBackdrop(dialog, beforeClose) {
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    const outsideContent = event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom;
    if (!outsideContent) return;
    beforeClose?.();
    dialog.close();
  });
}

function filterParams() {
  const params = new URLSearchParams(new FormData(document.querySelector('#filters')));
  for (const [key, value] of [...params]) if (!value) params.delete(key);
  return params;
}

function formatFilterDate(value) {
  return formatSpanishDate(value);
}

function formatSpanishDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!match) return value || '—';
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function formatSpanishDateTime(value) {
  const text = String(value || '');
  const formattedDate = formatSpanishDate(text);
  const time = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/.exec(text)?.[1];
  return time ? `${formattedDate} · ${time}` : formattedDate;
}

function activeFilterDescriptions(params) {
  const descriptions = [];
  const add = (key, label, format = (value) => value) => {
    const value = params.get(key);
    if (value) descriptions.push(`${label}: ${format(value)}`);
  };
  add('user', 'Búsqueda');
  add('store', 'Comercio');
  add('space', 'Espacio');
  add('status', 'Estado', (value) => statusLabels[value] || value);
  add('review', 'Resultado antifraude', (value) => reviewLabels[value] || value);
  add('from', 'Compra desde', formatFilterDate);
  add('to', 'Compra hasta', formatFilterDate);
  if (params.get('attention')) descriptions.push('Solo tickets con incidencias');
  return descriptions;
}

function renderEmptyReceiptList(params) {
  const filters = activeFilterDescriptions(params);
  if (!filters.length) return '<div class="empty-state receipt-empty-state"><p>No hay registros.</p></div>';
  return `<div class="empty-state receipt-empty-state">
    <p>No hay registros con estos filtros.</p>
    <strong>Filtros aplicados:</strong>
    <ul>${filters.map((filter) => `<li>${escapeHtml(filter)}</li>`).join('')}</ul>
  </div>`;
}

async function load(page = state.pagination.page) {
  const params = filterParams();
  params.set('page', String(page));
  const payload = await request(`/api/admin/receipts?${params}`);
  document.querySelector('#manager-email').textContent = payload.manager || '';
  state.rows = payload.receipts;
  state.pagination = payload.pagination;
  document.querySelector('#record-count').textContent = state.pagination.total;
  document.querySelector('#page-info').textContent = `Página ${state.pagination.page} de ${state.pagination.totalPages}`;
  document.querySelector('#previous-page').disabled = !state.pagination.hasPrevious;
  document.querySelector('#next-page').disabled = !state.pagination.hasNext;
  document.querySelector('#receipt-pagination').hidden = state.pagination.totalPages <= 1;
  document.querySelector('#receipt-list').innerHTML = state.rows.map((receipt) => `
    <button class="receipt-row" data-id="${receipt.id}">
      <span><strong>${escapeHtml(receipt.publicId)}</strong><small>${escapeHtml(receipt.user?.lookupCode || '')}${receipt.user?.lookupCode ? ' · ' : ''}${escapeHtml(receipt.user?.displayName || receipt.fields.storeName || 'Sin usuario')}</small></span>
      <span><strong>${formatMoney(receipt.fields.totalCents)}</strong><small>${receipt.reward.pointsAwarded} puntos</small></span>
      <span class="status-chip ${escapeHtml(receipt.status.toLowerCase())}">${escapeHtml(receiptStatusLabel(receipt))} · ${escapeHtml(reviewLabels[receipt.review.status] || receipt.review.status)}</span>
    </button>`).join('') || renderEmptyReceiptList(params);
  document.querySelectorAll('.receipt-row').forEach((button) => button.addEventListener('click', () => select(button.dataset.id)));
  highlightSelectedRow();
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
      <span class="store-identity">${store.logoUrl ? `<img src="${escapeHtml(store.logoUrl)}" alt="" loading="lazy" />` : '<span class="store-logo-empty" aria-hidden="true">—</span>'}<span><strong>${escapeHtml(store.name)}</strong><small>${escapeHtml(store.code)}</small></span></span>
      <span class="alias-list">${store.aliases.length ? store.aliases.map((alias) => `<small>${escapeHtml(alias)}</small>`).join('') : '<small>Sin alias</small>'}</span>
      <strong>${store.receiptCount}</strong>
      <span class="status-chip ${store.active ? 'rewarded' : 'duplicate'}">${store.active ? 'ACTIVO' : 'INACTIVO'}</span>
      <button class="secondary-button edit-store" data-id="${store.id}" type="button">${isOperator() ? 'Consultar' : 'Editar'}</button>
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

function populateSpaceFilters() {
  const options = state.spaces.map((space) => `<option value="${escapeHtml(space)}">${escapeHtml(space)}</option>`).join('');
  ['#receipt-space-filter', '#ticket-user-space-filter'].forEach((selector) => {
    const select = document.querySelector(selector);
    const selected = select.value;
    select.innerHTML = `<option value="">Todos los espacios</option>${options}`;
    if ([...select.options].some((option) => option.value === selected)) select.value = selected;
  });
}

async function loadSpaces() {
  const payload = await request('/api/admin/spaces');
  state.spaces = payload.spaces;
  populateSpaceFilters();
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

function ticketUserParams(page = state.ticketUserPagination.page) {
  const params = new URLSearchParams(new FormData(document.querySelector('#ticket-user-search')));
  for (const [key, value] of [...params]) if (!value) params.delete(key);
  params.set('page', String(page));
  return params;
}

async function loadTicketUsers(page = state.ticketUserPagination.page) {
  const payload = await request(`/api/admin/ticket-users?${ticketUserParams(page)}`);
  state.ticketUsers = payload.users;
  state.ticketUserPagination = payload.pagination;
  document.querySelector('#ticket-user-list').innerHTML = state.ticketUsers.map((user) => {
    const status = user.banStatus === 'BANNED' ? 'Baneado' : user.banStatus === 'LIFTING' ? 'Limpiando' : 'Permitido';
    const statusClass = user.banStatus === 'BANNED' ? 'revoked' : user.banStatus === 'LIFTING' ? 'reward_pending' : 'rewarded';
    return `
    <article class="ticket-user-row">
      <span><strong class="ban-lookup-code">${escapeHtml(user.lookupCode)}</strong><small>${escapeHtml(user.displayName || 'Sin nombre')}${user.email ? ` · ${escapeHtml(user.email)}` : ''}</small><small>Espacio: ${escapeHtml(user.spaceCode || '—')}</small></span>
      <strong>${user.ticketsSubmitted}</strong>
      <strong class="validated-count">${user.ticketsValidated}</strong>
      <strong>${user.ticketsUnvalidated}</strong>
      <strong class="${user.strikePoints ? 'strike-count' : ''}">${user.strikePoints}/${user.banThreshold || '—'}</strong>
      <strong>${formatMoney(user.authorizedTotalCents)}</strong>
      <span class="status-chip ${statusClass}">${status}</span>
      <span class="ticket-user-actions"><button class="secondary-button view-ticket-user" data-code="${escapeHtml(user.lookupCode)}" type="button">Ver</button>${user.banStatus === 'BANNED' ? `<button class="danger-button lift-ticket-user" data-id="${escapeHtml(user.banId)}" type="button">Desbanear</button>` : ''}</span>
    </article>`;
  }).join('') || '<p class="empty-state">No hay usuarios con tickets para esta búsqueda.</p>';
  document.querySelectorAll('.view-ticket-user').forEach((button) => button.addEventListener('click', () => openTicketUserDetail(button.dataset.code)));
  document.querySelectorAll('.lift-ticket-user').forEach((button) => button.addEventListener('click', () => liftTicketUserBan(button.dataset.id)));
  const pagination = state.ticketUserPagination;
  document.querySelector('#ticket-user-page-info').textContent = `Página ${pagination.page} de ${pagination.totalPages}`;
  document.querySelector('#previous-ticket-users').disabled = !pagination.hasPrevious;
  document.querySelector('#next-ticket-users').disabled = !pagination.hasNext;
  document.querySelector('#ticket-user-pagination').hidden = pagination.totalPages <= 1;
}

async function liftTicketUserBan(id) {
  if (!confirm('Se eliminarán las imágenes infractoras. Si hay puntos concedidos, primero se anularán. ¿Desbanear al usuario?')) return;
  const result = await request(`/api/admin/bans/${id}/lift`, { method: 'POST' });
  document.querySelector('#ticket-user-detail-dialog').close();
  await loadTicketUsers();
  showNotice(result.completed ? 'Usuario desbaneado e imágenes eliminadas.' : 'La anulación y limpieza están en proceso.');
}

async function openTicketUserDetail(lookupCode) {
  const dialog = document.querySelector('#ticket-user-detail-dialog');
  const body = document.querySelector('#ticket-user-detail-body');
  document.querySelector('#ticket-user-detail-title').textContent = lookupCode;
  body.innerHTML = '<p class="empty-state">Cargando…</p>';
  dialog.showModal();
  try {
    const payload = await request(`/api/admin/ticket-users/${encodeURIComponent(lookupCode)}`);
    const user = payload.user;
    const status = user.banStatus === 'BANNED' ? 'Baneado' : user.banStatus === 'LIFTING' ? 'Desbaneo en proceso' : 'Permitido';
    body.innerHTML = `<div class="ticket-user-detail-summary">
      <div><span>Nombre</span><strong>${escapeHtml(user.displayName || 'Sin nombre')}</strong><small>${escapeHtml(user.email || 'Correo no compartido')}</small></div>
      <div><span>Espacio</span><strong>${escapeHtml(user.spaceCode || '—')}</strong></div>
      <div><span>Estado</span><strong>${status}</strong><small>${user.strikePoints}/${user.banThreshold || '—'} puntos</small></div>
      <div><span>Actividad</span><strong>${user.ticketsValidated} validados</strong><small>${user.ticketsSubmitted} subidos · ${user.ticketsUnvalidated} sin validar</small></div>
      <div><span>Compras autorizadas</span><strong>${formatMoney(user.authorizedTotalCents)}</strong></div>
    </div>
    <section class="ticket-user-offenses"><h3>Infracciones activas</h3>
      <div class="offense-summary"><span>No-tickets: <strong>${user.nonReceiptCount}</strong></span><span>Fraudes confirmados: <strong>${user.confirmedFraudCount}</strong></span></div>
      ${payload.offenses.length ? payload.offenses.map((offense) => `<article><span><strong>${offense.category === 'CONFIRMED_FRAUD' ? 'Fraude confirmado' : 'Imagen no-ticket'}</strong><small><button class="text-button open-offense-ticket" data-id="${escapeHtml(offense.receiptId)}" data-public-id="${escapeHtml(offense.receiptPublicId)}" type="button">${escapeHtml(offense.receiptPublicId)}</button> · ${escapeHtml(new Date(offense.createdAt).toLocaleString('es-ES'))}</small></span><b>+${offense.score}</b></article>`).join('') : '<p class="empty-state">No tiene infracciones activas.</p>'}
    </section>
    ${user.banStatus === 'BANNED' ? `<div class="dialog-actions"><button class="danger-button" id="detail-lift-ticket-user" type="button">Desbanear usuario</button></div>` : ''}`;
    document.querySelector('#detail-lift-ticket-user')?.addEventListener('click', () => liftTicketUserBan(user.banId));
    document.querySelectorAll('.open-offense-ticket').forEach((button) => button.addEventListener('click', () =>
      openOffenseTicket(button.dataset.id, button.dataset.publicId)));
  } catch (error) {
    body.innerHTML = `<p class="form-error">${escapeHtml(error instanceof Error ? error.message : 'No se pudo cargar el usuario')}</p>`;
  }
}

async function openOffenseTicket(receiptId, receiptPublicId) {
  document.querySelector('#ticket-user-detail-dialog').close();
  const receiptsTab = document.querySelector('[data-admin-view="receipts"]');
  document.querySelectorAll('[data-admin-view]').forEach((item) => item.classList.toggle('active', item === receiptsTab));
  document.querySelectorAll('.admin-view').forEach((item) => item.classList.toggle('active', item.id === 'receipts-view'));
  const filters = document.querySelector('#filters');
  filters.reset();
  document.querySelector('[name="attention"]').checked = false;
  filters.elements.user.value = receiptPublicId || '';
  updateFilterCount();
  await load(1);
  await select(receiptId);
  document.querySelector('#review-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function exportTicketUsers() {
  const params = ticketUserParams(1);
  params.delete('page');
  const response = await fetch(`/api/admin/ticket-users.csv?${params}`, { headers: headers() });
  if (!response.ok) return alert('No se pudo exportar el listado de usuarios.');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await response.blob());
  link.download = 'usuarios-tickets.csv';
  link.click();
  URL.revokeObjectURL(link.href);
}

function appendSettingText(parent, value) {
  value.split('\n').forEach((line, index) => {
    if (index) parent.append(document.createElement('br'));
    parent.append(document.createTextNode(line));
  });
}

function renderSettingFormattedText(node, value) {
  node.replaceChildren();
  const pattern = /\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    appendSettingText(node, value.slice(cursor, match.index));
    if (match[1] !== undefined) {
      const strong = document.createElement('strong');
      strong.textContent = match[1];
      node.append(strong);
    } else {
      const link = document.createElement('a');
      link.textContent = match[2];
      link.href = match[3];
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      node.append(link);
    }
    cursor = Number(match.index) + match[0].length;
  }
  appendSettingText(node, value.slice(cursor));
}

function selectedSetting() {
  return state.settings.find((setting) => setting.key === document.querySelector('#setting-select').value);
}

function settingEditorValue(setting) {
  if (setting.format === 'rich') return document.querySelector('#setting-rich-value').value;
  return document.querySelector('#setting-plain-value').value;
}

function updateSettingPreview() {
  const setting = selectedSetting();
  if (!setting) return;
  const preview = document.querySelector('#setting-preview-content');
  const value = settingEditorValue(setting);
  if (setting.format === 'rich') renderSettingFormattedText(preview, value);
  else preview.textContent = value;
}

function renderSettingEditor() {
  const setting = selectedSetting();
  if (!setting) return;
  const plainField = document.querySelector('#setting-plain-field');
  const richField = document.querySelector('#setting-rich-field');
  const plainInput = document.querySelector('#setting-plain-value');
  const richInput = document.querySelector('#setting-rich-value');
  plainField.hidden = setting.format !== 'plain';
  richField.hidden = setting.format !== 'rich';
  plainInput.value = setting.format === 'plain' ? setting.value : '';
  richInput.value = setting.format === 'rich' ? setting.value : '';
  plainInput.maxLength = setting.maxLength;
  richInput.maxLength = setting.maxLength;
  document.querySelector('#setting-help').textContent = setting.help;
  document.querySelector('#setting-form-error').textContent = '';
  updateSettingPreview();
}

async function loadSettings() {
  const payload = await request('/api/admin/settings');
  state.settings = payload.settings;
  document.querySelector('#validation-start-at').value = state.settings.find((item) => item.key === 'validation.startAt')?.value || '';
  document.querySelector('#validation-end-at').value = state.settings.find((item) => item.key === 'validation.endAt')?.value || '';
  document.querySelector('#daily-store-ticket-limit').value = state.settings.find((item) => item.key === 'limits.dailyTicketsPerUserStore')?.value || '3';
  document.querySelector('#total-upload-limit').value = state.settings.find((item) => item.key === 'limits.totalUploadsPerUser')?.value || '30';
  document.querySelector('#ban-score-threshold').value = state.settings.find((item) => item.key === 'limits.banScoreThreshold')?.value || '6';
  document.querySelector('#assisted-scan-enabled').checked = state.settings.find((item) => item.key === 'scan.assisted.enabled')?.value !== 'false';
  document.querySelector('#assisted-scan-require-store').checked = state.settings.find((item) => item.key === 'scan.assisted.requireStore')?.value !== 'false';
  document.querySelector('#assisted-scan-require-store').disabled = isOperator() || !document.querySelector('#assisted-scan-enabled').checked;
  document.querySelector('#manager-email').textContent = payload.manager || '';
  const select = document.querySelector('#setting-select');
  const previous = select.value;
  const groups = new Map();
  for (const setting of state.settings.filter((item) => ['plain', 'rich'].includes(item.format))) {
    if (!groups.has(setting.group)) groups.set(setting.group, []);
    groups.get(setting.group).push(setting);
  }
  select.replaceChildren(...[...groups].map(([group, settings]) => {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group;
    for (const setting of settings) {
      const option = document.createElement('option');
      option.value = setting.key;
      option.textContent = setting.label;
      optgroup.append(option);
    }
    return optgroup;
  }));
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  renderSettingEditor();
}

async function saveValidationPeriod(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const errorNode = document.querySelector('#validation-period-error');
  button.disabled = true;
  errorNode.textContent = '';
  try {
    await request('/api/admin/settings/validation-period', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        startAt: document.querySelector('#validation-start-at').value,
        endAt: document.querySelector('#validation-end-at').value,
      }),
    });
    await loadSettings();
    showNotice('Periodo de validación actualizado.');
  } catch (error) {
    errorNode.textContent = error instanceof Error ? error.message : 'No se pudo guardar el periodo';
  } finally { button.disabled = false; }
}

async function saveParticipationLimits(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const errorNode = document.querySelector('#participation-limits-error');
  button.disabled = true;
  errorNode.textContent = '';
  try {
    await request('/api/admin/settings/participation-limits', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        dailyTicketsPerUserStore: document.querySelector('#daily-store-ticket-limit').value,
        totalUploadsPerUser: document.querySelector('#total-upload-limit').value,
        banScoreThreshold: document.querySelector('#ban-score-threshold').value,
      }),
    });
    await loadSettings();
    showNotice('Límites de participación actualizados.');
  } catch (error) {
    errorNode.textContent = error instanceof Error ? error.message : 'No se pudieron guardar los límites';
  } finally { button.disabled = false; }
}

async function saveScanFlowSettings(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const errorNode = document.querySelector('#scan-flow-settings-error');
  button.disabled = true;
  errorNode.textContent = '';
  try {
    await request('/api/admin/settings/scan-flow', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        enabled: String(document.querySelector('#assisted-scan-enabled').checked),
        requireStore: String(document.querySelector('#assisted-scan-require-store').checked),
      }),
    });
    await loadSettings();
    showNotice('Flujo de escaneo actualizado.');
  } catch (error) {
    errorNode.textContent = error instanceof Error ? error.message : 'No se pudo guardar el flujo de escaneo';
  } finally { button.disabled = false; }
}

function renderAdminUsers(current, backofficeUrl) {
  const canCreateUsers = ['SUPERADMIN', 'ADMIN'].includes(current.role);
  const roleSelect = document.querySelector('#admin-user-role');
  document.querySelector('#admin-user-form').hidden = !canCreateUsers;
  roleSelect.querySelector('[value="ADMIN"]').hidden = current.role !== 'SUPERADMIN';
  if (current.role !== 'SUPERADMIN') roleSelect.value = 'OPERATOR';
  document.querySelector('#admin-user-list').innerHTML = state.adminUsers.map((user) => `
    <article class="admin-user-row">
      <span><strong>${escapeHtml(user.email)}</strong><small>${escapeHtml(adminRoleLabels[user.role] || user.role)}</small></span>
      <button class="secondary-button copy-admin-link" data-url="${escapeHtml(backofficeUrl)}" type="button">Copiar enlace</button>
      ${(current.role === 'SUPERADMIN' && user.role !== 'SUPERADMIN') || (current.role === 'ADMIN' && user.role === 'OPERATOR')
        ? `<button class="danger-button delete-admin-user" data-id="${escapeHtml(user.id)}" type="button">Eliminar</button>` : ''}
    </article>`).join('');
  document.querySelectorAll('.copy-admin-link').forEach((button) => button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(button.dataset.url);
    showNotice('Enlace de acceso copiado.');
  }));
  document.querySelectorAll('.delete-admin-user').forEach((button) => button.addEventListener('click', () => deleteAdminUser(button.dataset.id)));
}

async function loadAdminUsers() {
  const payload = await request('/api/admin/users');
  state.adminUsers = payload.users;
  document.querySelector('#access-sync-warning').hidden = payload.accessConfigured;
  document.querySelector('#invite-mail-warning').hidden = payload.mailConfigured;
  renderAdminUsers(payload.current, payload.backofficeUrl);
}

async function saveAdminUser(event) {
  event.preventDefault();
  const input = document.querySelector('#admin-user-email');
  const errorNode = document.querySelector('#admin-user-error');
  errorNode.textContent = '';
  try {
    const payload = await request('/api/admin/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        email: input.value,
        role: document.querySelector('#admin-user-role').value,
      }),
    });
    input.value = '';
    await loadAdminUsers();
    await navigator.clipboard.writeText(payload.backofficeUrl).catch(() => undefined);
    showNotice(payload.invitationSent
      ? 'Usuario añadido; invitación enviada por correo.'
      : 'Usuario añadido, pero no se pudo enviar la invitación; enlace copiado.');
  } catch (error) { errorNode.textContent = error instanceof Error ? error.message : 'No se pudo añadir el usuario'; }
}

async function deleteAdminUser(id) {
  if (!confirm('¿Eliminar el acceso de este usuario?')) return;
  await request(`/api/admin/users/${id}`, { method: 'DELETE' });
  await loadAdminUsers();
  showNotice('Acceso eliminado.');
}

async function saveSetting(event) {
  event.preventDefault();
  const setting = selectedSetting();
  if (!setting) return;
  const value = settingEditorValue(setting);
  const submitButton = event.currentTarget.querySelector('[type="submit"]');
  const errorNode = document.querySelector('#setting-form-error');
  submitButton.disabled = true;
  submitButton.textContent = 'Guardando…';
  errorNode.textContent = '';
  try {
    const payload = await request(`/api/admin/settings/${encodeURIComponent(setting.key)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    const index = state.settings.findIndex((item) => item.key === setting.key);
    state.settings[index] = payload.setting;
    renderSettingEditor();
    showNotice('Texto actualizado correctamente.');
  } catch (error) {
    errorNode.textContent = error instanceof Error ? error.message : 'No se pudo guardar el texto';
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Guardar texto';
  }
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
  const readOnly = isOperator();
  const form = document.querySelector('#store-form');
  form.reset();
  form.elements.id.value = store?.id || '';
  form.elements.name.value = store?.name || '';
  form.elements.code.value = store?.code || '';
  form.elements.aliases.value = (store?.aliases || []).join('\n');
  form.elements.active.checked = store?.active ?? true;
  setStoreLogoPreview(store?.logoUrl || '');
  clearTrainingDrafts();
  state.trainingSamples = [];
  renderOcrProfile(store?.ocrProfile || {});
  document.querySelector('#training-samples').replaceChildren();
  document.querySelector('#training-summary').replaceChildren();
  document.querySelector('#training-tab-count').textContent = '0';
  document.querySelector('#store-training-tab').disabled = !store;
  setStorePanel('details');
  document.querySelector('#store-dialog-title').textContent = readOnly ? 'Consultar comercio' : store ? 'Editar comercio' : 'Añadir comercio';
  document.querySelector('#store-form-error').textContent = '';
  form.querySelectorAll('input:not([type="hidden"]), textarea, select').forEach((control) => {
    control.disabled = readOnly;
  });
  document.querySelector('#store-details-actions button[type="submit"]').hidden = readOnly;
  document.querySelector('#cancel-store').textContent = readOnly ? 'Cerrar' : 'Cancelar';
  document.querySelector('.training-add-options').hidden = readOnly;
  document.querySelector('#training-drafts').hidden = readOnly;
  document.querySelector('.training-batch-actions').hidden = readOnly;
  document.querySelector('#generate-ocr-profile').hidden = readOnly;
  document.querySelector('#save-ocr-profile').hidden = readOnly;
  document.querySelector('#store-dialog').showModal();
}

function setStorePanel(panel) {
  document.querySelectorAll('[data-store-panel]').forEach((button) => {
    button.classList.toggle('active', button.dataset.storePanel === panel);
  });
  document.querySelector('#store-details-panel').hidden = panel !== 'details';
  document.querySelector('#store-training-panel').hidden = panel !== 'training';
  document.querySelector('#store-details-panel').classList.toggle('active', panel === 'details');
  document.querySelector('#store-training-panel').classList.toggle('active', panel === 'training');
}

function setStoreLogoPreview(source = '', objectUrl = false) {
  if (storeLogoPreviewObjectUrl) URL.revokeObjectURL(storeLogoPreviewObjectUrl);
  storeLogoPreviewObjectUrl = objectUrl ? source : '';
  const preview = document.querySelector('#store-logo-preview');
  const placeholder = document.querySelector('#store-logo-placeholder');
  preview.hidden = !source;
  placeholder.hidden = Boolean(source);
  if (source) preview.src = source;
  else preview.removeAttribute('src');
}

function clearTrainingDrafts() {
  trainingDraftFiles.forEach((draft) => {
    if (draft.objectUrl) URL.revokeObjectURL(draft.previewUrl);
  });
  trainingDraftFiles = [];
  document.querySelector('#training-files').value = '';
  document.querySelector('#training-drafts').replaceChildren();
  document.querySelector('#training-form-error').textContent = '';
}

function openTrainingImage(source) {
  if (!source) return;
  const dialog = document.querySelector('#training-image-dialog');
  document.querySelector('#training-image-expanded').src = source;
  dialog.showModal();
}

function bindTrainingImageButtons(root = document) {
  root.querySelectorAll('.training-image-button').forEach((button) => {
    button.addEventListener('click', () => openTrainingImage(button.dataset.imageSrc));
  });
}

function trainingVerificationLabel(issue) {
  return reasonLabels[`OCR_${issue}`] || issue.replaceAll('_', ' ').toLocaleLowerCase('es');
}

function trainingEvaluationDetails(evaluation, expected) {
  if (!evaluation) return '<span class="training-not-evaluated">Sin evaluar</span>';
  if (evaluation.status === 'ERROR') {
    const retryLabel = evaluation.retryable ? 'Se puede reintentar' : 'Requiere revisión';
    return `<div class="training-evaluation-heading"><span class="status-chip auto_rejected">Error técnico</span><small>${escapeHtml(retryLabel)}</small></div><p class="training-error-detail">${escapeHtml(evaluation.errorMessage || evaluation.errorReason || 'No se pudo ejecutar el OCR')}</p>`;
  }
  const labels = {
    store: 'Comercio', ticketNumber: 'Número', purchaseDate: 'Fecha', purchaseTime: 'Hora', total: 'Importe', evidence: 'Evidencias',
  };
  const fields = Object.entries(labels).map(([key, label]) =>
    `<span class="training-match ${evaluation.matches?.[key] ? 'passed' : 'failed'}">${evaluation.matches?.[key] ? '✓' : '×'} ${label}</span>`).join('');
  const actual = evaluation.actual || {};
  const expectedIdentity = expected.ticketNumber || 'Sin número';
  const actualIdentity = actual.ticketNumber || (actual.purchaseDateTime ? 'Sin número; usa fecha y hora' : 'No reconocido');
  const expectedDate = expected.purchaseDate ? formatSpanishDate(expected.purchaseDate) : '—';
  const actualDate = actual.purchaseDate ? formatSpanishDate(actual.purchaseDate) : 'No reconocida';
  const expectedTime = expected.purchaseDateTime?.slice(11, 16) || 'No indicada';
  const actualTime = actual.purchaseDateTime?.slice(11, 16) || 'No reconocida';
  const expectedTotal = formatMoney(expected.totalCents);
  const actualTotal = actual.totalCents ? formatMoney(actual.totalCents) : 'No reconocido';
  const confidence = Number.isFinite(actual.confidence) ? `${Math.round(actual.confidence * 100)}%` : '—';
  const profileLabel = evaluation.context?.profileMode === 'CANDIDATE' ? 'perfil candidato' : 'perfil de producción';
  const catalogLabel = evaluation.context?.catalogStoreCount === undefined
    ? '' : ` · ${evaluation.context.catalogStoreCount} comercios activos`;
  const issues = (evaluation.verificationIssues || []).map(trainingVerificationLabel);
  const inactiveWarning = evaluation.context?.targetIncludedOutsideProduction
    ? '<p class="training-context-warning">Este comercio está inactivo: se incluyó solo para poder medir su OCR.</p>' : '';
  return `<div class="training-evaluation-heading"><span class="status-chip ${evaluation.status === 'PASSED' ? 'rewarded' : 'auto_rejected'}">${evaluation.status === 'PASSED' ? 'Correcto' : 'Con diferencias'}</span><small>${escapeHtml(evaluation.model)} · ${evaluation.attemptCount || 0} intentos · ${evaluation.durationMs ?? '—'} ms</small></div>
    <div class="training-matches">${fields}</div>
    <div class="training-evaluation-meta">OCR ${confidence} · ${escapeHtml(profileLabel + catalogLabel)}</div>
    <div class="training-comparison" role="table" aria-label="Valores esperados y reconocidos">
      <div class="training-comparison-heading" role="row"><span>Campo</span><strong>Esperado</strong><strong>Reconocido</strong></div>
      <div role="row"><span>Número</span><strong>${escapeHtml(expectedIdentity)}</strong><strong>${escapeHtml(actualIdentity)}</strong></div>
      <div role="row"><span>Fecha</span><strong>${escapeHtml(expectedDate)}</strong><strong>${escapeHtml(actualDate)}</strong></div>
      <div role="row"><span>Hora</span><strong>${escapeHtml(expectedTime)}</strong><strong>${escapeHtml(actualTime)}</strong></div>
      <div role="row"><span>Importe</span><strong>${escapeHtml(expectedTotal)}</strong><strong>${escapeHtml(actualTotal)}</strong></div>
      <div role="row"><span>Comercio</span><strong>${escapeHtml(document.querySelector('#store-form').elements.name.value || 'Comercio esperado')}</strong><strong>${escapeHtml(actual.storeName || 'No reconocido')}</strong></div>
    </div>
    ${issues.length ? `<ul class="training-issues">${issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join('')}</ul>` : ''}${inactiveWarning}`;
}

function profileLines(value) {
  return Array.isArray(value) ? value.join('\n') : '';
}

function updateOcrProfileStatus() {
  const enabled = document.querySelector('#ocr-profile-enabled').checked;
  const status = document.querySelector('#ocr-profile-status');
  status.textContent = enabled ? 'ACTIVO' : 'INACTIVO';
  status.className = `status-chip ${enabled ? 'rewarded' : 'duplicate'}`;
}

function renderOcrProfile(profile = {}) {
  state.trainingProfile = profile;
  document.querySelector('#ocr-profile-enabled').checked = profile.enabled === true;
  document.querySelector('#ocr-profile-signatures').value = profileLines(profile.headerSignatures);
  document.querySelector('#ocr-profile-ticket-labels').value = profileLines(profile.ticketNumberLabels);
  document.querySelector('#ocr-profile-ticket-help').value = profile.ticketNumberHelp || '';
  document.querySelector('#ocr-profile-ticket-example').value = profile.ticketNumberExample || '';
  document.querySelector('#ocr-profile-date-labels').value = profileLines(profile.dateLabels);
  document.querySelector('#ocr-profile-total-labels').value = profileLines(profile.totalLabels);
  document.querySelector('#ocr-profile-ignore-labels').value = profileLines(profile.ignoredTotalLabels);
  document.querySelector('#ocr-profile-ticket-region').value = profile.ticketNumberRegion || 'header';
  document.querySelector('#ocr-profile-date-region').value = profile.dateRegion || 'header';
  document.querySelector('#ocr-profile-total-region').value = profile.totalRegion || 'footer';
  document.querySelector('#ocr-profile-date-format').value = profile.dateFormat || '';
  document.querySelector('#ocr-profile-instructions').value = profile.instructions || '';
  document.querySelector('#ocr-profile-meta').textContent = profile.sampleCount
    ? `Perfil generado a partir de ${profile.sampleCount} ${profile.sampleCount === 1 ? 'ejemplo evaluado' : 'ejemplos evaluados'}.`
    : 'Perfil todavía no generado desde ejemplos.';
  document.querySelector('#ocr-profile-error').textContent = '';
  updateOcrProfileStatus();
}

function linesFromProfileField(selector) {
  return document.querySelector(selector).value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function ocrProfileFormValue() {
  return {
    version: 1,
    enabled: document.querySelector('#ocr-profile-enabled').checked,
    headerSignatures: linesFromProfileField('#ocr-profile-signatures'),
    ticketNumberLabels: linesFromProfileField('#ocr-profile-ticket-labels'),
    ticketNumberHelp: document.querySelector('#ocr-profile-ticket-help').value.trim(),
    ticketNumberExample: document.querySelector('#ocr-profile-ticket-example').value.trim(),
    dateLabels: linesFromProfileField('#ocr-profile-date-labels'),
    totalLabels: linesFromProfileField('#ocr-profile-total-labels'),
    ignoredTotalLabels: linesFromProfileField('#ocr-profile-ignore-labels'),
    ticketNumberRegion: document.querySelector('#ocr-profile-ticket-region').value,
    dateRegion: document.querySelector('#ocr-profile-date-region').value,
    totalRegion: document.querySelector('#ocr-profile-total-region').value,
    dateFormat: document.querySelector('#ocr-profile-date-format').value,
    instructions: document.querySelector('#ocr-profile-instructions').value,
    sampleCount: state.trainingProfile?.sampleCount || 0,
  };
}

async function generateOcrProfile() {
  const storeId = document.querySelector('#store-form').elements.id.value;
  const button = document.querySelector('#generate-ocr-profile');
  const errorNode = document.querySelector('#ocr-profile-error');
  errorNode.textContent = '';
  button.disabled = true;
  button.textContent = 'Generando…';
  try {
    const payload = await request(`/api/admin/stores/${storeId}/ocr-profile/generate`, { method: 'POST' });
    renderOcrProfile(payload.profile);
    showNotice('Borrador de perfil generado. Revísalo y guárdalo para utilizarlo.');
  } catch (error) {
    errorNode.textContent = error instanceof Error ? error.message : 'No se pudo generar el perfil';
  } finally {
    button.disabled = false;
    button.textContent = 'Generar desde ejemplos evaluados';
  }
}

async function saveOcrProfile() {
  const storeId = document.querySelector('#store-form').elements.id.value;
  const button = document.querySelector('#save-ocr-profile');
  const errorNode = document.querySelector('#ocr-profile-error');
  errorNode.textContent = '';
  button.disabled = true;
  button.textContent = 'Guardando…';
  try {
    const payload = await request(`/api/admin/stores/${storeId}/ocr-profile`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ocrProfileFormValue()),
    });
    renderOcrProfile(payload.profile);
    const store = state.stores.find((item) => item.id === storeId);
    if (store) store.ocrProfile = payload.profile;
    showNotice(payload.profile.enabled ? 'Perfil OCR guardado y activado.' : 'Perfil OCR guardado como inactivo.');
  } catch (error) {
    errorNode.textContent = error instanceof Error ? error.message : 'No se pudo guardar el perfil';
  } finally {
    button.disabled = false;
    button.textContent = 'Guardar perfil';
  }
}

function renderTrainingSamples() {
  const passed = state.trainingSamples.filter((sample) => sample.evaluation?.status === 'PASSED').length;
  const evaluated = state.trainingSamples.filter((sample) => sample.evaluation).length;
  const errors = state.trainingSamples.filter((sample) => sample.evaluation?.status === 'ERROR').length;
  document.querySelector('#training-tab-count').textContent = String(state.trainingSamples.length);
  document.querySelector('#training-summary').innerHTML = state.trainingSamples.length
    ? `<strong>${state.trainingSamples.length} ejemplos</strong><span>${evaluated} evaluados · ${passed} completamente correctos${errors ? ` · ${errors} con error técnico` : ''}</span>`
    : '';
  document.querySelector('#evaluate-all-training').disabled = state.trainingEvaluationRunning || !state.trainingSamples.length;
  const retryButton = document.querySelector('#evaluate-failed-training');
  retryButton.hidden = isOperator() || errors === 0;
  retryButton.disabled = state.trainingEvaluationRunning;
  document.querySelector('#training-samples').innerHTML = state.trainingSamples.map((sample) => `
    <article class="training-sample" data-id="${escapeHtml(sample.id)}">
      <button class="training-image-button" type="button" data-image-src="${escapeHtml(sample.imageUrl)}" aria-label="Ampliar ticket de entrenamiento">
        <img src="${escapeHtml(sample.imageUrl)}" alt="Ticket de entrenamiento" loading="lazy" />
        <span>Ampliar</span>
      </button>
      <div class="training-ground-truth">
        <strong>${escapeHtml(sample.expected.ticketNumber || 'Sin número; identificado por hora')}</strong>
        <span>${escapeHtml(formatSpanishDateTime(sample.expected.purchaseDateTime || sample.expected.purchaseDate))} · ${formatMoney(sample.expected.totalCents)}</span>
        ${sample.notes ? `<small>${escapeHtml(sample.notes)}</small>` : ''}
        ${trainingEvaluationDetails(sample.evaluation, sample.expected)}
      </div>
      ${isOperator() ? '' : `<div class="training-actions">
        <button class="secondary-button evaluate-training" type="button" data-id="${escapeHtml(sample.id)}" ${state.trainingEvaluationRunning ? 'disabled' : ''}>${state.trainingEvaluationSampleId === sample.id ? 'Evaluando…' : 'Evaluar'}</button>
        <button class="text-button delete-training" type="button" data-id="${escapeHtml(sample.id)}" ${state.trainingEvaluationRunning ? 'disabled' : ''}>Eliminar</button>
      </div>`}
    </article>`).join('') || '<p class="empty-state">Todavía no hay tickets de entrenamiento para este comercio.</p>';
  document.querySelectorAll('.evaluate-training').forEach((button) => button.addEventListener('click', () => evaluateTrainingSample(button.dataset.id)));
  document.querySelectorAll('.delete-training').forEach((button) => button.addEventListener('click', () => deleteTrainingSample(button.dataset.id)));
  bindTrainingImageButtons(document.querySelector('#training-samples'));
}

async function loadTrainingSamples() {
  const storeId = document.querySelector('#store-form').elements.id.value;
  if (!storeId) return;
  const [payload, profilePayload] = await Promise.all([
    request(`/api/admin/stores/${storeId}/training`),
    request(`/api/admin/stores/${storeId}/ocr-profile`),
  ]);
  state.trainingSamples = payload.samples;
  renderTrainingSamples();
  renderOcrProfile(profilePayload.profile);
}

function renderTrainingReceiptCandidates() {
  const results = document.querySelector('#training-receipts-results');
  const pagination = trainingReceiptPicker.pagination;
  document.querySelector('#training-receipts-feedback').textContent = pagination.total
    ? `${pagination.total} ${pagination.total === 1 ? 'ticket disponible' : 'tickets disponibles'}`
    : 'No hay tickets vinculados a este comercio con esa búsqueda.';
  results.innerHTML = trainingReceiptPicker.receipts.map((receipt) => {
    const selected = trainingDraftFiles.some((draft) => draft.sourceReceiptId === receipt.id);
    const total = receipt.expected.totalCents ? formatMoney(receipt.expected.totalCents) : 'Importe pendiente';
    const user = receipt.user.displayName || receipt.user.email || receipt.user.subject || 'Usuario sin nombre';
    return `<article class="training-receipt-candidate">
      <button class="training-image-button" type="button" data-image-src="${escapeHtml(receipt.imageUrl)}" aria-label="Ampliar ${escapeHtml(receipt.publicId)}">
        <img src="${escapeHtml(receipt.imageUrl)}" alt="${escapeHtml(receipt.publicId)}" loading="lazy" />
        <span>Ampliar</span>
      </button>
      <div class="training-receipt-candidate-data">
        <strong>${escapeHtml(receipt.publicId)}</strong>
        <span>${escapeHtml(user)}</span>
        <small>${escapeHtml(receipt.expected.ticketNumber || (receipt.expected.purchaseDateTime ? 'Sin número' : 'Identidad pendiente'))} · ${escapeHtml(receipt.expected.purchaseDate ? formatSpanishDateTime(receipt.expected.purchaseDateTime || receipt.expected.purchaseDate) : 'Fecha pendiente')} · ${escapeHtml(total)}</small>
        <small>${escapeHtml(statusLabels[receipt.status] || receipt.status)} · subido ${escapeHtml(new Date(receipt.createdAt).toLocaleDateString('es-ES'))}</small>
      </div>
      <button class="${selected ? 'secondary-button' : 'primary-button'} select-training-receipt" type="button" data-id="${escapeHtml(receipt.id)}" ${selected ? 'disabled' : ''}>${selected ? 'Añadido' : 'Seleccionar'}</button>
    </article>`;
  }).join('');
  document.querySelector('#training-receipts-page').textContent = `Página ${pagination.page} de ${pagination.totalPages}`;
  document.querySelector('#training-receipts-previous').disabled = !pagination.hasPrevious;
  document.querySelector('#training-receipts-next').disabled = !pagination.hasNext;
  document.querySelector('#training-receipts-pagination').hidden = pagination.totalPages <= 1;
  document.querySelectorAll('.select-training-receipt').forEach((button) => button.addEventListener('click', () => {
    const receipt = trainingReceiptPicker.receipts.find((item) => item.id === button.dataset.id);
    if (!receipt) return;
    if (trainingDraftFiles.length >= 20) {
      document.querySelector('#training-receipts-feedback').textContent = 'Guarda o elimina algún borrador antes de añadir más tickets.';
      return;
    }
    const total = receipt.expected.totalCents > 0
      ? (receipt.expected.totalCents / 100).toFixed(2).replace('.', ',') : '';
    trainingDraftFiles.push({
      sourceReceiptId: receipt.id,
      previewUrl: receipt.imageUrl,
      objectUrl: false,
      label: receipt.publicId,
      sourceLabel: `Ticket subido por ${receipt.user.displayName || receipt.user.email || receipt.user.subject || 'usuario identificado'}`,
      values: {
        ticketNumber: receipt.expected.ticketNumber || '',
        purchaseDate: receipt.expected.purchaseDate || '',
        purchaseTime: receipt.expected.purchaseDateTime?.slice(11, 16) || '',
        total,
        notes: '',
      },
    });
    renderTrainingDrafts();
    document.querySelector('#training-receipts-dialog').close();
  }));
  bindTrainingImageButtons(results);
}

async function loadTrainingReceiptCandidates(page = 1) {
  const storeId = document.querySelector('#store-form').elements.id.value;
  if (!storeId) return;
  const feedback = document.querySelector('#training-receipts-feedback');
  const results = document.querySelector('#training-receipts-results');
  feedback.textContent = 'Buscando tickets…';
  results.innerHTML = '<p class="empty-state">Cargando…</p>';
  const params = new URLSearchParams({ page: String(page), pageSize: '12' });
  if (trainingReceiptPicker.query) params.set('query', trainingReceiptPicker.query);
  const payload = await request(`/api/admin/stores/${storeId}/training-candidates?${params}`);
  trainingReceiptPicker.receipts = payload.receipts;
  trainingReceiptPicker.pagination = payload.pagination;
  trainingReceiptPicker.page = payload.pagination.page;
  document.querySelector('#training-receipts-store').textContent = `Comercio: ${payload.store.name}`;
  renderTrainingReceiptCandidates();
}

async function openTrainingReceiptCandidates() {
  const dialog = document.querySelector('#training-receipts-dialog');
  trainingReceiptPicker.query = '';
  trainingReceiptPicker.page = 1;
  document.querySelector('#training-receipts-search').reset();
  dialog.showModal();
  try {
    await loadTrainingReceiptCandidates(1);
  } catch (error) {
    document.querySelector('#training-receipts-feedback').textContent = error instanceof Error
      ? error.message : 'No se pudieron buscar los tickets';
    document.querySelector('#training-receipts-results').replaceChildren();
  }
}

function renderTrainingDrafts() {
  document.querySelector('#training-drafts').innerHTML = trainingDraftFiles.map((draft, index) => `
    <article class="training-draft" data-index="${index}">
      <button class="training-image-button" type="button" data-image-src="${escapeHtml(draft.previewUrl)}" aria-label="Ampliar ${escapeHtml(draft.label)}">
        <img src="${escapeHtml(draft.previewUrl)}" alt="Vista previa de ${escapeHtml(draft.label)}" />
        <span>Ampliar</span>
      </button>
      <div class="training-draft-fields">
        <div class="training-draft-title"><strong>${escapeHtml(draft.label)}</strong>${draft.sourceLabel ? `<small>${escapeHtml(draft.sourceLabel)}</small>` : ''}</div>
        <label>Número del ticket<input data-training-field="ticketNumber" maxlength="160" placeholder="Opcional si el ticket muestra la hora" value="${escapeHtml(draft.values?.ticketNumber || '')}" /></label>
        <label>Fecha<input data-training-field="purchaseDate" type="date" value="${escapeHtml(draft.values?.purchaseDate || '')}" /></label>
        <label>Hora<input data-training-field="purchaseTime" type="time" value="${escapeHtml(draft.values?.purchaseTime || '')}" /><small>Indícala siempre que figure; es obligatoria si el ticket no tiene número.</small></label>
        <label>Importe total (€)<input data-training-field="total" inputmode="decimal" placeholder="15,92" value="${escapeHtml(draft.values?.total || '')}" /></label>
        <label class="training-notes-field">Notas<input data-training-field="notes" maxlength="1000" placeholder="Caja, formato o particularidades" value="${escapeHtml(draft.values?.notes || '')}" /></label>
      </div>
      <button class="icon-button remove-training-draft" type="button" data-index="${index}" aria-label="Quitar ejemplo">×</button>
    </article>`).join('') + (trainingDraftFiles.length
    ? `<div class="training-save-row"><button class="primary-button" id="save-training-drafts" type="button">Guardar ${trainingDraftFiles.length} ${trainingDraftFiles.length === 1 ? 'ejemplo' : 'ejemplos'}</button></div>` : '');
  document.querySelectorAll('.training-draft').forEach((card) => {
    const draft = trainingDraftFiles[Number(card.dataset.index)];
    card.querySelectorAll('[data-training-field]').forEach((input) => input.addEventListener('input', () => {
      draft.values ||= {};
      draft.values[input.dataset.trainingField] = input.value;
    }));
  });
  document.querySelectorAll('.remove-training-draft').forEach((button) => button.addEventListener('click', () => {
    const [removed] = trainingDraftFiles.splice(Number(button.dataset.index), 1);
    if (removed?.objectUrl) URL.revokeObjectURL(removed.previewUrl);
    renderTrainingDrafts();
  }));
  document.querySelector('#save-training-drafts')?.addEventListener('click', saveTrainingDrafts);
  bindTrainingImageButtons(document.querySelector('#training-drafts'));
}

async function saveTrainingDrafts(event) {
  const button = event.currentTarget;
  const storeId = document.querySelector('#store-form').elements.id.value;
  const errorNode = document.querySelector('#training-form-error');
  const cards = [...document.querySelectorAll('.training-draft')];
  errorNode.textContent = '';
  button.disabled = true;
  let savedCount = 0;
  try {
    for (const [index, draft] of trainingDraftFiles.entries()) {
      const card = cards[index];
      const value = (field) => card.querySelector(`[data-training-field="${field}"]`).value.trim();
      const totalCents = Math.round(Number(value('total').replace(',', '.')) * 100);
      if ((!value('ticketNumber') && !value('purchaseTime')) || !value('purchaseDate') || !Number.isInteger(totalCents) || totalCents <= 0) {
        throw new Error(`Completa número o hora, además de fecha e importe de ${draft.label}`);
      }
      button.textContent = `Guardando ${index + 1} de ${trainingDraftFiles.length}…`;
      const form = new FormData();
      if (draft.sourceReceiptId) form.append('sourceReceiptId', draft.sourceReceiptId);
      else form.append('image', draft.file);
      form.append('ticketNumber', value('ticketNumber'));
      form.append('purchaseDate', value('purchaseDate'));
      form.append('purchaseDateTime', value('purchaseTime') ? `${value('purchaseDate')}T${value('purchaseTime')}` : '');
      form.append('totalCents', String(totalCents));
      form.append('currency', 'EUR');
      form.append('notes', value('notes'));
      await request(`/api/admin/stores/${storeId}/training`, { method: 'POST', body: form });
      savedCount += 1;
    }
    clearTrainingDrafts();
    await loadTrainingSamples();
    showNotice(`${savedCount} ${savedCount === 1 ? 'ejemplo guardado' : 'ejemplos guardados'} correctamente.`);
  } catch (error) {
    errorNode.textContent = error instanceof Error ? error.message : 'No se pudieron guardar los ejemplos';
    if (savedCount) {
      trainingDraftFiles.slice(0, savedCount).forEach((draft) => {
        if (draft.objectUrl) URL.revokeObjectURL(draft.previewUrl);
      });
      trainingDraftFiles = trainingDraftFiles.slice(savedCount);
      renderTrainingDrafts();
      await loadTrainingSamples();
    }
  } finally {
    if (document.body.contains(button)) {
      button.disabled = false;
      button.textContent = `Guardar ${trainingDraftFiles.length} ${trainingDraftFiles.length === 1 ? 'ejemplo' : 'ejemplos'}`;
    }
  }
}

function trainingEvaluationRequest(sampleId) {
  const storeId = document.querySelector('#store-form').elements.id.value;
  const useCandidateProfile = document.querySelector('#evaluate-with-candidate-profile').checked;
  return request(`/api/admin/stores/${storeId}/training/${sampleId}/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(useCandidateProfile ? { profile: ocrProfileFormValue() } : {}),
  });
}

async function evaluateTrainingSample(sampleId) {
  if (state.trainingEvaluationRunning) return;
  state.trainingEvaluationRunning = true;
  state.trainingEvaluationSampleId = sampleId;
  document.querySelector('#training-form-error').textContent = '';
  renderTrainingSamples();
  try {
    const payload = await trainingEvaluationRequest(sampleId);
    const sample = state.trainingSamples.find((item) => item.id === sampleId);
    if (sample) sample.evaluation = payload.evaluation;
  } catch (error) {
    document.querySelector('#training-form-error').textContent = error instanceof Error ? error.message : 'No se pudo evaluar el ejemplo';
  } finally {
    state.trainingEvaluationRunning = false;
    state.trainingEvaluationSampleId = '';
    renderTrainingSamples();
  }
}

async function evaluateTrainingBatch(samples, actionLabel) {
  if (state.trainingEvaluationRunning || !samples.length) return;
  const button = document.querySelector('#evaluate-all-training');
  state.trainingEvaluationRunning = true;
  document.querySelector('#training-form-error').textContent = '';
  const totals = { passed: 0, failed: 0, errors: 0 };
  renderTrainingSamples();
  try {
    for (const [index, sample] of samples.entries()) {
      state.trainingEvaluationSampleId = sample.id;
      button.textContent = `${actionLabel} ${index + 1} de ${samples.length}…`;
      renderTrainingSamples();
      try {
        const payload = await trainingEvaluationRequest(sample.id);
        sample.evaluation = payload.evaluation;
        if (payload.evaluation?.status === 'PASSED') totals.passed += 1;
        else if (payload.evaluation?.status === 'FAILED') totals.failed += 1;
        else totals.errors += 1;
      } catch (error) {
        totals.errors += 1;
        document.querySelector('#training-form-error').textContent = error instanceof Error ? error.message : 'Una evaluación no pudo completarse';
      }
    }
    showNotice(`Evaluación completada: ${totals.passed} correctos, ${totals.failed} con diferencias y ${totals.errors} errores.`);
  } finally {
    state.trainingEvaluationRunning = false;
    state.trainingEvaluationSampleId = '';
    button.textContent = 'Evaluar todos';
    renderTrainingSamples();
  }
}

function evaluateAllTraining() {
  return evaluateTrainingBatch([...state.trainingSamples], 'Evaluando');
}

function retryFailedTraining() {
  return evaluateTrainingBatch(
    state.trainingSamples.filter((sample) => sample.evaluation?.status === 'ERROR'),
    'Reintentando',
  );
}

async function deleteTrainingSample(sampleId) {
  if (!confirm('¿Eliminar este ejemplo y todas sus evaluaciones?')) return;
  const storeId = document.querySelector('#store-form').elements.id.value;
  await request(`/api/admin/stores/${storeId}/training/${sampleId}`, { method: 'DELETE' });
  state.trainingSamples = state.trainingSamples.filter((sample) => sample.id !== sampleId);
  renderTrainingSamples();
  showNotice('Ejemplo eliminado.');
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
    const saved = await request(id ? `/api/admin/stores/${id}` : '/api/admin/stores', {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const storeId = saved.store.id;
    form.elements.id.value = storeId;
    const logo = form.elements.logo.files[0];
    if (logo) {
      submitButton.textContent = 'Optimizando logo…';
      const logoForm = new FormData();
      logoForm.append('logo', logo);
      await request(`/api/admin/stores/${storeId}/logo`, { method: 'POST', body: logoForm });
    }
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

document.querySelector('#store-form [name="logo"]').addEventListener('change', (event) => {
  const file = event.currentTarget.files[0];
  setStoreLogoPreview(file ? URL.createObjectURL(file) : '', Boolean(file));
});

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
    Array.isArray(receipt.reasons) && receipt.reasons.some((reason) =>
      ['OCR_PROCESSING_FAILED', 'OCR_VERIFICATION_REQUIRED'].includes(reason));
}

function showNotice(message) {
  const notice = document.querySelector('#admin-notice');
  notice.textContent = message;
  notice.classList.add('visible');
  setTimeout(() => notice.classList.remove('visible'), 3500);
}

function highlightSelectedRow() {
  document.querySelectorAll('.receipt-row').forEach((row) => {
    const selected = row.dataset.id === state.selected?.id;
    row.classList.toggle('selected', selected);
    if (selected) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  });
}

async function select(id, suppliedReceipt = null) {
  if (!state.stores.length) await loadFilterStores();
  let selected = suppliedReceipt || state.rows.find((row) => row.id === id);
  if (!selected) selected = (await request(`/api/admin/receipts/${encodeURIComponent(id)}`)).receipt;
  state.selected = selected;
  const receipt = state.selected;
  if (!receipt) return;
  highlightSelectedRow();
  const reprocessable = canReprocess(receipt);
  const canRevoke = receipt.status === 'REWARDED' && Boolean(receipt.reward.resultId);
  const canApproveManually = (receipt.status === 'AUTO_REJECTED' || receipt.verificationRequired) && receipt.review.status !== 'FRAUD';
  const canConfirmFraud = receipt.review.status !== 'FRAUD' && (receipt.status === 'AUTO_REJECTED' ||
    (receipt.status === 'REWARD_FAILED' && !receipt.reward.resultId));
  const reasons = Array.isArray(receipt.reasons) ? receipt.reasons : [];
  const declared = receipt.declared || {};
  const declaredStore = state.stores.find((store) => store.id === declared.storeId);
  const hasDeclaration = Boolean(declared.ticketNumber || declared.totalCents || declared.storeId);
  const activeStoreOptions = state.stores.filter((store) => store.active).map((store) =>
    `<option value="${escapeHtml(store.id)}" ${store.id === receipt.fields.storeId ? 'selected' : ''}>${escapeHtml(store.name)}</option>`).join('');
  const panel = document.querySelector('#review-panel');
  panel.className = 'review-panel';
  panel.innerHTML = `
    <div class="ticket-image-wrap">
      ${isOperator() ? '' : `<button class="image-delete-button" id="delete-ticket" type="button"
        aria-label="Eliminar ticket" title="Eliminar ticket">
        <svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="m19 6-1 14H6L5 6"></path><path d="M10 11v5M14 11v5"></path>
        </svg>
      </button>`}
      <button class="image-reprocess-button" id="reprocess-ticket" type="button"
        aria-label="Volver a comprobar el ticket" title="${reprocessable ? 'Volver a comprobar el ticket' : 'No disponible para tickets con puntos asignados o duplicados'}"
        ${reprocessable ? '' : 'disabled'}>
        <svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"></path><path d="M21 3v5h-5"></path>
        </svg>
      </button>
      <img id="ticket-image" class="review-ticket-image" tabindex="0" role="button" title="Ampliar ticket" aria-label="Ampliar ticket ${receipt.publicId}" alt="Ticket ${receipt.publicId}" />
    </div>
    <div class="review-data">
      <p class="eyebrow">${escapeHtml(receipt.publicId)}</p>
      <h2>${escapeHtml(receipt.fields.storeName || 'Sin tienda')}</h2>
      <dl><div><dt>Usuario</dt><dd>${escapeHtml(receipt.user.displayName || receipt.user.subject)}</dd></div><div class="lookup-code-field"><dt>Código de búsqueda</dt><dd>${escapeHtml(receipt.user.lookupCode || 'Histórico sin código')}</dd></div><div><dt>Número</dt><dd>${escapeHtml(receipt.fields.ticketNumber || (receipt.fields.purchaseDateTime ? 'Sin número; validado por hora' : '—'))}</dd></div><div><dt>Fecha y hora</dt><dd>${escapeHtml(formatSpanishDateTime(receipt.fields.purchaseDateTime || receipt.fields.purchaseDate))}</dd></div><div><dt>Importe</dt><dd>${formatMoney(receipt.fields.totalCents)}</dd></div><div><dt>Estado</dt><dd>${escapeHtml(receiptStatusLabel(receipt))}</dd></div></dl>
      ${hasDeclaration ? `<section class="declared-ticket-data"><strong>Datos indicados antes de fotografiar</strong><dl><div><dt>Comercio</dt><dd>${escapeHtml(declaredStore?.name || (declared.storeId ? 'Comercio ya no disponible' : 'No solicitado'))}</dd></div><div><dt>Número</dt><dd>${escapeHtml(declared.ticketNumber || '—')}</dd></div><div><dt>Total</dt><dd>${formatMoney(declared.totalCents || 0)}</dd></div></dl></section>` : ''}
      ${reasons.length ? `<div class="review-reasons"><strong>Comprobación automática</strong><ul>${reasons.map((reason) => `<li>${escapeHtml(reasonLabels[reason] || reason)}</li>`).join('')}</ul></div>` : ''}
      ${canApproveManually ? `<div class="manual-correction"><strong>Corrección manual</strong><label>Comercio<select id="manual-store"><option value="">Selecciona un comercio</option>${activeStoreOptions}</select></label><label>Número de ticket <small>o indica la hora si no existe</small><input id="manual-ticket-number" value="${escapeHtml(receipt.fields.ticketNumber)}" /></label><label>Fecha<input id="manual-purchase-date" type="date" value="${escapeHtml(receipt.fields.purchaseDate)}" /></label><label>Hora de compra<input id="manual-purchase-time" type="time" value="${escapeHtml((receipt.fields.purchaseDateTime || '').slice(11, 16))}" /></label><label>Importe (€)<input id="manual-total" type="number" min="0.01" step="0.01" value="${(receipt.fields.totalCents / 100).toFixed(2)}" /></label></div>` : ''}
      <label>Nota de revisión<textarea id="review-reason" rows="3" placeholder="${canApproveManually ? 'Obligatoria para validar manualmente' : `Opcional al marcar como revisado${canRevoke ? '; obligatoria para retirar puntos' : ''}`}"></textarea></label>
      <div class="review-actions">
        ${receipt.review.status === 'PENDING' && !canApproveManually
          ? '<button class="primary-button" id="clear-review">Revisado</button>'
          : receipt.review.status === 'CLEARED' && !canApproveManually
            ? `<span class="review-complete">Este ticket ya está resuelto.</span><button class="secondary-button reopen-review-button" id="reopen-review" type="button" aria-label="Volver a dejar pendiente" title="Volver a dejar pendiente"><svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5"></path><path d="M4 12h9a7 7 0 0 1 7 7"></path></svg></button>`
            : receipt.review.status === 'FRAUD'
              ? '<span class="review-complete">Este ticket está marcado como fraude.</span>'
              : ''}
        ${canRevoke ? '<button class="danger-button" id="revoke">Fraude: retirar puntos</button>' : ''}
        ${canConfirmFraud ? '<button class="danger-button" id="confirm-fraud">Marcar como fraude</button>' : ''}
        ${canApproveManually ? '<button class="secondary-button" id="confirm-rejection">Confirmar rechazo</button><button class="primary-button" id="manual-approve">Corregir y conceder puntos</button>' : ''}
      </div>
      <dl class="ticket-secondary-data"><div><dt>Correo</dt><dd>${escapeHtml(receipt.user.email || 'No compartido')}</dd></div><div><dt>Espacio</dt><dd>${escapeHtml(receipt.user.spaceCode || '—')}</dd></div><div><dt>Riesgo</dt><dd>${receipt.riskScore}/100</dd></div><div><dt>Puntos</dt><dd>${receipt.reward.pointsAwarded}</dd></div><div><dt>Revisión</dt><dd>${escapeHtml(reviewLabels[receipt.review.status] || receipt.review.status)}</dd></div><div><dt>OCR</dt><dd>${escapeHtml([receipt.ocrProcessing?.provider, receipt.ocrProcessing?.model].filter(Boolean).join(' · ') || '—')}</dd></div><div><dt>Proceso OCR</dt><dd>${receipt.ocrProcessing?.durationMs == null ? 'Sin resultado' : `${receipt.ocrProcessing.durationMs} ms · ${receipt.ocrProcessing.attemptCount} llamada(s)`} · ${receipt.ocrProcessing?.jobAttemptCount || 0} ejecución(es)</dd></div>${receipt.ocrProcessing?.lastError ? `<div><dt>Último error OCR</dt><dd>${escapeHtml(receipt.ocrProcessing.lastError)}</dd></div>` : ''}<div><dt>Creado</dt><dd>${escapeHtml(new Date(receipt.createdAt).toLocaleString('es-ES'))}</dd></div></dl>
    </div>`;
  const image = await fetch(`/api/admin/receipts/${id}/image`, { headers: headers() });
  if (image.ok) {
    const imageUrl = URL.createObjectURL(await image.blob());
    if (state.selected?.id === id) {
      const ticketImage = document.querySelector('#ticket-image');
      ticketImage.src = imageUrl;
      ticketImage.addEventListener('click', () => openTrainingImage(imageUrl));
      ticketImage.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openTrainingImage(imageUrl);
        }
      });
    }
    else URL.revokeObjectURL(imageUrl);
  }
  document.querySelector('#clear-review')?.addEventListener('click', () => review('CLEAR'));
  document.querySelector('#reopen-review')?.addEventListener('click', () => review('REOPEN'));
  document.querySelector('#revoke')?.addEventListener('click', () => review('REVOKE'));
  document.querySelector('#confirm-rejection')?.addEventListener('click', () => review('CONFIRM_REJECTION'));
  document.querySelector('#confirm-fraud')?.addEventListener('click', () => review('CONFIRM_FRAUD'));
  document.querySelector('#manual-approve')?.addEventListener('click', () => review('MANUAL_APPROVE'));
  document.querySelector('#delete-ticket')?.addEventListener('click', deleteSelected);
  if (reprocessable) document.querySelector('#reprocess-ticket').addEventListener('click', reprocessSelected);
}

async function deleteSelected() {
  if (state.reviewing || !state.selected) return;
  if (!confirm('Se eliminarán la imagen, el registro y su historial. Si tiene puntos concedidos, primero se anularán. ¿Continuar?')) return;
  const receiptId = state.selected.id;
  const button = document.querySelector('#delete-ticket');
  button.disabled = true;
  try {
    const result = await request(`/api/admin/receipts/${receiptId}`, { method: 'DELETE' });
    state.selected = null;
    await load();
    highlightSelectedRow();
    const panel = document.querySelector('#review-panel');
    panel.className = 'review-panel empty';
    panel.innerHTML = '<p>Selecciona un ticket para revisarlo.</p>';
    showNotice(result.pendingReversal
      ? 'Se están anulando los puntos; el ticket se eliminará al terminar.'
      : 'Ticket eliminado.');
  } catch (error) {
    button.disabled = false;
    alert(error instanceof Error ? error.message : 'No se pudo eliminar el ticket');
  }
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
  if (state.reviewing || !state.selected) return;
  const reason = document.querySelector('#review-reason').value.trim();
  if (action === 'MANUAL_APPROVE' && !reason) return alert('Indica el motivo de la validación manual.');
  if (action === 'MANUAL_APPROVE' && !confirm('Se guardarán las correcciones y se concederán los puntos. ¿Continuar?')) return;
  if (action === 'CONFIRM_REJECTION' && !confirm('El ticket permanecerá rechazado y no se concederán puntos. ¿Continuar?')) return;
  if (action === 'CONFIRM_FRAUD' && !reason) return alert('Indica el motivo del fraude.');
  if (action === 'CONFIRM_FRAUD' && !confirm('Se registrará una infracción por fraude para este usuario. ¿Continuar?')) return;
  if (action === 'REVOKE' && !reason) return alert('Indica el motivo de la revocación.');
  if (action === 'REVOKE' && !confirm('Se retirarán los puntos concedidos. ¿Continuar?')) return;
  state.reviewing = true;
  const buttons = [...document.querySelectorAll('.review-actions button')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await request(`/api/admin/receipts/${state.selected.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action, reason,
        ...(action === 'MANUAL_APPROVE' ? { fields: {
          storeId: document.querySelector('#manual-store').value,
          ticketNumber: document.querySelector('#manual-ticket-number').value,
          purchaseDate: document.querySelector('#manual-purchase-date').value,
          purchaseTime: document.querySelector('#manual-purchase-time').value,
          totalCents: Math.round(Number(document.querySelector('#manual-total').value) * 100),
          currency: 'EUR',
        } } : {}),
      }),
    });
    await load();
    state.selected = null;
    highlightSelectedRow();
    const panel = document.querySelector('#review-panel');
    panel.className = 'review-panel empty';
    panel.innerHTML = '<p>Selecciona un ticket para revisarlo.</p>';
    showNotice(action === 'MANUAL_APPROVE'
      ? 'Ticket validado manualmente; se están asignando los puntos.'
      : action === 'CONFIRM_REJECTION'
        ? 'Rechazo confirmado; no se concederán puntos.'
      : action === 'CONFIRM_FRAUD'
        ? 'Fraude confirmado e infracción registrada.'
      : action === 'CLEAR'
        ? 'Ticket marcado como revisado.'
        : action === 'REOPEN'
          ? 'Ticket devuelto a pendientes.'
          : 'Fraude registrado; se están retirando los puntos.');
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    alert(error instanceof Error ? error.message : 'No se pudo completar la revisión');
  } finally {
    state.reviewing = false;
  }
}

document.addEventListener('keydown', (event) => {
  const target = event.target;
  const editing = target instanceof HTMLElement && Boolean(target.closest('input, textarea, select'));
  const unrelatedButton = target instanceof HTMLElement && Boolean(target.closest('button:not(.receipt-row)'));
  if (editing || unrelatedButton || document.querySelector('dialog[open]')) return;

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const rows = [...document.querySelectorAll('.receipt-row')];
    if (!rows.length) return;
    event.preventDefault();
    const currentIndex = rows.findIndex((row) => row.dataset.id === state.selected?.id);
    const nextIndex = event.key === 'ArrowDown'
      ? Math.min(rows.length - 1, currentIndex < 0 ? 0 : currentIndex + 1)
      : Math.max(0, currentIndex < 0 ? rows.length - 1 : currentIndex - 1);
    const row = rows[nextIndex];
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'nearest' });
    select(row.dataset.id).catch((error) => alert(error.message));
    return;
  }

  if ((event.key === 'Enter' || event.key === ' ') && state.selected?.review.status === 'PENDING') {
    event.preventDefault();
    review('CLEAR');
  }
});

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
  const filters = event.currentTarget;
  const search = filters.elements.user.value.trim();
  if (/^TKT-[A-Z0-9_-]+$/i.test(search)) {
    filters.reset();
    filters.elements.user.value = search.toUpperCase();
    document.querySelector('[name="attention"]').checked = false;
  }
  if (document.querySelector('#filters-dialog').open) document.querySelector('#filters-dialog').close();
  updateFilterCount();
  load(1).catch((error) => alert(error.message));
});
document.querySelector('#open-filters').addEventListener('click', () => document.querySelector('#filters-dialog').showModal());
document.querySelector('#close-filters-dialog').addEventListener('click', () => document.querySelector('#filters-dialog').close());
document.querySelector('#clear-filters').addEventListener('click', () => {
  document.querySelector('#filters').reset();
  document.querySelector('[name="attention"]').checked = false;
  updateFilterCount();
  document.querySelector('#filters-dialog').close();
  load(1).catch((error) => alert(error.message));
});
document.querySelector('#previous-page').addEventListener('click', () => {
  if (state.pagination.hasPrevious) load(state.pagination.page - 1).catch((error) => alert(error.message));
});
document.querySelector('#next-page').addEventListener('click', () => {
  if (state.pagination.hasNext) load(state.pagination.page + 1).catch((error) => alert(error.message));
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
  if (view === 'users') await loadTicketUsers(1).catch((error) => alert(error.message));
  if (view === 'settings') {
    const loaders = [loadSettings()];
    if (!isOperator()) loaders.push(loadAdminUsers());
    await Promise.all(loaders).catch((error) => alert(error.message));
  }
}));
document.querySelector('#new-store').addEventListener('click', () => openStoreDialog());
document.querySelector('#ticket-user-search').addEventListener('submit', (event) => {
  event.preventDefault();
  document.querySelector('#ticket-user-filters-dialog').close();
  updateTicketUserFilterCount();
  loadTicketUsers(1).catch((error) => alert(error.message));
});
function updateTicketUserFilterCount() {
  const params = ticketUserParams(1);
  params.delete('q');
  params.delete('page');
  const count = [...params].length;
  const badge = document.querySelector('#ticket-user-filter-count');
  badge.textContent = count;
  badge.hidden = count === 0;
}
document.querySelector('#open-ticket-user-filters').addEventListener('click', () => document.querySelector('#ticket-user-filters-dialog').showModal());
document.querySelector('#close-ticket-user-filters').addEventListener('click', () => document.querySelector('#ticket-user-filters-dialog').close());
document.querySelector('#clear-ticket-user-filters').addEventListener('click', () => {
  document.querySelector('#ticket-user-search').reset();
  updateTicketUserFilterCount();
  document.querySelector('#ticket-user-filters-dialog').close();
  loadTicketUsers(1).catch((error) => alert(error.message));
});
document.querySelector('#export-ticket-users').addEventListener('click', exportTicketUsers);
document.querySelector('#previous-ticket-users').addEventListener('click', () => {
  if (state.ticketUserPagination.hasPrevious) loadTicketUsers(state.ticketUserPagination.page - 1).catch((error) => alert(error.message));
});
document.querySelector('#next-ticket-users').addEventListener('click', () => {
  if (state.ticketUserPagination.hasNext) loadTicketUsers(state.ticketUserPagination.page + 1).catch((error) => alert(error.message));
});
document.querySelector('#close-ticket-user-detail').addEventListener('click', () => document.querySelector('#ticket-user-detail-dialog').close());
document.querySelector('#store-form').addEventListener('submit', saveStore);
document.querySelectorAll('[data-store-panel]').forEach((button) => button.addEventListener('click', async () => {
  if (button.disabled) return;
  setStorePanel(button.dataset.storePanel);
  if (button.dataset.storePanel === 'training') {
    await loadTrainingSamples().catch((error) => {
      document.querySelector('#training-form-error').textContent = error.message;
    });
  }
}));
document.querySelector('#training-files').addEventListener('change', (event) => {
  const selected = [...event.currentTarget.files].slice(0, Math.max(0, 20 - trainingDraftFiles.length));
  trainingDraftFiles.push(...selected.map((file) => ({
    file,
    previewUrl: URL.createObjectURL(file),
    objectUrl: true,
    label: file.name,
    values: { ticketNumber: '', purchaseDate: '', purchaseTime: '', total: '', notes: '' },
  })));
  event.currentTarget.value = '';
  renderTrainingDrafts();
});
document.querySelector('#open-training-receipts').addEventListener('click', openTrainingReceiptCandidates);
document.querySelector('#close-training-receipts').addEventListener('click', () => document.querySelector('#training-receipts-dialog').close());
document.querySelector('#training-receipts-search').addEventListener('submit', async (event) => {
  event.preventDefault();
  trainingReceiptPicker.query = String(new FormData(event.currentTarget).get('query') || '').trim();
  await loadTrainingReceiptCandidates(1).catch((error) => {
    document.querySelector('#training-receipts-feedback').textContent = error.message;
  });
});
document.querySelector('#training-receipts-previous').addEventListener('click', () => {
  if (trainingReceiptPicker.pagination.hasPrevious) loadTrainingReceiptCandidates(trainingReceiptPicker.page - 1).catch((error) => {
    document.querySelector('#training-receipts-feedback').textContent = error.message;
  });
});
document.querySelector('#training-receipts-next').addEventListener('click', () => {
  if (trainingReceiptPicker.pagination.hasNext) loadTrainingReceiptCandidates(trainingReceiptPicker.page + 1).catch((error) => {
    document.querySelector('#training-receipts-feedback').textContent = error.message;
  });
});
document.querySelector('#close-training-image').addEventListener('click', () => document.querySelector('#training-image-dialog').close());
document.querySelector('#training-image-dialog').addEventListener('close', () => {
  document.querySelector('#training-image-expanded').removeAttribute('src');
});
document.querySelector('#evaluate-all-training').addEventListener('click', evaluateAllTraining);
document.querySelector('#evaluate-failed-training').addEventListener('click', retryFailedTraining);
document.querySelector('#generate-ocr-profile').addEventListener('click', generateOcrProfile);
document.querySelector('#save-ocr-profile').addEventListener('click', saveOcrProfile);
document.querySelector('#ocr-profile-enabled').addEventListener('change', updateOcrProfileStatus);
closeDialogOnBackdrop(document.querySelector('#store-dialog'), clearTrainingDrafts);
closeDialogOnBackdrop(document.querySelector('#training-receipts-dialog'));
closeDialogOnBackdrop(document.querySelector('#training-image-dialog'));
closeDialogOnBackdrop(document.querySelector('#ticket-user-filters-dialog'));
closeDialogOnBackdrop(document.querySelector('#ticket-user-detail-dialog'));
document.querySelector('#close-store-dialog').addEventListener('click', () => {
  clearTrainingDrafts();
  document.querySelector('#store-dialog').close();
});
document.querySelector('#cancel-store').addEventListener('click', () => {
  clearTrainingDrafts();
  document.querySelector('#store-dialog').close();
});
document.querySelector('#new-tier').addEventListener('click', () => openTierDialog());
document.querySelector('#tier-form').addEventListener('submit', saveTier);
document.querySelector('#close-tier-dialog').addEventListener('click', () => document.querySelector('#tier-dialog').close());
document.querySelector('#cancel-tier').addEventListener('click', () => document.querySelector('#tier-dialog').close());
document.querySelector('#setting-select').addEventListener('change', renderSettingEditor);
document.querySelector('#setting-plain-value').addEventListener('input', updateSettingPreview);
document.querySelector('#setting-rich-value').addEventListener('input', updateSettingPreview);
document.querySelector('#setting-form').addEventListener('submit', saveSetting);
document.querySelector('#participation-limits-form').addEventListener('submit', saveParticipationLimits);
document.querySelector('#scan-flow-settings-form').addEventListener('submit', saveScanFlowSettings);
document.querySelector('#assisted-scan-enabled').addEventListener('change', (event) => {
  document.querySelector('#assisted-scan-require-store').disabled = !event.currentTarget.checked;
});
document.querySelector('#validation-period-form').addEventListener('submit', saveValidationPeriod);
document.querySelector('#admin-user-form').addEventListener('submit', saveAdminUser);
document.querySelector('[name="review"]').value = 'PENDING';
updateFilterCount();
async function initializeBackoffice() {
  await loadAdminSession();
  await Promise.all([load(1), loadFilterStores(), loadSpaces()]);
}
initializeBackoffice().catch((error) => alert(error.message));
