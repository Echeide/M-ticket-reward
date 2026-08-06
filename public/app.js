const screens = new Map(
  [...document.querySelectorAll('[data-screen]')].map((node) => [node.dataset.screen, node]),
);
const state = {
  sessionToken: sessionStorage.getItem('ticket-session') || '',
  parentOrigin: sessionStorage.getItem('ticket-parent-origin') || '',
  receiptId: sessionStorage.getItem('ticket-receipt-id') || '',
  receipt: null,
  stores: [],
  appSettings: {},
  pollGeneration: 0,
};

const HOME_SETTING_TARGETS = {
  'home.eyebrow': '#home-eyebrow',
  'home.title': '#home-title',
  'home.carouselLabel': '#home-carousel-label',
  'home.scanButton': '#home-scan-label',
  'home.historyButton': '#home-history-label',
};

function appendTextWithBreaks(parent, value) {
  const lines = value.split('\n');
  lines.forEach((line, index) => {
    if (index) parent.append(document.createElement('br'));
    parent.append(document.createTextNode(line));
  });
}

function renderFormattedText(node, value) {
  node.replaceChildren();
  const pattern = /\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    appendTextWithBreaks(node, value.slice(cursor, match.index));
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
  appendTextWithBreaks(node, value.slice(cursor));
}

function applyHomeSettings(settings) {
  state.appSettings = settings;
  for (const [key, selector] of Object.entries(HOME_SETTING_TARGETS)) {
    if (typeof settings[key] === 'string') document.querySelector(selector).textContent = settings[key];
  }
  if (typeof settings['home.description'] === 'string') {
    renderFormattedText(document.querySelector('#home-description'), settings['home.description']);
  }
  if (typeof settings['home.privacyNote'] === 'string') {
    renderFormattedText(document.querySelector('#home-privacy-note'), settings['home.privacyNote']);
  }
}

const RECEIPT_STATUSES = {
  OCR_QUEUED: { label: 'En espera', tone: 'pending', message: 'El ticket está registrado y esperando a ser leído.' },
  OCR_PROCESSING: { label: 'Leyendo ticket', tone: 'pending', message: 'Estamos reconociendo los datos del ticket.' },
  READY_FOR_CONFIRMATION: { label: 'Pendiente de confirmación', tone: 'attention', message: 'Los datos son válidos. Revisa el resultado para obtener los puntos.' },
  NOT_A_RECEIPT: { label: 'No es un ticket', tone: 'rejected', message: 'La imagen no parece un ticket de compra.' },
  DUPLICATE: { label: 'Duplicado', tone: 'rejected', message: 'Este ticket ya se había enviado.' },
  AUTO_REJECTED: { label: 'Ticket no autorizado', tone: 'rejected', message: 'Este ticket no cumple las condiciones de la campaña.' },
  REWARD_PENDING: { label: 'Asignando puntos', tone: 'pending', message: 'El ticket es válido y estamos asignando los puntos.' },
  REWARDED: { label: 'Aprobado', tone: 'approved', message: 'Los puntos se han añadido correctamente.' },
  REWARD_FAILED: { label: 'No completado', tone: 'rejected', message: 'No hemos podido completar la asignación de puntos.' },
  REVOKE_PENDING: { label: 'Anulación en proceso', tone: 'attention', message: 'Estamos retirando los puntos tras la revisión del ticket.' },
  REVOKED: { label: 'Anulado', tone: 'rejected', message: 'El ticket fue anulado tras la revisión antifraude.' },
};

