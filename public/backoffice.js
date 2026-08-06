const state = {
  rows: [], stores: [], tiers: [], settings: [], trainingSamples: [], selected: null,
  pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1, hasPrevious: false, hasNext: false },
  reviewing: false,
  token: sessionStorage.getItem('admin-token') || '',
};
let storeLogoPreviewObjectUrl = '';
let trainingDraftFiles = [];
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
const reasonLabels = {
  OCR_PROCESSING_FAILED: 'La lectura automática ha fallado y necesita revisión.',
  OCR_VERIFICATION_REQUIRED: 'El OCR no ha podido verificar todos los datos. No se ha rechazado automáticamente.',
  OCR_MISSING_TICKET_NUMBER: 'Falta el número de ticket.',
  OCR_UNVERIFIED_TICKET_NUMBER: 'El número no coincide con su evidencia visible.',
  OCR_MISSING_DATE: 'Falta la fecha de compra.',
  OCR_UNVERIFIED_DATE: 'La fecha no coincide con su evidencia visible.',
  OCR_MISSING_TOTAL: 'Falta el importe total.',
  OCR_UNVERIFIED_TOTAL: 'El importe no coincide con su evidencia visible.',
  NOT_A_RECEIPT: 'La imagen no parece un ticket de compra.',
  DUPLICATE: 'El ticket ya había sido utilizado.',
  DUPLICATE_IMAGE: 'La misma imagen ya había sido enviada.',
  STORE_NOT_ALLOWED: 'El comercio no está autorizado.',
  TICKET_NUMBER_REQUIRED: 'No se ha reconocido el número del ticket.',
  INVALID_TOTAL: 'El importe no es válido.',
  INVALID_DATE: 'No se ha reconocido una fecha válida.',
  FUTURE_DATE: 'La fecha está fuera del periodo permitido.',
  TICKET_TOO_OLD: 'La fecha del ticket supera el periodo permitido.',
  OCR_REPROCESS_REQUESTED: 'La nueva comprobación está en curso.',
};

