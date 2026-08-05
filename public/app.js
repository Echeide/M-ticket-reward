const screens = new Map(
  [...document.querySelectorAll('[data-screen]')].map((node) => [node.dataset.screen, node]),
);
const state = {
  sessionToken: sessionStorage.getItem('ticket-session') || '',
  parentOrigin: sessionStorage.getItem('ticket-parent-origin') || '',
  receiptId: sessionStorage.getItem('ticket-receipt-id') || '',
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
  if (!state.receiptId) {
    const latest = await api('/api/receipts/latest');
    if (latest.receipt) {
      state.receiptId = latest.receipt.id;
      sessionStorage.setItem('ticket-receipt-id', state.receiptId);
    }
  }
  if (state.receiptId) {
    show('processing');
    await pollUntilReady();
  } else {
    show('welcome');
  }
}

async function optimizeTicketFile(file) {
  if (!('createImageBitmap' in window)) return file;
  const bitmap = await createImageBitmap(file);
  try {
    // Produce the same canonical image consumed by OCR. The server validates it
    // and only transforms uploads from browsers that cannot create this format.
    const scale = Math.min(1, 1200 / bitmap.width, 2000 / bitmap.height);
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
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.76));
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
  sessionStorage.setItem('ticket-receipt-id', state.receiptId);
  if (payload.status === 'DUPLICATE') return show('duplicate');
  await pollUntilReady();
}

async function pollUntilReady() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const payload = await api(`/api/receipts/${state.receiptId}`);
    state.receipt = payload.receipt;
    if (payload.receipt.status === 'READY_FOR_CONFIRMATION') {
      showOcrReview(payload.receipt);
      return show('ocr-review');
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

function showOcrReview(receipt) {
  const fields = receipt.fields;
  const store = matchStore(fields.storeName);
  const validDate = isPurchaseDateWithinDays(fields.purchaseDate, 3);
  const valid = Boolean(
    store && fields.ticketNumber && validDate &&
    Number.isInteger(fields.totalCents) && fields.totalCents > 0
  );
  document.querySelector('#ocr-store').textContent = store?.name || fields.storeName || 'No reconocido';
  document.querySelector('#ocr-number').textContent = fields.ticketNumber || 'No reconocido';
  document.querySelector('#ocr-date').textContent = fields.purchaseDate || 'No reconocida';
  const currency = /^[A-Z]{3}$/.test(fields.currency || '') ? fields.currency : 'EUR';
  document.querySelector('#ocr-total').textContent = fields.totalCents
    ? new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(fields.totalCents / 100)
    : 'No reconocido';
  document.querySelector('#ocr-validation-title').textContent = valid ? 'Ticket válido' : 'No podemos validar este ticket';
  document.querySelector('#ocr-validation-message').textContent = valid
    ? 'Los datos necesarios se han reconocido correctamente y no pueden modificarse.'
    : !validDate
      ? 'La fecha debe corresponder al día actual, con un margen máximo de 3 días. Vuelve a escanear el ticket.'
      : 'Falta algún dato obligatorio o el comercio no está autorizado. Prueba con una foto más clara.';
  const badge = document.querySelector('#ocr-validation-badge');
  badge.textContent = valid ? '✓ Ticket válido' : '! Escaneo no válido';
  badge.className = `ocr-validation-badge ${valid ? 'valid' : 'invalid'}`;
  document.querySelector('#confirm-ocr').hidden = !valid;
  document.querySelector('#retry-ocr').hidden = valid;
}

function isPurchaseDateWithinDays(value, maximumDifferenceDays) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const purchaseTimestamp = Date.UTC(year, month - 1, day);
  const purchaseDate = new Date(purchaseTimestamp);
  if (
    purchaseDate.getUTCFullYear() !== year ||
    purchaseDate.getUTCMonth() !== month - 1 ||
    purchaseDate.getUTCDate() !== day
  ) return false;
  const todayParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Atlantic/Canary', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const todayPart = (type) => Number(todayParts.find((item) => item.type === type)?.value);
  const todayTimestamp = Date.UTC(todayPart('year'), todayPart('month') - 1, todayPart('day'));
  return Math.abs(todayTimestamp - purchaseTimestamp) / 86_400_000 <= maximumDifferenceDays;
}

function matchStore(name) {
  const normalized = String(name || '').toLocaleLowerCase('es').trim();
  if (!normalized) return null;
  return state.stores.find((store) => [store.name, ...(store.aliases || [])].some((candidate) => {
    const comparable = String(candidate).toLocaleLowerCase('es').trim();
    return comparable.includes(normalized) || normalized.includes(comparable);
  }));
}

async function confirmReceipt() {
  show('reward-processing');
  const payload = await api(`/api/receipts/${state.receiptId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (payload.status === 'DUPLICATE') return show('duplicate');
  if (payload.status === 'AUTO_REJECTED') {
    document.querySelector('#ocr-validation-title').textContent = 'No podemos validar este ticket';
    document.querySelector('#ocr-validation-message').textContent = 'La validación automática ha rechazado el ticket. Vuelve a escanearlo con una imagen más clara.';
    document.querySelector('#confirm-ocr').hidden = true;
    document.querySelector('#retry-ocr').hidden = false;
    return show('ocr-review');
  }
  await pollUntilReady();
}

function finish(receipt) {
  sessionStorage.removeItem('ticket-receipt-id');
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
  sessionStorage.removeItem('ticket-receipt-id');
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
document.querySelector('#confirm-ocr').addEventListener('click', () => confirmReceipt().catch(showError));
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