function show(name) {
  for (const [screenName, node] of screens) node.classList.toggle('active', screenName === name);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function createIcon(name, className = 'button-icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}

let storeCarouselLayoutFrame = 0;
let storeCarouselObserver = null;

function storeCarouselItem(store, duplicate = false) {
  const item = document.createElement('span');
  item.className = 'store-carousel-item';
  if (duplicate) item.setAttribute('aria-hidden', 'true');
  const image = document.createElement('img');
  image.src = store.logoUrl;
  image.alt = duplicate ? '' : `Logo de ${store.name}`;
  image.loading = 'lazy';
  image.decoding = 'async';
  item.append(image);
  return item;
}

function layoutStoreCarousel(stores) {
  const carousel = document.querySelector('#store-carousel');
  const viewport = carousel.querySelector('.store-carousel-viewport');
  const track = document.querySelector('#store-carousel-track');
  const storesWithLogo = stores.filter((store) => store.logoUrl);
  cancelAnimationFrame(storeCarouselLayoutFrame);
  track.replaceChildren();
  if (!storesWithLogo.length) {
    carousel.hidden = true;
    return;
  }

  carousel.hidden = false;
  track.classList.add('static');
  track.style.removeProperty('--carousel-shift');
  track.append(...storesWithLogo.map((store) => storeCarouselItem(store)));

  storeCarouselLayoutFrame = requestAnimationFrame(() => {
    const items = [...track.children];
    const gap = Number.parseFloat(getComputedStyle(track).columnGap) || 0;
    const uniqueWidth = items.reduce((width, item) => width + item.getBoundingClientRect().width, 0) +
      Math.max(0, items.length - 1) * gap;
    if (uniqueWidth <= viewport.clientWidth) return;
    track.append(...storesWithLogo.map((store) => storeCarouselItem(store, true)));
    track.style.setProperty('--carousel-shift', `${uniqueWidth + gap}px`);
    track.classList.remove('static');
  });
}

function renderStoreCarousel(stores) {
  const viewport = document.querySelector('.store-carousel-viewport');
  layoutStoreCarousel(stores);
  if (!storeCarouselObserver && 'ResizeObserver' in window) {
    storeCarouselObserver = new ResizeObserver(() => layoutStoreCarousel(state.stores));
    storeCarouselObserver.observe(viewport);
  }
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
    state.receiptId = '';
    sessionStorage.removeItem('ticket-session');
    sessionStorage.removeItem('ticket-receipt-id');
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
  const [stores, configuredTexts] = await Promise.all([
    api('/api/stores'),
    api('/api/home-settings').catch(() => ({ settings: {} })),
  ]);
  state.stores = stores.stores;
  applyHomeSettings(configuredTexts.settings || {});
  renderStoreCarousel(state.stores);
  if (!state.receiptId) {
    const latest = await api('/api/receipts/latest');
    if (latest.receipt) {
      state.receiptId = latest.receipt.id;
      sessionStorage.setItem('ticket-receipt-id', state.receiptId);
    }
  }
  if (state.receiptId) {
    await resumeReceipt((await api(`/api/receipts/${state.receiptId}`)).receipt);
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
  const generation = ++state.pollGeneration;
  for (let attempt = 0; attempt < 140; attempt += 1) {
    const payload = await api(`/api/receipts/${state.receiptId}`);
    if (generation !== state.pollGeneration) return;
    state.receipt = payload.receipt;
    if (payload.receipt.status === 'READY_FOR_CONFIRMATION') {
      showOcrReview(payload.receipt);
      return show('ocr-review');
    }
    if (payload.receipt.status === 'NOT_A_RECEIPT') return show('not-receipt');
    if (payload.receipt.status === 'DUPLICATE') return show('duplicate');
    if (payload.receipt.status === 'REWARDED') return finish(payload.receipt);
    if (['AUTO_REJECTED', 'REWARD_FAILED', 'REVOKE_PENDING', 'REVOKED'].includes(payload.receipt.status)) {
      return showTicketDetail(payload.receipt);
    }
    if (attempt === 24) showRegistered(payload.receipt);
    await new Promise((resolve) => setTimeout(resolve, attempt < 24 ? 1200 : 5000));
  }
  if (generation === state.pollGeneration) showRegistered(state.receipt);
}

async function resumeReceipt(receipt) {
  state.receipt = receipt;
  state.receiptId = receipt.id;
  sessionStorage.setItem('ticket-receipt-id', receipt.id);
  if (receipt.status === 'READY_FOR_CONFIRMATION') {
    showOcrReview(receipt);
    show('ocr-review');
    return;
  }
  if (receipt.status === 'REWARDED') return finish(receipt);
  if (receipt.status === 'NOT_A_RECEIPT') return show('not-receipt');
  if (receipt.status === 'DUPLICATE') return show('duplicate');
  if (['AUTO_REJECTED', 'REWARD_FAILED', 'REVOKE_PENDING', 'REVOKED'].includes(receipt.status)) {
    return showTicketDetail(receipt);
  }
  show(receipt.status === 'REWARD_PENDING' ? 'reward-processing' : 'processing');
  await pollUntilReady();
}

function showRegistered(receipt) {
  document.querySelector('#registered-reference').textContent = receipt?.publicId || '';
  show('registered');
}

function showOcrReview(receipt) {
  const fields = receipt.fields;
  const store = matchStore(fields.storeName);
  const validDate = isPurchaseDateAllowed(fields.purchaseDate);
  const hasConfiguredPeriod = Boolean(
    state.appSettings['validation.startAt'] || state.appSettings['validation.endAt'],
  );
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
      ? hasConfiguredPeriod
        ? 'La fecha del ticket está fuera del periodo válido configurado. Vuelve a escanear el ticket.'
        : 'La fecha debe corresponder al día actual, con un margen máximo de 3 días. Vuelve a escanear el ticket.'
      : 'Falta algún dato obligatorio o el comercio no está autorizado. Prueba con una foto más clara.';
  const badge = document.querySelector('#ocr-validation-badge');
  badge.textContent = valid ? '✓ Ticket válido' : '! Escaneo no válido';
  badge.className = `ocr-validation-badge ${valid ? 'valid' : 'invalid'}`;
  document.querySelector('#confirm-ocr').hidden = !valid;
  document.querySelector('#retry-ocr').hidden = valid;
}

function isPurchaseDateAllowed(value) {
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
  const startAt = String(state.appSettings['validation.startAt'] || '');
  const endAt = String(state.appSettings['validation.endAt'] || '');
  if (startAt || endAt) {
    const startTimestamp = startAt ? Date.parse(`${startAt.slice(0, 10)}T00:00:00Z`) : null;
    const endTimestamp = endAt ? Date.parse(`${endAt.slice(0, 10)}T00:00:00Z`) : null;
    if (startTimestamp !== null && purchaseTimestamp < startTimestamp) return false;
    if (endTimestamp !== null && purchaseTimestamp > endTimestamp) return false;
    return true;
  }
  const todayParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Atlantic/Canary', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const todayPart = (type) => Number(todayParts.find((item) => item.type === type)?.value);
  const todayTimestamp = Date.UTC(todayPart('year'), todayPart('month') - 1, todayPart('day'));
  return Math.abs(todayTimestamp - purchaseTimestamp) / 86_400_000 <= 3;
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
  state.receipt = receipt;
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

function statusMeta(status, verificationRequired = false) {
  if (verificationRequired) {
    return {
      label: 'Pendiente de revisión',
      tone: 'attention',
      message: 'El ticket está registrado, pero no hemos podido verificar todos sus datos automáticamente.',
    };
  }
  return RECEIPT_STATUSES[status] || {
    label: 'En revisión', tone: 'pending', message: 'Consulta de nuevo el estado más tarde.',
  };
}

function formatMoney(totalCents, currency = 'EUR') {
  if (!Number.isInteger(totalCents) || totalCents <= 0) return '—';
  const safeCurrency = /^[A-Z]{3}$/.test(currency || '') ? currency : 'EUR';
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency: safeCurrency }).format(totalCents / 100);
  } catch {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(totalCents / 100);
  }
}

function formatTimestamp(value) {
  if (!value) return '—';
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('es-ES', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Atlantic/Canary',
  }).format(date);
}

