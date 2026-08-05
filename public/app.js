const screens = new Map(
  [...document.querySelectorAll('[data-screen]')].map((node) => [node.dataset.screen, node]),
);
const state = {
  sessionToken: sessionStorage.getItem('ticket-session') || '',
  parentOrigin: sessionStorage.getItem('ticket-parent-origin') || '',
  receiptId: '',
  receipt: null,
  stores: [],
};

function show(name) {
  for (const [screenName, node] of screens) node.classList.toggle('active', screenName === name);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${state.sessionToken}`, ...extra };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: authHeaders(options.headers || {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'No se pudo completar la operación');
  return payload;
}

async function responsePayload(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: response.ok
      ? 'El servidor devolvió una respuesta no válida'
      : 'No se pudo completar la operación' };
  }
}

async function bootstrap() {
  const params = new URLSearchParams(location.search);
  const preview = location.hostname === 'localhost' ? params.get('preview') : '';
  if (preview && screens.has(preview)) {
    if (preview === 'final') {
      document.querySelector('#points-awarded').textContent = '50';
      document.querySelector('#receipt-reference').textContent = 'TKT-DEMO';
    }
    show(preview);
    return;
  }
  const launchCode = params.get('launch_code');
  state.parentOrigin = params.get('parent_origin') || '';
  if (launchCode) {
    state.sessionToken = '';
    sessionStorage.removeItem('ticket-session');
    const payload = await fetch('/api/session/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ launchCode, parentOrigin: state.parentOrigin }),
    }).then(async (response) => {
      const value = await responsePayload(response);
      if (!response.ok) {
        throw Object.assign(new Error(value.error || 'No se pudo iniciar la sesión'), {
          status: response.status,
          code: value.code || 'RTALES_EXCHANGE_FAILED',
        });
      }
      return value;
    });
    state.sessionToken = payload.sessionToken;
    state.parentOrigin = payload.parentOrigin || state.parentOrigin;
    sessionStorage.setItem('ticket-session', state.sessionToken);
    if (state.parentOrigin) sessionStorage.setItem('ticket-parent-origin', state.parentOrigin);
    history.replaceState({}, '', location.pathname);
  }
  if (!state.sessionToken) throw new Error('Abre este módulo desde Rtales para comenzar');
  const stores = await api('/api/stores');
  state.stores = stores.stores;
  const select = document.querySelector('#store-select');
  select.innerHTML = '<option value="">Selecciona una tienda</option>' + state.stores
    .map((store) => `<option value="${store.id}">${escapeHtml(store.name)}</option>`).join('');
  show('welcome');
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value || '');
  return node.innerHTML;
}

async function optimizeTicketFile(file) {
  if (!('createImageBitmap' in window)) return file;
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 2000 / bitmap.width, 3200 / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return file;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.84));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], 'ticket-optimizado.webp', {
      type: 'image/webp',
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
}

async function upload(file) {
  show('processing');
  const optimizedFile = await optimizeTicketFile(file).catch(() => file);
  const form = new FormData();
  form.append('ticket', optimizedFile);
  const payload = await api('/api/receipts', { method: 'POST', body: form });
  state.receiptId = payload.receiptId;
  if (payload.status === 'DUPLICATE') return show('duplicate');
  await pollUntilReady();
}

async function pollUntilReady() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const payload = await api(`/api/receipts/${state.receiptId}`);
    state.receipt = payload.receipt;
    if (payload.receipt.status === 'READY_FOR_CONFIRMATION') {
      fillForm(payload.receipt);
      return show('form');
    }
    if (payload.receipt.status === 'NOT_A_RECEIPT') return show('not-receipt');
    if (payload.receipt.status === 'DUPLICATE') return show('duplicate');
    if (payload.receipt.status === 'REWARDED') return finish(payload.receipt);
    if (
      payload.receipt.status === 'OCR_FAILED' ||
      (payload.receipt.status === 'REWARD_FAILED' &&
        payload.receipt.reasons?.includes('OCR_PROCESSING_FAILED'))
    ) {
      throw new Error('No hemos podido leer este ticket. Comprueba la imagen y vuelve a intentarlo.');
    }
    if (['AUTO_REJECTED', 'REWARD_FAILED'].includes(payload.receipt.status)) {
      throw new Error('El ticket no ha superado la validación automática');
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error('La lectura está tardando más de lo esperado. Inténtalo de nuevo.');
}

function fillForm(receipt) {
  const form = document.querySelector('#receipt-form');
  const fields = receipt.fields;
  form.elements.storeId.value = fields.storeId || matchStore(fields.storeName)?.id || '';
  form.elements.ticketNumber.value = fields.ticketNumber || '';
  form.elements.purchaseDate.value = fields.purchaseDate || '';
  form.elements.total.value = fields.totalCents ? (fields.totalCents / 100).toFixed(2) : '';
}

function matchStore(name) {
  const normalized = String(name || '').toLocaleLowerCase('es').trim();
  if (!normalized) return null;
  return state.stores.find((store) => [store.name, ...(store.aliases || [])].some((candidate) => {
    const comparable = String(candidate).toLocaleLowerCase('es').trim();
    return comparable.includes(normalized) || normalized.includes(comparable);
  }));
}

async function confirmReceipt(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const store = state.stores.find((item) => item.id === form.get('storeId'));
  const totalCents = Math.round(Number(String(form.get('total')).replace(',', '.')) * 100);
  if (!store || !Number.isInteger(totalCents) || totalCents <= 0) return;
  show('reward-processing');
  const payload = await api(`/api/receipts/${state.receiptId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storeId: store.id,
      storeName: store.name,
      ticketNumber: form.get('ticketNumber'),
      purchaseDate: form.get('purchaseDate'),
      totalCents,
      currency: 'EUR',
    }),
  });
  if (payload.status === 'DUPLICATE') return show('duplicate');
  if (payload.status === 'AUTO_REJECTED') {
    throw new Error('El ticket no ha superado la validación automática');
  }
  await pollUntilReady();
}