function receiptStatusLabel(receipt) {
  if (receipt.verificationRequired) return 'Lectura pendiente de revisión';
  return statusLabels[receipt.status] || receipt.status;
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

function filterParams() {
  const params = new URLSearchParams(new FormData(document.querySelector('#filters')));
  for (const [key, value] of [...params]) if (!value) params.delete(key);
  return params;
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
      <span><strong>${escapeHtml(receipt.publicId)}</strong><small>${escapeHtml(receipt.fields.storeName || 'Sin tienda')}</small></span>
      <span><strong>${formatMoney(receipt.fields.totalCents)}</strong><small>${receipt.reward.pointsAwarded} puntos</small></span>
      <span class="status-chip ${escapeHtml(receipt.status.toLowerCase())}">${escapeHtml(receiptStatusLabel(receipt))} · ${escapeHtml(reviewLabels[receipt.review.status] || receipt.review.status)}</span>
    </button>`).join('') || '<p class="empty-state">No hay registros con estos filtros.</p>';
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
  if (setting.format === 'datetime') return document.querySelector('#setting-datetime-value').value;
  return document.querySelector('#setting-plain-value').value;
}

function updateSettingPreview() {
  const setting = selectedSetting();
  if (!setting) return;
  const preview = document.querySelector('#setting-preview-content');
  const value = settingEditorValue(setting);
  if (setting.format === 'rich') renderSettingFormattedText(preview, value);
  else if (setting.format === 'datetime') preview.textContent = value ? value.replace('T', ' · ') : 'Sin límite';
  else preview.textContent = value;
}

function renderSettingEditor() {
  const setting = selectedSetting();
  if (!setting) return;
  const plainField = document.querySelector('#setting-plain-field');
  const richField = document.querySelector('#setting-rich-field');
  const datetimeField = document.querySelector('#setting-datetime-field');
  const plainInput = document.querySelector('#setting-plain-value');
  const richInput = document.querySelector('#setting-rich-value');
  const datetimeInput = document.querySelector('#setting-datetime-value');
  plainField.hidden = setting.format !== 'plain';
  richField.hidden = setting.format !== 'rich';
  datetimeField.hidden = setting.format !== 'datetime';
  plainInput.value = setting.format === 'plain' ? setting.value : '';
  richInput.value = setting.format === 'rich' ? setting.value : '';
  datetimeInput.value = setting.format === 'datetime' ? setting.value : '';
  plainInput.maxLength = setting.maxLength;
  richInput.maxLength = setting.maxLength;
  document.querySelector('#setting-help').textContent = setting.help;
  document.querySelector('#setting-form-error').textContent = '';
  updateSettingPreview();
}

async function loadSettings() {
  const payload = await request('/api/admin/settings');
  state.settings = payload.settings;
  document.querySelector('#manager-email').textContent = payload.manager || '';
  const select = document.querySelector('#setting-select');
  const previous = select.value;
  const groups = new Map();
  for (const setting of state.settings) {
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
  if (state.settings.some((setting) => setting.key === previous)) select.value = previous;
  renderSettingEditor();
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
  document.querySelector('#training-samples').replaceChildren();
  document.querySelector('#training-summary').replaceChildren();
  document.querySelector('#training-tab-count').textContent = '0';
  document.querySelector('#store-training-tab').disabled = !store;
  setStorePanel('details');
  document.querySelector('#store-dialog-title').textContent = store ? 'Editar comercio' : 'Añadir comercio';
  document.querySelector('#store-form-error').textContent = '';
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
  trainingDraftFiles.forEach((draft) => URL.revokeObjectURL(draft.previewUrl));
  trainingDraftFiles = [];
  document.querySelector('#training-files').value = '';
  document.querySelector('#training-drafts').replaceChildren();
  document.querySelector('#training-form-error').textContent = '';
}

function trainingEvaluationDetails(evaluation) {
  if (!evaluation) return '<span class="training-not-evaluated">Sin evaluar</span>';
  if (evaluation.status === 'ERROR') {
    return `<span class="status-chip auto_rejected">Error técnico</span><small>${escapeHtml(evaluation.errorMessage || 'No se pudo ejecutar el OCR')}</small>`;
  }
  const labels = {
    store: 'Comercio', ticketNumber: 'Número', purchaseDate: 'Fecha', total: 'Importe', evidence: 'Evidencias',
  };
  const fields = Object.entries(labels).map(([key, label]) =>
    `<span class="training-match ${evaluation.matches?.[key] ? 'passed' : 'failed'}">${evaluation.matches?.[key] ? '✓' : '×'} ${label}</span>`).join('');
  return `<div class="training-evaluation-heading"><span class="status-chip ${evaluation.status === 'PASSED' ? 'rewarded' : 'auto_rejected'}">${evaluation.status === 'PASSED' ? 'Correcto' : 'Con diferencias'}</span><small>${escapeHtml(evaluation.model)} · ${evaluation.durationMs ?? '—'} ms</small></div><div class="training-matches">${fields}</div>`;
}

function renderTrainingSamples() {
  const passed = state.trainingSamples.filter((sample) => sample.evaluation?.status === 'PASSED').length;
  const evaluated = state.trainingSamples.filter((sample) => sample.evaluation).length;
  document.querySelector('#training-tab-count').textContent = String(state.trainingSamples.length);
  document.querySelector('#training-summary').innerHTML = state.trainingSamples.length
    ? `<strong>${state.trainingSamples.length} ejemplos</strong><span>${evaluated} evaluados · ${passed} completamente correctos</span>`
    : '';
  document.querySelector('#evaluate-all-training').disabled = !state.trainingSamples.length;
  document.querySelector('#training-samples').innerHTML = state.trainingSamples.map((sample) => `
    <article class="training-sample" data-id="${escapeHtml(sample.id)}">
      <img src="${escapeHtml(sample.imageUrl)}" alt="Ticket de entrenamiento" loading="lazy" />
      <div class="training-ground-truth">
        <strong>${escapeHtml(sample.expected.ticketNumber)}</strong>
        <span>${escapeHtml(sample.expected.purchaseDate)} · ${formatMoney(sample.expected.totalCents)}</span>
        ${sample.notes ? `<small>${escapeHtml(sample.notes)}</small>` : ''}
        ${trainingEvaluationDetails(sample.evaluation)}
      </div>
      <div class="training-actions">
        <button class="secondary-button evaluate-training" type="button" data-id="${escapeHtml(sample.id)}">Evaluar</button>
        <button class="text-button delete-training" type="button" data-id="${escapeHtml(sample.id)}">Eliminar</button>
      </div>
    </article>`).join('') || '<p class="empty-state">Todavía no hay tickets de entrenamiento para este comercio.</p>';
  document.querySelectorAll('.evaluate-training').forEach((button) => button.addEventListener('click', () => evaluateTrainingSample(button.dataset.id, button)));
  document.querySelectorAll('.delete-training').forEach((button) => button.addEventListener('click', () => deleteTrainingSample(button.dataset.id)));
}

async function loadTrainingSamples() {
  const storeId = document.querySelector('#store-form').elements.id.value;
  if (!storeId) return;
  const payload = await request(`/api/admin/stores/${storeId}/training`);
  state.trainingSamples = payload.samples;
  renderTrainingSamples();
}

function renderTrainingDrafts() {
  document.querySelector('#training-drafts').innerHTML = trainingDraftFiles.map((draft, index) => `
    <article class="training-draft" data-index="${index}">
      <img src="${escapeHtml(draft.previewUrl)}" alt="Vista previa de ${escapeHtml(draft.file.name)}" />
      <div class="training-draft-fields">
        <strong>${escapeHtml(draft.file.name)}</strong>
        <label>Número del ticket<input data-training-field="ticketNumber" maxlength="160" placeholder="Número exacto impreso" /></label>
        <label>Fecha<input data-training-field="purchaseDate" type="date" /></label>
        <label>Importe total (€)<input data-training-field="total" inputmode="decimal" placeholder="15,92" /></label>
        <label class="training-notes-field">Notas<input data-training-field="notes" maxlength="1000" placeholder="Caja, formato o particularidades" /></label>
      </div>
      <button class="icon-button remove-training-draft" type="button" data-index="${index}" aria-label="Quitar ejemplo">×</button>
    </article>`).join('') + (trainingDraftFiles.length
    ? `<div class="training-save-row"><button class="primary-button" id="save-training-drafts" type="button">Guardar ${trainingDraftFiles.length} ${trainingDraftFiles.length === 1 ? 'ejemplo' : 'ejemplos'}</button></div>` : '');
  document.querySelectorAll('.remove-training-draft').forEach((button) => button.addEventListener('click', () => {
    const [removed] = trainingDraftFiles.splice(Number(button.dataset.index), 1);
    if (removed) URL.revokeObjectURL(removed.previewUrl);
    renderTrainingDrafts();
  }));
  document.querySelector('#save-training-drafts')?.addEventListener('click', saveTrainingDrafts);
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
      if (!value('ticketNumber') || !value('purchaseDate') || !Number.isInteger(totalCents) || totalCents <= 0) {
        throw new Error(`Completa número, fecha e importe de ${draft.file.name}`);
      }
      button.textContent = `Guardando ${index + 1} de ${trainingDraftFiles.length}…`;
      const form = new FormData();
      form.append('image', draft.file);
      form.append('ticketNumber', value('ticketNumber'));
      form.append('purchaseDate', value('purchaseDate'));
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
      trainingDraftFiles.slice(0, savedCount).forEach((draft) => URL.revokeObjectURL(draft.previewUrl));
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

async function evaluateTrainingSample(sampleId, button) {
  const storeId = document.querySelector('#store-form').elements.id.value;
  button.disabled = true;
  button.textContent = 'Evaluando…';
  try {
    const payload = await request(`/api/admin/stores/${storeId}/training/${sampleId}/evaluate`, { method: 'POST' });
    const sample = state.trainingSamples.find((item) => item.id === sampleId);
    if (sample) sample.evaluation = payload.evaluation;
    renderTrainingSamples();
  } catch (error) {
    document.querySelector('#training-form-error').textContent = error instanceof Error ? error.message : 'No se pudo evaluar el ejemplo';
    button.disabled = false;
    button.textContent = 'Evaluar';
  }
}

async function evaluateAllTraining() {
  const button = document.querySelector('#evaluate-all-training');
  button.disabled = true;
  document.querySelector('#training-form-error').textContent = '';
  try {
    for (const [index, sample] of state.trainingSamples.entries()) {
      button.textContent = `Evaluando ${index + 1} de ${state.trainingSamples.length}…`;
      const storeId = document.querySelector('#store-form').elements.id.value;
      const payload = await request(`/api/admin/stores/${storeId}/training/${sample.id}/evaluate`, { method: 'POST' });
      sample.evaluation = payload.evaluation;
      renderTrainingSamples();
    }
    showNotice('Evaluación del comercio completada.');
  } catch (error) {
    document.querySelector('#training-form-error').textContent = error instanceof Error ? error.message : 'No se pudo completar la evaluación';
  } finally {
    button.disabled = false;
    button.textContent = 'Evaluar todos';
  }
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
  state.selected = suppliedReceipt || state.rows.find((row) => row.id === id);
  const receipt = state.selected;
  if (!receipt) return;
  highlightSelectedRow();
  const reprocessable = canReprocess(receipt);
  const canRevoke = receipt.status === 'REWARDED' && Boolean(receipt.reward.resultId);
  const canApproveManually = receipt.status === 'AUTO_REJECTED' || receipt.verificationRequired;
  const reasons = Array.isArray(receipt.reasons) ? receipt.reasons : [];
  const activeStoreOptions = state.stores.filter((store) => store.active).map((store) =>
    `<option value="${escapeHtml(store.id)}" ${store.id === receipt.fields.storeId ? 'selected' : ''}>${escapeHtml(store.name)}</option>`).join('');
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
      <dl><div><dt>Usuario</dt><dd>${escapeHtml(receipt.user.displayName || receipt.user.subject)}</dd></div><div><dt>Correo</dt><dd>${escapeHtml(receipt.user.email || 'No compartido')}</dd></div><div><dt>Número</dt><dd>${escapeHtml(receipt.fields.ticketNumber || '—')}</dd></div><div><dt>Fecha</dt><dd>${escapeHtml(receipt.fields.purchaseDate || '—')}</dd></div><div><dt>Importe</dt><dd>${formatMoney(receipt.fields.totalCents)}</dd></div><div><dt>Riesgo</dt><dd>${receipt.riskScore}/100</dd></div><div><dt>Puntos</dt><dd>${receipt.reward.pointsAwarded}</dd></div><div><dt>Estado</dt><dd>${escapeHtml(receiptStatusLabel(receipt))}</dd></div><div><dt>Revisión</dt><dd>${escapeHtml(reviewLabels[receipt.review.status] || receipt.review.status)}</dd></div><div><dt>OCR</dt><dd>${escapeHtml(receipt.ocrProcessing?.model || '—')}</dd></div><div><dt>Proceso OCR</dt><dd>${receipt.ocrProcessing?.durationMs == null ? '—' : `${receipt.ocrProcessing.durationMs} ms · ${receipt.ocrProcessing.attemptCount} intento(s)`}</dd></div></dl>
      ${reasons.length ? `<div class="review-reasons"><strong>Comprobación automática</strong><ul>${reasons.map((reason) => `<li>${escapeHtml(reasonLabels[reason] || reason)}</li>`).join('')}</ul></div>` : ''}
      ${canApproveManually ? `<div class="manual-correction"><strong>Corrección manual</strong><label>Comercio<select id="manual-store"><option value="">Selecciona un comercio</option>${activeStoreOptions}</select></label><label>Número de ticket<input id="manual-ticket-number" value="${escapeHtml(receipt.fields.ticketNumber)}" /></label><label>Fecha<input id="manual-purchase-date" type="date" value="${escapeHtml(receipt.fields.purchaseDate)}" /></label><label>Importe (€)<input id="manual-total" type="number" min="0.01" step="0.01" value="${(receipt.fields.totalCents / 100).toFixed(2)}" /></label></div>` : ''}
      <label>Nota de revisión<textarea id="review-reason" rows="3" placeholder="${canApproveManually ? 'Obligatoria para validar manualmente' : `Opcional al marcar como revisado${canRevoke ? '; obligatoria para retirar puntos' : ''}`}"></textarea></label>
      <div class="review-actions">
        ${receipt.review.status === 'PENDING'
          ? '<button class="primary-button" id="clear-review">Revisado</button>'
          : receipt.review.status === 'CLEARED'
            ? `<span class="review-complete">Este ticket ya está resuelto.</span><button class="secondary-button reopen-review-button" id="reopen-review" type="button" aria-label="Volver a dejar pendiente" title="Volver a dejar pendiente"><svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5"></path><path d="M4 12h9a7 7 0 0 1 7 7"></path></svg></button>`
            : '<span class="review-complete">Este ticket está marcado como fraude.</span>'}
        ${canRevoke ? '<button class="danger-button" id="revoke">Fraude: retirar puntos</button>' : ''}
        ${canApproveManually ? '<button class="primary-button" id="manual-approve">Validar manualmente</button>' : ''}
      </div>
    </div>`;
  const image = await fetch(`/api/admin/receipts/${id}/image`, { headers: headers() });
  if (image.ok) {
    const imageUrl = URL.createObjectURL(await image.blob());
    if (state.selected?.id === id) document.querySelector('#ticket-image').src = imageUrl;
    else URL.revokeObjectURL(imageUrl);
  }
  document.querySelector('#clear-review')?.addEventListener('click', () => review('CLEAR'));
  document.querySelector('#reopen-review')?.addEventListener('click', () => review('REOPEN'));
  document.querySelector('#revoke')?.addEventListener('click', () => review('REVOKE'));
  document.querySelector('#manual-approve')?.addEventListener('click', () => review('MANUAL_APPROVE'));
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
  if (state.reviewing || !state.selected) return;
  const reason = document.querySelector('#review-reason').value.trim();
  if (action === 'MANUAL_APPROVE' && !reason) return alert('Indica el motivo de la validación manual.');
  if (action === 'MANUAL_APPROVE' && !confirm('Se validará el ticket y se asignarán los puntos. ¿Continuar?')) return;
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
  if (view === 'settings') await loadSettings().catch((error) => alert(error.message));
}));
document.querySelector('#new-store').addEventListener('click', () => openStoreDialog());
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
  trainingDraftFiles.push(...selected.map((file) => ({ file, previewUrl: URL.createObjectURL(file) })));
  event.currentTarget.value = '';
  renderTrainingDrafts();
});
document.querySelector('#evaluate-all-training').addEventListener('click', evaluateAllTraining);
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
document.querySelector('#setting-datetime-value').addEventListener('input', updateSettingPreview);
document.querySelector('#setting-form').addEventListener('submit', saveSetting);
document.querySelector('[name="review"]').value = 'PENDING';
updateFilterCount();
load(1).catch((error) => alert(error.message));
loadFilterStores().catch((error) => alert(error.message));