async function openHistory() {
  state.pollGeneration += 1;
  show('ticket-history');
  const list = document.querySelector('#ticket-history-list');
  list.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'history-empty';
  loading.textContent = 'Cargando tus tickets…';
  list.append(loading);
  const payload = await api('/api/receipts');
  renderHistory(payload.receipts);
}

function renderHistory(receipts) {
  const list = document.querySelector('#ticket-history-list');
  list.replaceChildren();
  if (!receipts.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'Todavía no has enviado ningún ticket.';
    list.append(empty);
    return;
  }
  for (const receipt of receipts) {
    const meta = statusMeta(receipt.status, receipt.verificationRequired);
    const button = document.createElement('button');
    button.className = 'ticket-card';
    button.type = 'button';

    const icon = document.createElement('span');
    icon.className = 'ticket-card-icon';
    icon.append(createIcon('ticket'));

    const heading = document.createElement('span');
    heading.className = 'ticket-card-heading';
    const reference = document.createElement('strong');
    reference.textContent = receipt.publicId;
    const created = document.createElement('small');
    created.textContent = formatTimestamp(receipt.createdAt);
    heading.append(reference, created);

    const chip = document.createElement('span');
    chip.className = `ticket-status ${meta.tone}`;
    chip.textContent = receipt.status === 'REWARDED'
      ? `${meta.label} · +${receipt.reward.pointsAwarded} pts`
      : meta.label;

    const summary = document.createElement('span');
    summary.className = 'ticket-card-summary';
    const store = receipt.fields.storeName || 'Comercio pendiente de reconocer';
    summary.textContent = `${store} · ${formatMoney(receipt.fields.totalCents, receipt.fields.currency)}`;

    button.append(icon, heading, chip, summary);
    button.addEventListener('click', () => showTicketDetail(receipt));
    list.append(button);
  }
}