function finish(receipt) {
  document.querySelector('#points-awarded').textContent = receipt.reward.pointsAwarded;
  document.querySelector('#receipt-reference').textContent = receipt.publicId;
  show('final');
  if (state.parentOrigin && window.parent !== window) {
    window.parent.postMessage({
      type: 'EXTERNAL_GAME_COMPLETED',
      rewards: { pointsAwarded: receipt.reward.pointsAwarded, cards: [] },
    }, state.parentOrigin);
  }
}

function retry() {
  state.receiptId = '';
  state.receipt = null;
  document.querySelector('#ticket-input').value = '';
  show(state.sessionToken ? 'welcome' : 'connection-error');
}

function closeGame() {
  if (state.parentOrigin && window.parent !== window) {
    window.parent.postMessage({ type: 'EXTERNAL_GAME_CLOSE' }, state.parentOrigin);
    return;
  }
  location.reload();
}

function retryConnection() {
  show('connecting');
  bootstrap().catch(showError);
}

document.querySelector('#ticket-input').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (file) upload(file).catch(showError);
});
document.querySelector('#receipt-form').addEventListener('submit', (event) => {
  confirmReceipt(event).catch(showError);
});
document.querySelectorAll('[data-action="retry"]').forEach((button) => button.addEventListener('click', retry));
document.querySelector('[data-action="close-game"]').addEventListener('click', closeGame);
document.querySelector('[data-action="retry-connection"]').addEventListener('click', retryConnection);

function showError(caught) {
  if (!state.sessionToken) {
    const expired = ['RTALES_LAUNCH_EXPIRED', 'RTALES_LAUNCH_CONFLICT'].includes(caught?.code);
    const retryable = caught?.status === 429 || caught?.status >= 500;
    document.querySelector('#connection-error-title').textContent = expired
      ? 'La conexión con Rtales ha caducado'
      : 'No se pudo conectar con Rtales';
    document.querySelector('#connection-error-message').textContent = expired
      ? 'Vuelve a iniciar el juego desde Rtales para obtener una sesión nueva.'
      : (caught instanceof Error ? caught.message : 'No hemos podido preparar tu sesión.');
    document.querySelector('[data-action="retry-connection"]').hidden = !retryable;
    document.querySelector('[data-action="close-game"]').hidden = retryable;
    show('connection-error');
    return;
  }
  document.querySelector('#error-message').textContent = caught instanceof Error ? caught.message : 'Inténtalo de nuevo.';
  show('error');
}

bootstrap().catch(showError);
