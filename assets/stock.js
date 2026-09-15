// ── Stock page ───────────────────────────────────────────────────────────
// Standalone from dashboard.js: different data (stock.json) and a much
// simpler page (one table), so it doesn't reuse render()/renderVendorSimple.

const TARGET_MONTHS = 2; // months of coverage considered "healthy"; also
                          // what "stock recomendado" is sized to.
const DEMAND_MONTHS = 3; // trailing months averaged for estimated demand.

function monthlyDemand(allMonths, sku) {
  const last = allMonths.slice(-DEMAND_MONTHS);
  const total = last.reduce((s, m) => s + (((m.by_sku || {})[sku] || {}).qty || 0), 0);
  return total / DEMAND_MONTHS;
}

// "Quiebre" also covers <1 month of runway left (not just literal zero
// stock) -- by the time it reads zero it's already too late to reorder.
function statusFor(available, demand) {
  if (available <= 0) return 'quiebre';
  if (demand === 0) return 'sindemanda';
  const coverage = available / demand;
  if (coverage < 1) return 'quiebre';
  if (coverage < TARGET_MONTHS) return 'bajo';
  return 'ok';
}

const STATUS_LABEL = { quiebre: 'Quiebre', bajo: 'Bajo', ok: 'OK', sindemanda: 'Sin demanda reciente' };
const STATUS_PILL  = { quiebre: 'low', bajo: 'mid', ok: 'ok', sindemanda: 'neutral' };
const STATUS_RANK  = { quiebre: 0, bajo: 1, ok: 2, sindemanda: 3 };

async function loadStock() {
  const [stockRes, ventasRes] = await Promise.all([
    fetch('data/stock.json'),
    fetch('data/ventas.json'),
  ]);
  const stock = await stockRes.json();
  const ventas = await ventasRes.json();
  const allMonths = ventas.months || [];

  document.getElementById('updated-at').textContent =
    'Actualizado: ' + (stock.updated_at || '').slice(0, 16).replace('T', ' ') + ' UTC';

  const rows = (stock.items || []).map(it => {
    const demand = monthlyDemand(allMonths, it.sku);
    const status = statusFor(it.quantity_available, demand);
    const coverage = demand > 0 ? it.quantity_available / demand : null;
    const recommended = Math.ceil(demand * TARGET_MONTHS);
    return { ...it, demand, status, coverage, recommended };
  });

  rows.sort((a, b) => {
    if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    const ca = a.coverage === null ? Infinity : a.coverage;
    const cb = b.coverage === null ? Infinity : b.coverage;
    return ca - cb;
  });

  renderSummary(rows);
  renderTable(rows);

  document.getElementById('loading').style.display = 'none';
  document.getElementById('content').classList.add('loaded');
}

function renderSummary(rows) {
  const counts = { quiebre: 0, bajo: 0, ok: 0, sindemanda: 0 };
  rows.forEach(r => counts[r.status]++);
  document.getElementById('kpi-quiebre').textContent = counts.quiebre;
  document.getElementById('kpi-bajo').textContent = counts.bajo;
  document.getElementById('kpi-ok').textContent = counts.ok;
  document.getElementById('kpi-total-skus').textContent = rows.length;
}

function renderTable(rows) {
  document.getElementById('tbody-stock').innerHTML = rows.map(r => `
    <tr>
      <td><strong>${r.sku}</strong></td>
      <td>${r.office_name || '—'}</td>
      <td>${r.quantity_available}</td>
      <td>${r.demand.toFixed(1)}</td>
      <td>${r.coverage === null ? '—' : r.coverage.toFixed(1) + ' m'}</td>
      <td>${r.recommended}</td>
      <td><span class="pill ${STATUS_PILL[r.status]}">${STATUS_LABEL[r.status]}</span></td>
    </tr>
  `).join('');
}

loadStock().catch(err => {
  document.getElementById('loading').textContent = 'Error al cargar datos: ' + err.message;
});