function showTicketDetail(receipt) {
  state.receipt = receipt;
  const meta = statusMeta(receipt.status, receipt.verificationRequired);
  document.querySelector('#detail-title').textContent = receipt.publicId;
  const status = document.querySelector('#detail-status');
  status.className = `ticket-status ${meta.tone}`;
  status.textContent = receipt.status === 'REWARDED'
    ? `${meta.label} · +${receipt.reward.pointsAwarded} puntos`
    : meta.label;
  document.querySelector('#detail-message').textContent = receipt.message || meta.message;
  document.querySelector('#detail-store').textContent = receipt.fields.storeName || 'Pendiente';
  document.querySelector('#detail-number').textContent = receipt.fields.ticketNumber || 'Pendiente';
  document.querySelector('#detail-date').textContent = receipt.fields.purchaseDate || 'Pendiente';
  document.querySelector('#detail-total').textContent = formatMoney(receipt.fields.totalCents, receipt.fields.currency);
  document.querySelector('#detail-points').textContent = receipt.status === 'REVOKED'
    ? `${receipt.reward.pointsAwarded} retirados`
    : receipt.reward.pointsAwarded > 0 ? String(receipt.reward.pointsAwarded) : '—';
  document.querySelector('#detail-created').textContent = formatTimestamp(receipt.createdAt);

  const action = document.querySelector('#detail-action');
  action.hidden = true;
  action.onclick = null;
  if (receipt.status === 'READY_FOR_CONFIRMATION') {
    action.textContent = 'Revisar y continuar';
    action.hidden = false;
    action.onclick = () => resumeReceipt(receipt).catch(showError);
  } else if (['OCR_QUEUED', 'OCR_PROCESSING', 'REWARD_PENDING'].includes(receipt.status)) {
    action.textContent = 'Seguir esperando';
    action.hidden = false;
    action.onclick = () => resumeReceipt(receipt).catch(showError);
  }
  show('ticket-detail');
}

function retry() {
  state.pollGeneration += 1;
  state.receiptId = '';
  sessionStorage.removeItem('ticket-receipt-id');
  state.receipt = null;
  document.querySelectorAll('[data-ticket-input]').forEach((input) => { input.value = ''; });
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

document.querySelectorAll('[data-ticket-input]').forEach((input) => {
  input.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) upload(file).catch(showError);
  });
});
document.querySelector('#confirm-ocr').addEventListener('click', () => confirmReceipt().catch(showError));
document.querySelectorAll('[data-action="retry"]').forEach((button) => button.addEventListener('click', retry));
document.querySelectorAll('[data-action="open-history"]').forEach((button) => {
  button.addEventListener('click', () => openHistory().catch(showError));
});
document.querySelector('[data-action="history-home"]').addEventListener('click', retry);
document.querySelector('[data-action="refresh-history"]').addEventListener('click', () => openHistory().catch(showError));
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
