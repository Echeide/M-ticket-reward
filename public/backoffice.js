const state = { rows: [], selected: null, token: sessionStorage.getItem('admin-token') || '' };
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

async function load() {
  const params = new URLSearchParams(new FormData(document.querySelector('#filters')));
  for (const [key, value] of [...params]) if (!value) params.delete(key);
  const payload = await request(`/api/admin/receipts?${params}`);
  state.rows = payload.receipts;
  document.querySelector('#record-count').textContent = state.rows.length;
  document.querySelector('#receipt-list').innerHTML = state.rows.map((receipt) => `
    <button class="receipt-row" data-id="${receipt.id}">
      <span><strong>${escapeHtml(receipt.publicId)}</strong><small>${escapeHtml(receipt.fields.storeName || 'Sin tienda')}</small></span>
      <span><strong>${formatMoney(receipt.fields.totalCents)}</strong><small>${receipt.reward.pointsAwarded} puntos</small></span>
      <span class="status-chip ${escapeHtml(receipt.status.toLowerCase())}">${escapeHtml(receipt.status)} · ${escapeHtml(receipt.review.status)}</span>
    </button>`).join('') || '<p class="empty-state">No hay registros con estos filtros.</p>';
  document.querySelectorAll('.receipt-row').forEach((button) => button.addEventListener('click', () => select(button.dataset.id)));
}

function formatMoney(cents) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format((cents || 0) / 100);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

async function select(id) {
  state.selected = state.rows.find((row) => row.id === id);
  const receipt = state.selected;
  const panel = document.querySelector('#review-panel');
  panel.className = 'review-panel';
  panel.innerHTML = `
    <div class="ticket-image-wrap"><img id="ticket-image" alt="Ticket ${receipt.publicId}" /></div>
    <div class="review-data">
      <p class="eyebrow">${escapeHtml(receipt.publicId)}</p>
      <h2>${escapeHtml(receipt.fields.storeName || 'Sin tienda')}</h2>
      <dl><div><dt>Usuario</dt><dd>${escapeHtml(receipt.user.displayName || receipt.user.subject)}</dd></div><div><dt>Correo</dt><dd>${escapeHtml(receipt.user.email || 'No compartido')}</dd></div><div><dt>Número</dt><dd>${escapeHtml(receipt.fields.ticketNumber || '—')}</dd></div><div><dt>Fecha</dt><dd>${escapeHtml(receipt.fields.purchaseDate || '—')}</dd></div><div><dt>Importe</dt><dd>${formatMoney(receipt.fields.totalCents)}</dd></div><div><dt>Riesgo</dt><dd>${receipt.riskScore}/100</dd></div><div><dt>Puntos</dt><dd>${receipt.reward.pointsAwarded}</dd></div><div><dt>Estado</dt><dd>${escapeHtml(receipt.status)}</dd></div><div><dt>Revisión</dt><dd>${escapeHtml(receipt.review.status)}</dd></div></dl>
      <label>Motivo o nota<textarea id="review-reason" rows="3" placeholder="Obligatorio para revocar"></textarea></label>
      <div class="review-actions"><button class="secondary-button" id="clear-review" ${receipt.review.status !== 'PENDING' ? 'disabled' : ''}>Revisado sin fraude</button><button class="danger-button" id="revoke" ${receipt.status !== 'REWARDED' ? 'disabled' : ''}>Fraude: revocar puntos</button></div>
    </div>`;
  const image = await fetch(`/api/admin/receipts/${id}/image`, { headers: headers() });
  if (image.ok) document.querySelector('#ticket-image').src = URL.createObjectURL(await image.blob());
  document.querySelector('#clear-review').addEventListener('click', () => review('CLEAR'));
  document.querySelector('#revoke').addEventListener('click', () => review('REVOKE'));
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

document.querySelector('#filters').addEventListener('submit', (event) => { event.preventDefault(); load().catch(alert); });
document.querySelector('#export-csv').addEventListener('click', async () => {
  const params = new URLSearchParams(new FormData(document.querySelector('#filters')));
  const response = await fetch(`/api/admin/receipts.csv?${params}`, { headers: headers() });
  if (!response.ok) return alert('No se pudo exportar');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await response.blob());
  link.download = 'tickets.csv';
  link.click();
});
load().catch((error) => alert(error.message));
