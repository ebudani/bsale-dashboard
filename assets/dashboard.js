// ── PIN gate ───────────────────────────────────────────────────────────────
// Deterrent only, not real access control: this is a public static site, so
// data/ventas.json and data/targets.json are reachable directly by URL
// regardless of this gate. The PIN is stored hashed just so it isn't sitting
// in plain text in "view source".
const PIN_HASH = '38bc3d1c4787dd15fb6b16dccd548786cb773da29ffeb075602c76d2ca87f9fd';
const PIN_STORAGE_KEY = 'aestheticspro-pin-ok';

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function unlockGate() {
  document.getElementById('pin-gate').style.display = 'none';
}

async function submitPin() {
  const input = document.getElementById('pin-input');
  const value = input.value.trim();
  if (await sha256Hex(value) === PIN_HASH) {
    localStorage.setItem(PIN_STORAGE_KEY, '1');
    unlockGate();
  } else {
    document.getElementById('pin-error').style.display = 'block';
    input.value = '';
    input.focus();
  }
}

document.getElementById('pin-submit').addEventListener('click', submitPin);
document.getElementById('pin-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitPin();
});

if (localStorage.getItem(PIN_STORAGE_KEY) === '1') {
  unlockGate();
} else {
  document.getElementById('pin-input').focus();
}

// ── Config ─────────────────────────────────────────────────────────────────
const BRANDS = ['Teoxane', 'RRS HA Long Lasting'];
const BRAND_COLORS = { 'Teoxane': '#2563eb', 'RRS HA Long Lasting': '#d97706', 'FINE': '#059669' };
Chart.register(ChartDataLabels);
Chart.defaults.set('plugins.datalabels', { display: false });

// ── State ──────────────────────────────────────────────────────────────────
let allMonths = [];
let usersMap  = {};
let targetsData = {};
let clientsMeta = {};
let clientActivity = {};
let clientVendorMap = {};
let lastPurchaseBrands = {};
let riskStatusFilter = 'todas';
let riskSearch = '';
let riskSortKey = 'status';
let riskSortDir = 1;
let selectedVendor = 'all';
// Which render function period/vendor changes call -- full render() on
// index.html, renderVendorSimple() on the personal vendor.html page.
// Set once in loadData(), once we know which page/mode this is.
let renderDispatch = null;
let periodMode = 'this_month';
let customFromIdx = 0;
let customToIdx = 0;
let chartMonthly, chartDaily, chartBrands, chartSku;
// Base de 10 colores muy distinguibles para los productos top; si el
// catalogo historico tiene mas SKUs que colores base, se generan tonos
// adicionales igualmente espaciados en el circulo de matices en vez de
// reciclar los primeros 10 (eso volveria a producir 2 productos con el
// mismo color, el problema que se esta arreglando aca).
const SKU_COLORS = ['#2563eb', '#d97706', '#059669', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5'];
const SKU_OTROS_COLOR = '#94a3b8';
let skuColorMap = {};

function skuPalette(n) {
  const colors = SKU_COLORS.slice(0, n);
  for (let i = colors.length; i < n; i++) {
    const hue = Math.round((360 / n) * i);
    colors.push(`hsl(${hue}, 65%, 45%)`);
  }
  return colors;
}

// Un color fijo por producto, sin importar el periodo elegido -- si el color
// cambiara segun el ranking de ventas de cada filtro, confunde (mismo
// producto, color distinto de un mes a otro). Se calcula una sola vez sobre
// TODO el historico, ordenado por venta acumulada, asi el color de cada
// producto no depende de que periodo este mirando el usuario.
function buildSkuColorMap() {
  const totals = {};
  allMonths.forEach(m => {
    Object.entries(m.by_sku || {}).forEach(([sku, v]) => {
      totals[sku] = (totals[sku] || 0) + v;
    });
  });
  const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([sku]) => sku);
  const palette = skuPalette(ranked.length);
  skuColorMap = {};
  ranked.forEach((sku, i) => { skuColorMap[sku] = palette[i]; });
}

function skuColor(sku) {
  return sku === 'Otros' ? SKU_OTROS_COLOR : (skuColorMap[sku] || SKU_OTROS_COLOR);
}

// by_vendor / by_vendor_brand keys are inconsistent across months (some store the
// numeric Bsale user id, others already store the name) — always resolve through
// this so aggregation across months groups the same person together.
function canonVendor(key) {
  return usersMap[key] || key;
}

// ── Formatting ─────────────────────────────────────────────────────────────
const CLP = v => new Intl.NumberFormat('es-CL', {
  style: 'currency', currency: 'CLP', maximumFractionDigits: 0
}).format(v);

const M = v => {
  if (Math.abs(v) >= 1e9) return `$${(v/1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v/1e6).toFixed(1)}M`;
  return CLP(v);
};

const PCT = v => `${(v * 100).toFixed(1)}%`;
const PCT0 = v => `${Math.round(v * 100)}%`;

function formatLastBrands(b) {
  if (!b) return '—';
  const parts = [];
  if (b['Teoxane']) parts.push(`Teoxane ${M(b['Teoxane'])}`);
  if (b['RRS HA Long Lasting']) parts.push(`RRS ${M(b['RRS HA Long Lasting'])}`);
  return parts.length ? parts.join(' · ') : '—';
}

function monthLabel(year, month) {
  const names = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  return `${names[month-1]}-${String(year).slice(2)}`;
}

function pillClass(ratio) {
  if (ratio >= 1.0) return 'ok';
  if (ratio >= 0.85) return 'mid';
  return 'low';
}

// ── Load ────────────────────────────────────────────────────────────────────
async function loadData() {
  const [vRes, tRes] = await Promise.all([
    fetch('data/ventas.json'),
    fetch('data/targets.json')
  ]);
  const ventas  = await vRes.json();
  const targets = await tRes.json();

  allMonths     = ventas.months || [];
  usersMap      = ventas.users  || {};
  targetsData   = targets.months || {};
  clientsMeta   = ventas.clients || {};
  clientActivity = ventas.client_activity || {};
  clientVendorMap = ventas.client_vendor || {};
  lastPurchaseBrands = ventas.last_purchase_brands || {};

  document.getElementById('updated-at').textContent =
    'Actualizado: ' + (ventas.updated_at || '').slice(0, 16).replace('T', ' ') + ' UTC';

  buildSkuColorMap();
  buildVendorSelector();
  if (!applyVendorLock()) return; // window.LOCKED_VENDOR set but not a real vendor -- bail, error already shown
  buildCustomRangeSelectors();
  renderDispatch = window.SIMPLE_MODE ? renderVendorSimple : render;
  renderDispatch();
  document.getElementById('loading').style.display = 'none';
  document.getElementById('content').classList.add('loaded');
}

// Personal per-vendor pages (monica.html, daisy.html, ...) set
// window.LOCKED_VENDOR before this script loads. Same dashboard, same data
// file, just pinned to one vendor with the switcher hidden -- there's no
// separate per-vendor codebase to keep in sync.
function applyVendorLock() {
  if (!window.LOCKED_VENDOR) return true;
  const sel = document.getElementById('vendor-select');
  const known = Array.from(sel.options).some(o => o.value === window.LOCKED_VENDOR);
  if (!known) {
    document.getElementById('loading').textContent =
      'Este link no es válido. Pedí el link correcto a quien te lo compartió.';
    return false;
  }
  selectedVendor = window.LOCKED_VENDOR;
  sel.value = window.LOCKED_VENDOR;
  document.getElementById('vendor-filter-group').style.display = 'none';
  document.querySelectorAll('h1').forEach(h1 => {
    h1.innerHTML = `AestheticsPro <span>· ${window.LOCKED_VENDOR}</span>`;
  });
  return true;
}

// ── Vendedor selector ────────────────────────────────────────────────────────
function buildVendorSelector() {
  const names = new Set();
  allMonths.forEach(m => Object.keys(m.by_vendor || {}).forEach(k => names.add(canonVendor(k))));
  const sel = document.getElementById('vendor-select');
  sel.innerHTML = '<option value="all">Total</option>';
  Array.from(names).sort((a, b) => a.localeCompare(b, 'es')).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
}

function selectVendor(v) {
  selectedVendor = v;
  renderDispatch();
}

// ── Periodo selector ─────────────────────────────────────────────────────────
function buildCustomRangeSelectors() {
  const from = document.getElementById('custom-from');
  const to   = document.getElementById('custom-to');
  from.innerHTML = '';
  to.innerHTML   = '';
  allMonths.forEach((m, i) => {
    const label = monthLabel(m.year, m.month);
    const o1 = document.createElement('option'); o1.value = i; o1.textContent = label; from.appendChild(o1);
    const o2 = document.createElement('option'); o2.value = i; o2.textContent = label; to.appendChild(o2);
  });
  customFromIdx = allMonths.length - 1;
  customToIdx   = allMonths.length - 1;
  from.value = customFromIdx;
  to.value   = customToIdx;
}

function onPeriodChange(mode) {
  periodMode = mode;
  document.getElementById('custom-range').style.display = mode === 'custom' ? 'inline-flex' : 'none';
  renderDispatch();
}

function onCustomRangeChange() {
  customFromIdx = parseInt(document.getElementById('custom-from').value);
  customToIdx   = parseInt(document.getElementById('custom-to').value);
  renderDispatch();
}

function monthsForPeriod() {
  const refIdx = allMonths.length - 1;
  const ref = allMonths[refIdx];
  switch (periodMode) {
    case 'prev_month': return refIdx > 0 ? [allMonths[refIdx - 1]] : [ref];
    case 'this_year':  return allMonths.filter(m => m.year === ref.year);
    case 'prev_year':  return allMonths.filter(m => m.year === ref.year - 1);
    case 'all_time':   return allMonths;
    case 'custom': {
      const from = Math.min(customFromIdx, customToIdx);
      const to   = Math.max(customFromIdx, customToIdx);
      return allMonths.slice(from, to + 1);
    }
    default: return [ref]; // this_month
  }
}

// Which allMonths entries fall inside the currently selected período (used to
// highlight them in the always-full-history "Ventas Netas Mensuales" chart).
function periodIndices() {
  const keys = new Set(monthsForPeriod().map(m => `${m.year}-${m.month}`));
  return allMonths.map(m => keys.has(`${m.year}-${m.month}`));
}

function periodLabel(months) {
  if (!months.length) return '—';
  if (periodMode === 'all_time') return 'Todo';
  if (months.length === 1) return monthLabel(months[0].year, months[0].month);
  if (periodMode === 'this_year' || periodMode === 'prev_year') return String(months[0].year);
  const first = months[0], last = months[months.length - 1];
  return `${monthLabel(first.year, first.month)} – ${monthLabel(last.year, last.month)}`;
}

// ── Aggregation across the selected period ──────────────────────────────────
function aggregateMonths(months) {
  const agg = {
    total_neto: 0, count_facturas: 0, count_nc: 0, neto_facturas: 0, neto_nc: 0,
    by_brand: {}, by_vendor: {}, by_vendor_brand: {}, by_day: [], top_clients: [],
    by_vendor_day: {}, top_clients_by_vendor: {}, by_sku: {}, by_vendor_sku: {}
  };
  const clientMap = {};
  const vendorClientMap = {};
  months.forEach(mm => {
    agg.total_neto     += mm.total_neto || 0;
    agg.count_facturas += mm.count_facturas || 0;
    agg.count_nc       += mm.count_nc || 0;
    agg.neto_facturas  += mm.neto_facturas || 0;
    agg.neto_nc        += mm.neto_nc || 0;
    Object.entries(mm.by_brand || {}).forEach(([b, v]) => {
      agg.by_brand[b] = (agg.by_brand[b] || 0) + v;
    });
    Object.entries(mm.by_sku || {}).forEach(([sku, v]) => {
      agg.by_sku[sku] = (agg.by_sku[sku] || 0) + v;
    });
    Object.entries(mm.by_vendor_sku || {}).forEach(([k, skus]) => {
      const name = canonVendor(k);
      agg.by_vendor_sku[name] = agg.by_vendor_sku[name] || {};
      Object.entries(skus || {}).forEach(([sku, v]) => {
        agg.by_vendor_sku[name][sku] = (agg.by_vendor_sku[name][sku] || 0) + v;
      });
    });
    Object.entries(mm.by_vendor || {}).forEach(([k, v]) => {
      const name = canonVendor(k);
      agg.by_vendor[name] = agg.by_vendor[name] || { count: 0, neto: 0 };
      agg.by_vendor[name].count += v.count || 0;
      agg.by_vendor[name].neto  += v.neto  || 0;
    });
    Object.entries(mm.by_vendor_brand || {}).forEach(([k, brands]) => {
      const name = canonVendor(k);
      agg.by_vendor_brand[name] = agg.by_vendor_brand[name] || {};
      Object.entries(brands || {}).forEach(([b, v]) => {
        agg.by_vendor_brand[name][b] = (agg.by_vendor_brand[name][b] || 0) + v;
      });
    });
    (mm.by_day || []).forEach(d => agg.by_day.push(d));
    (mm.top_clients || []).forEach(c => {
      const key = c.id || c.name;
      if (!clientMap[key]) clientMap[key] = { name: c.name, count: 0, neto: 0, teox_neto: 0, teox_units: 0, rrs_neto: 0, rrs_units: 0 };
      clientMap[key].count      += c.count || 0;
      clientMap[key].neto       += c.neto  || 0;
      clientMap[key].teox_neto  += c.teox_neto  || 0;
      clientMap[key].teox_units += c.teox_units || 0;
      clientMap[key].rrs_neto   += c.rrs_neto  || 0;
      clientMap[key].rrs_units  += c.rrs_units  || 0;
    });
    Object.entries(mm.by_vendor_day || {}).forEach(([k, days]) => {
      const name = canonVendor(k);
      agg.by_vendor_day[name] = agg.by_vendor_day[name] || [];
      (days || []).forEach(d => agg.by_vendor_day[name].push(d));
    });
    Object.entries(mm.top_clients_by_vendor || {}).forEach(([k, clients]) => {
      const name = canonVendor(k);
      vendorClientMap[name] = vendorClientMap[name] || {};
      (clients || []).forEach(c => {
        const key = c.id || c.name;
        if (!vendorClientMap[name][key]) vendorClientMap[name][key] = { name: c.name, count: 0, neto: 0, teox_neto: 0, teox_units: 0, rrs_neto: 0, rrs_units: 0 };
        vendorClientMap[name][key].count      += c.count || 0;
        vendorClientMap[name][key].neto       += c.neto  || 0;
        vendorClientMap[name][key].teox_neto  += c.teox_neto  || 0;
        vendorClientMap[name][key].teox_units += c.teox_units || 0;
        vendorClientMap[name][key].rrs_neto   += c.rrs_neto  || 0;
        vendorClientMap[name][key].rrs_units  += c.rrs_units  || 0;
      });
    });
  });
  agg.by_day.sort((a, b) => a.date.localeCompare(b.date));
  agg.top_clients = Object.values(clientMap).sort((a, b) => b.neto - a.neto);
  Object.keys(agg.by_vendor_day).forEach(name => {
    agg.by_vendor_day[name].sort((a, b) => a.date.localeCompare(b.date));
  });
  Object.entries(vendorClientMap).forEach(([name, totals]) => {
    agg.top_clients_by_vendor[name] = Object.values(totals).sort((a, b) => b.neto - a.neto);
  });
  return agg;
}

function aggregateTargets(months) {
  let total = 0, hasAny = false;
  const byVendor = {};
  months.forEach(mm => {
    const key = `${mm.year}-${String(mm.month).padStart(2, '0')}`;
    const t = targetsData[key];
    if (!t) return;
    hasAny = true;
    total += t.total || 0;
    Object.entries(t.by_vendor || {}).forEach(([name, brands]) => {
      byVendor[name] = byVendor[name] || {};
      Object.entries(brands || {}).forEach(([b, v]) => {
        byVendor[name][b] = (byVendor[name][b] || 0) + v;
      });
    });
  });
  return hasAny ? { total, by_vendor: byVendor } : null;
}

// A vendor filter narrows the period aggregate down to one person's numbers.
// count_facturas/count_nc stay null (that split isn't tracked per vendor);
// by_day and top_clients default to [] when fetch_data.py hasn't been
// re-run yet for a given month (older data won't have the by_vendor_day /
// top_clients_by_vendor fields) rather than showing stale totals.
function applyVendorFilter(agg, vendorName) {
  if (vendorName === 'all') return agg;
  const v = agg.by_vendor[vendorName] || { count: 0, neto: 0 };
  return {
    ...agg,
    total_neto: v.neto,
    count_docs: v.count,
    count_facturas: null,
    count_nc: null,
    by_brand: agg.by_vendor_brand[vendorName] || {},
    by_day: agg.by_vendor_day[vendorName] || [],
    top_clients: agg.top_clients_by_vendor[vendorName] || [],
    by_sku: agg.by_vendor_sku[vendorName] || {},
  };
}

function vendorNetoForMonth(mm, vendorName) {
  if (vendorName === 'all') return mm.total_neto || 0;
  return Object.entries(mm.by_vendor || {})
    .filter(([k]) => canonVendor(k) === vendorName)
    .reduce((s, [, v]) => s + (v.neto || 0), 0);
}

function vendorBrandForMonth(mm, vendorName, brand) {
  if (vendorName === 'all') return (mm.by_brand || {})[brand] || 0;
  return Object.entries(mm.by_vendor_brand || {})
    .filter(([k]) => canonVendor(k) === vendorName)
    .reduce((s, [, brands]) => s + ((brands || {})[brand] || 0), 0);
}

// ── Render all ──────────────────────────────────────────────────────────────
function render() {
  const months = monthsForPeriod();
  const label  = periodLabel(months);
  const agg    = aggregateMonths(months);
  // Cumplimiento only makes sense against a single month's objective -- not
  // every month has one loaded yet, so summing targets across a multi-month
  // period would silently compare a full period's sales against whichever
  // few months happen to have a target, understating how much is really owed.
  const t      = months.length === 1 ? aggregateTargets(months) : null;
  const view   = applyVendorFilter(agg, selectedVendor);

  renderKPIs(view, t, label);
  renderMonthlyChart();
  renderSkuChart(view, label);
  renderDailyChart(view, label, months.length > 1);
  renderBrandsChart();
  renderCumplTable(agg, t, label);
  renderProductivityTable('tbody-prod-teox', 'Teoxane');
  renderProductivityTable('tbody-prod-rrs', 'RRS HA Long Lasting');
  renderTopClients(view, label, months.length > 1);
  renderCarteraRiesgo();
}

// ── KPI Cards ───────────────────────────────────────────────────────────────
function renderKPIs(m, t, label) {
  const isVendor = selectedVendor !== 'all';
  const teox = (m.by_brand || {})['Teoxane'] || 0;
  const rrs  = (m.by_brand || {})['RRS HA Long Lasting'] || 0;

  document.getElementById('kpi-total').textContent = M(m.total_neto);
  document.getElementById('kpi-total-sub').textContent = isVendor
    ? `${m.count_docs} documentos`
    : `${m.count_facturas} fact · ${m.count_nc} NC`;

  const vendorTarget = isVendor && t ? (t.by_vendor[selectedVendor] || {}) : null;

  document.getElementById('kpi-teox').textContent = M(teox);
  if (isVendor) {
    if (vendorTarget && vendorTarget['Teoxane']) {
      const tTeox = vendorTarget['Teoxane'];
      document.getElementById('kpi-teox-sub').textContent =
        `Obj: ${M(tTeox)} · ${PCT(teox/tTeox)}`;
    } else {
      document.getElementById('kpi-teox-sub').textContent = 'Sin objetivo';
    }
  } else if (t && t.total) {
    const tTeox = sumVendorTargets(t, 'Teoxane');
    document.getElementById('kpi-teox-sub').textContent =
      `Obj: ${M(tTeox)} · ${PCT(tTeox ? teox/tTeox : 0)}`;
  } else {
    document.getElementById('kpi-teox-sub').textContent = `${PCT(m.total_neto ? teox/m.total_neto : 0)} del total`;
  }

  document.getElementById('kpi-rrs').textContent = M(rrs);
  if (isVendor) {
    if (vendorTarget && vendorTarget['RRS HA Long Lasting']) {
      const tRrs = vendorTarget['RRS HA Long Lasting'];
      document.getElementById('kpi-rrs-sub').textContent =
        `Obj: ${M(tRrs)} · ${PCT(rrs/tRrs)}`;
    } else {
      document.getElementById('kpi-rrs-sub').textContent = 'Sin objetivo';
    }
  } else if (t && t.total) {
    const tRrs = sumVendorTargets(t, 'RRS HA Long Lasting');
    document.getElementById('kpi-rrs-sub').textContent =
      `Obj: ${M(tRrs)} · ${PCT(tRrs ? rrs/tRrs : 0)}`;
  } else {
    document.getElementById('kpi-rrs-sub').textContent = `${PCT(m.total_neto ? rrs/m.total_neto : 0)} del total`;
  }

  let ratio = null, objLabel = '';
  if (isVendor) {
    const tTotal = vendorTarget ? (vendorTarget['Teoxane']||0) + (vendorTarget['RRS HA Long Lasting']||0) : 0;
    if (tTotal) { ratio = (teox + rrs) / tTotal; objLabel = `Obj: ${M(tTotal)}`; }
  } else if (t && t.total) {
    ratio = m.total_neto / t.total;
    objLabel = `Obj: ${M(t.total)}`;
  }

  if (ratio !== null) {
    document.getElementById('kpi-cumpl').textContent = PCT(ratio);
    document.getElementById('kpi-cumpl-sub').textContent = objLabel;
    const card = document.getElementById('kpi-cumpl-card');
    card.className = `kpi ${ratio >= 1 ? 'green' : ratio >= 0.85 ? '' : 'red'}`;
  } else {
    document.getElementById('kpi-cumpl').textContent = '—';
    document.getElementById('kpi-cumpl-sub').textContent = 'Sin objetivo';
    document.getElementById('kpi-cumpl-card').className = 'kpi';
  }

  if (isVendor) {
    document.getElementById('kpi-docs').textContent = m.count_docs;
    document.getElementById('kpi-docs-sub').textContent = `Neto: ${M(m.total_neto)}`;
  } else {
    document.getElementById('kpi-docs').textContent = m.count_facturas + m.count_nc;
    document.getElementById('kpi-docs-sub').textContent =
      `Neto fact: ${M(m.neto_facturas)} · NC: ${M(m.neto_nc)}`;
  }
}

function sumVendorTargets(t, brand) {
  return Object.values(t.by_vendor || {}).reduce((s, bv) => s + (bv[brand] || 0), 0);
}

// ── Personal vendor page (vendor.html) ──────────────────────────────────────
// Deliberately not the full dashboard: just the 5 KPIs plus a per-brand
// cumplimiento breakdown, per what was asked for that page specifically.
function renderVendorSimple() {
  const months = monthsForPeriod();
  const label  = periodLabel(months);
  const agg    = aggregateMonths(months);
  const t      = months.length === 1 ? aggregateTargets(months) : null;
  const view   = applyVendorFilter(agg, selectedVendor);

  renderKPIs(view, t, label);
  renderCumplDetail(view, t);
}

function renderCumplDetail(view, t) {
  const wrap = document.getElementById('cumpl-detail');
  if (!wrap) return;

  const vendorTarget = t ? (t.by_vendor[selectedVendor] || {}) : {};
  const teoxReal = (view.by_brand || {})['Teoxane'] || 0;
  const rrsReal  = (view.by_brand || {})['RRS HA Long Lasting'] || 0;
  const teoxObj  = vendorTarget['Teoxane'] || 0;
  const rrsObj   = vendorTarget['RRS HA Long Lasting'] || 0;

  const rows = [
    { label: 'Teoxane', color: BRAND_COLORS['Teoxane'], real: teoxReal, obj: teoxObj },
    { label: 'RRS HA Long Lasting', color: BRAND_COLORS['RRS HA Long Lasting'], real: rrsReal, obj: rrsObj },
    { label: 'Total', real: teoxReal + rrsReal, obj: teoxObj + rrsObj, isTotal: true },
  ];

  wrap.innerHTML = rows.map(r => {
    const ratio = r.obj ? r.real / r.obj : null;
    return `
      <div class="cumpl-detail-row${r.isTotal ? ' cumpl-detail-total' : ''}">
        <span class="cumpl-detail-label"${r.color ? ` style="color:${r.color}"` : ''}>${r.label}</span>
        <span class="cumpl-detail-real">${M(r.real)}</span>
        ${ratio !== null
          ? `<span class="pill ${pillClass(ratio)}">${PCT0(ratio)}</span><span class="cumpl-detail-obj">Obj: ${M(r.obj)}</span>`
          : '<span class="cumpl-detail-obj">Sin objetivo</span>'}
      </div>`;
  }).join('');
}

// ── Monthly trend chart ─────────────────────────────────────────────────────
function renderMonthlyChart() {
  const labels = allMonths.map(m => monthLabel(m.year, m.month));
  const totals = allMonths.map(m => vendorNetoForMonth(m, selectedVendor));
  const teoxs  = allMonths.map(m => vendorBrandForMonth(m, selectedVendor, 'Teoxane'));
  const rrss   = allMonths.map(m => vendorBrandForMonth(m, selectedVendor, 'RRS HA Long Lasting'));
  const inPeriod = periodIndices();

  const pct = (brandVal, i) => {
    const sum = teoxs[i] + rrss[i];
    return sum ? Math.round(brandVal / sum * 100) : null;
  };

  if (chartMonthly) chartMonthly.destroy();
  chartMonthly = new Chart(document.getElementById('chart-monthly'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Teoxane',
          data: teoxs,
          backgroundColor: teoxs.map((_, i) => BRAND_COLORS['Teoxane'] + (inPeriod[i] ? 'ee' : '99')),
          borderColor: '#0f172a',
          borderWidth: (ctx) => inPeriod[ctx.dataIndex] ? 1 : 0,
          borderRadius: 4,
          stack: 'brands',
          datalabels: {
            display: (ctx) => pct(teoxs[ctx.dataIndex], ctx.dataIndex) !== null,
            color: 'white',
            font: { size: 9, weight: '600' },
            formatter: (v, ctx) => `${pct(v, ctx.dataIndex)}%`,
          },
        },
        {
          label: 'RRS HA Long Lasting',
          data: rrss,
          backgroundColor: rrss.map((_, i) => BRAND_COLORS['RRS HA Long Lasting'] + (inPeriod[i] ? 'ee' : '99')),
          borderColor: '#0f172a',
          borderWidth: (ctx) => inPeriod[ctx.dataIndex] ? 1 : 0,
          borderRadius: 4,
          stack: 'brands',
          datalabels: {
            display: (ctx) => pct(rrss[ctx.dataIndex], ctx.dataIndex) !== null,
            color: 'white',
            font: { size: 9, weight: '600' },
            formatter: (v, ctx) => `${pct(v, ctx.dataIndex)}%`,
          },
        },
        {
          label: 'Total neto',
          data: totals,
          type: 'line',
          borderColor: '#0f172a',
          backgroundColor: 'transparent',
          pointRadius: totals.map((_, i) => inPeriod[i] ? 4 : 2),
          pointBackgroundColor: totals.map((_, i) => inPeriod[i] ? '#0f172a' : '#94a3b8'),
          borderWidth: 1.5,
          tension: 0.2,
          yAxisID: 'y',
          datalabels: { display: false },
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${M(ctx.raw)}`
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: {
          ticks: {
            font: { size: 10 },
            callback: v => M(v)
          },
          grid: { color: '#f1f5f9' }
        }
      }
    }
  });
}

// ── Sales by SKU (Producto / Servicio) pie ──────────────────────────────────
function renderSkuChart(m, label) {
  document.getElementById('chart-sku-title').textContent = `Ventas por Producto — ${label}`;

  const entries = Object.entries(m.by_sku || {}).filter(([, v]) => v !== 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  entries.sort((a, b) => b[1] - a[1]);

  const TOP_N = 7;
  const top = entries.slice(0, TOP_N);
  const restSum = entries.slice(TOP_N).reduce((s, [, v]) => s + v, 0);
  if (restSum > 0) top.push(['Otros', restSum]);

  const labels = top.map(([sku]) => sku);
  const values = top.map(([, v]) => v);
  const colors = labels.map(skuColor);

  if (chartSku) chartSku.destroy();
  chartSku = new Chart(document.getElementById('chart-sku'), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderColor: '#ffffff',
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { boxWidth: 10, font: { size: 9 }, padding: 8 }
        },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.label}: ${M(ctx.raw)} (${total ? (ctx.raw/total*100).toFixed(1) : 0}%)`
          }
        },
        datalabels: {
          display: (ctx) => total && (ctx.dataset.data[ctx.dataIndex] / total) >= 0.05,
          color: 'white',
          font: { size: 9, weight: '600' },
          formatter: (v) => `${(v/total*100).toFixed(0)}%`,
        },
      }
    }
  });
}

// ── Daily chart ──────────────────────────────────────────────────────────────
function renderDailyChart(m, label, isMulti) {
  document.getElementById('chart-daily-title').textContent = `Curva Diaria — ${label}`;
  const unavailable = document.getElementById('chart-daily-unavailable');
  const canvas = document.getElementById('chart-daily');

  if (m.by_day === null) {
    unavailable.style.display = 'flex';
    canvas.style.display = 'none';
    if (chartDaily) { chartDaily.destroy(); chartDaily = null; }
    return;
  }
  unavailable.style.display = 'none';
  canvas.style.display = 'block';

  const days = (m.by_day || []);
  const lbl  = days.map(d => isMulti ? d.date.slice(5) : d.date.slice(8));  // MM-DD across months, DD within one
  const vals = days.map(d => d.neto);

  // Running total
  let acc = 0;
  const running = vals.map(v => (acc += v));

  if (chartDaily) chartDaily.destroy();
  chartDaily = new Chart(document.getElementById('chart-daily'), {
    type: 'bar',
    data: {
      labels: lbl,
      datasets: [
        {
          label: 'Neto diario',
          data: vals,
          backgroundColor: '#93c5fd',
          borderRadius: 2,
          yAxisID: 'y',
        },
        {
          label: 'Acumulado',
          data: running,
          type: 'line',
          borderColor: '#1d4ed8',
          backgroundColor: 'transparent',
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.3,
          yAxisID: 'y2',
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 10, font: { size: 10 } } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${M(ctx.raw)}` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 9 } } },
        y:  { display: false },
        y2: {
          position: 'right',
          ticks: { font: { size: 9 }, callback: v => M(v) },
          grid: { color: '#f1f5f9' }
        }
      }
    }
  });
}

// ── Brands per month (last 12) ───────────────────────────────────────────────
function renderBrandsChart() {
  const last12 = allMonths.slice(-12);
  const labels = last12.map(m => monthLabel(m.year, m.month));

  if (chartBrands) chartBrands.destroy();
  chartBrands = new Chart(document.getElementById('chart-brands'), {
    type: 'line',
    data: {
      labels,
      datasets: BRANDS.map(b => ({
        label: b === 'RRS HA Long Lasting' ? 'RRS' : b,
        data: last12.map(m => vendorBrandForMonth(m, selectedVendor, b)),
        borderColor: BRAND_COLORS[b],
        backgroundColor: BRAND_COLORS[b] + '22',
        pointRadius: 3,
        borderWidth: 2,
        tension: 0.3,
        fill: false,
      }))
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 10, font: { size: 10 } } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${M(ctx.raw)}` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 9 } } },
        y: { ticks: { font: { size: 9 }, callback: v => M(v) }, grid: { color: '#f1f5f9' } }
      }
    }
  });
}

// ── Brand productivity table (clients, units, unid./cliente per month) ──────
// Always shows the trailing 12 months, like "Marcas por Mes"; respects the
// Vendedor filter but not the Periodo filter.
function renderProductivityTable(tbodyId, brand) {
  const tbody = document.getElementById(tbodyId);
  tbody.innerHTML = '';
  const last12 = allMonths.slice(-12).slice().reverse();

  last12.forEach(m => {
    const prod = selectedVendor === 'all'
      ? (m.brand_productivity || {})[brand]
      : ((m.brand_productivity_by_vendor || {})[selectedVendor] || {})[brand];
    const clients = prod ? prod.clients : 0;
    const units   = prod ? prod.units   : 0;
    const productivity = clients ? units / clients : 0;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${monthLabel(m.year, m.month)}</td>
      <td>${clients}</td>
      <td>${units}</td>
      <td>${productivity.toFixed(1)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ── Cumplimiento table ───────────────────────────────────────────────────────
function renderCumplTable(agg, t, label) {
  document.getElementById('table-cumpl-title').textContent = `Cumplimiento — ${label}`;
  const bvb   = agg.by_vendor_brand || {};
  const tbody = document.getElementById('tbody-cumpl');
  tbody.innerHTML = '';

  if (!t) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:#94a3b8;text-align:center">Sin objetivos para este período</td></tr>';
    return;
  }

  const filterName = selectedVendor;
  const targetVendorIds = Object.keys(t.by_vendor || {}).filter(name => filterName === 'all' || name === filterName);
  // Any vendor with real sales this period but no loaded objective (e.g. "Sin
  // asignar") still needs a row -- otherwise the Total below silently omits
  // their sales and no longer matches the company-wide KPI cards up top.
  const extraVendorIds = Object.keys(bvb).filter(name =>
    !targetVendorIds.includes(name) && (filterName === 'all' || name === filterName)
  );
  const vendorIds = [...targetVendorIds, ...extraVendorIds];

  if (!vendorIds.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:#94a3b8;text-align:center">Sin objetivo para este vendedor</td></tr>';
    return;
  }

  vendorIds.forEach(name => {
    const real    = bvb[name] || {};
    const targets = t.by_vendor[name] || {};
    const teoxReal = real['Teoxane'] || 0;
    const teoxObj  = targets['Teoxane'] || 0;
    const rrsReal  = real['RRS HA Long Lasting'] || 0;
    const rrsObj   = targets['RRS HA Long Lasting'] || 0;
    const teoxR = teoxObj ? teoxReal/teoxObj : null;
    const rrsR  = rrsObj  ? rrsReal/rrsObj   : null;
    const totalReal = teoxReal + rrsReal;
    const totalObj  = teoxObj + rrsObj;
    const totalR    = totalObj ? totalReal/totalObj : null;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${name}</strong></td>
      <td class="group-start" style="color:${BRAND_COLORS['Teoxane']}">${M(teoxReal)}</td>
      <td>${teoxR !== null ? `<span class="pill ${pillClass(teoxR)}">${PCT0(teoxR)}</span><br><small>${M(teoxObj)}</small>` : '—'}</td>
      <td class="group-start" style="color:${BRAND_COLORS['RRS HA Long Lasting']}">${M(rrsReal)}</td>
      <td>${rrsR !== null ? `<span class="pill ${pillClass(rrsR)}">${PCT0(rrsR)}</span><br><small>${M(rrsObj)}</small>` : '—'}</td>
      <td class="group-start col-total"><strong>${M(totalReal)}</strong></td>
      <td class="col-total">${totalR !== null ? `<span class="pill ${pillClass(totalR)}">${PCT0(totalR)}</span><br><small>${M(totalObj)}</small>` : '—'}</td>
    `;
    tbody.appendChild(tr);
  });

  // Total row
  if (filterName === 'all' && vendorIds.length > 1) {
    const totTeox = vendorIds.reduce((s, u) => s + ((bvb[u]||{})['Teoxane']||0), 0);
    const totRrs  = vendorIds.reduce((s, u) => s + ((bvb[u]||{})['RRS HA Long Lasting']||0), 0);
    const tTeox   = vendorIds.reduce((s, u) => s + ((t.by_vendor[u]||{})['Teoxane']||0), 0);
    const tRrs    = vendorIds.reduce((s, u) => s + ((t.by_vendor[u]||{})['RRS HA Long Lasting']||0), 0);
    const totTotal = totTeox + totRrs;
    const tTotal    = tTeox + tRrs;

    const tr2 = document.createElement('tr');
    tr2.className = 'cumpl-total-row';
    tr2.innerHTML = `
      <td>Total</td>
      <td class="group-start" style="color:${BRAND_COLORS['Teoxane']}">${M(totTeox)}</td>
      <td>${tTeox ? `<span class="pill ${pillClass(totTeox/tTeox)}">${PCT0(totTeox/tTeox)}</span><br><small>${M(tTeox)}</small>` : '—'}</td>
      <td class="group-start" style="color:${BRAND_COLORS['RRS HA Long Lasting']}">${M(totRrs)}</td>
      <td>${tRrs ? `<span class="pill ${pillClass(totRrs/tRrs)}">${PCT0(totRrs/tRrs)}</span><br><small>${M(tRrs)}</small>` : '—'}</td>
      <td class="group-start col-total">${M(totTotal)}</td>
      <td class="col-total">${tTotal ? `<span class="pill ${pillClass(totTotal/tTotal)}">${PCT0(totTotal/tTotal)}</span><br><small>${M(tTotal)}</small>` : '—'}</td>
    `;
    tbody.appendChild(tr2);
  }
}

// ── Top clients ──────────────────────────────────────────────────────────────
function renderTopClients(m, label, isMulti) {
  document.getElementById('table-clients-title').innerHTML =
    `Top 10 Clientes — ${label}` + (isMulti && m.top_clients !== null ? '<span class="approx-note">(aprox., suma de tops mensuales)</span>' : '');

  const unavailable = document.getElementById('clients-unavailable');
  const table = document.getElementById('table-clients');
  if (m.top_clients === null) {
    unavailable.style.display = 'flex';
    table.style.display = 'none';
    return;
  }
  unavailable.style.display = 'none';
  table.style.display = 'table';
  const tbody = document.getElementById('tbody-clients');
  tbody.innerHTML = '';
  const top = (m.top_clients || []).slice(0, 10);
  top.forEach((c, i) => {
    const pct = m.total_neto ? (c.neto / m.total_neto * 100).toFixed(1) : '—';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="color:#94a3b8;width:28px">${i+1}</td>
      <td style="max-width:130px;white-space:normal;line-height:1.3"><strong>${c.name}</strong></td>
      <td>${c.count}</td>
      <td>${M(c.neto)}</td>
      <td style="color:${BRAND_COLORS['Teoxane']}">${M(c.teox_neto || 0)}<br><small>${c.teox_units || 0}u</small></td>
      <td style="color:${BRAND_COLORS['RRS HA Long Lasting']}">${M(c.rrs_neto || 0)}<br><small>${c.rrs_units || 0}u</small></td>
      <td>${pct}%</td>
    `;
    tbody.appendChild(tr);
  });
}

// ── Cartera en riesgo ─────────────────────────────────────────────────────────
// Independent of the Periodo filter -- always compares "today"'s calendar
// month against the previous one, since that's what "en riesgo" means
// regardless of which historical range is being reviewed elsewhere on the page.
const RISK_STATUS_LABEL = { activa: 'Activa', atencion: 'Atención', riesgo: 'En riesgo', nuevo: 'Sin historial' };
const RISK_STATUS_RANK  = { atencion: 0, riesgo: 1, nuevo: 2, activa: 3 };

function riskMonthKeys() {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1; // 1-12
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  return {
    current: `${y}-${String(m).padStart(2, '0')}`,
    prev: `${prevY}-${String(prevM).padStart(2, '0')}`,
    currentLabel: monthLabel(y, m),
    prevLabel: monthLabel(prevY, prevM),
  };
}

function buildRiskRoster() {
  const { current, prev } = riskMonthKeys();
  const rows = [];
  for (const cid in clientVendorMap) {
    const vendor = clientVendorMap[cid];
    if (selectedVendor !== 'all' && vendor !== selectedVendor) continue;
    const months = clientActivity[cid] || {};
    const curVal = months[current] || 0;
    const prevVal = months[prev] || 0;
    let lastMonth = null, everBought = false;
    Object.keys(months).sort().forEach(mk => {
      if (months[mk] > 0) { everBought = true; lastMonth = mk; }
    });
    let status;
    if (curVal > 0) status = 'activa';
    else if (!everBought) status = 'nuevo';
    else if (prevVal > 0) status = 'atencion';
    else status = 'riesgo';

    const meta = clientsMeta[cid] || {};
    const lastBrands = lastPurchaseBrands[cid] && lastPurchaseBrands[cid].month === lastMonth
      ? lastPurchaseBrands[cid] : null;
    rows.push({
      cid, vendor, status,
      name: meta.name || cid,
      rut: meta.rut || '',
      current: curVal, prev: prevVal,
      lastMonth, lastBrands,
      lastAmount: lastBrands ? (lastBrands['Teoxane'] || 0) + (lastBrands['RRS HA Long Lasting'] || 0) : 0,
    });
  }
  return rows;
}

function renderRiskToolbar(rows) {
  const counts = { todas: rows.length, activa: 0, atencion: 0, riesgo: 0, nuevo: 0 };
  rows.forEach(r => counts[r.status]++);
  const defs = [
    ['todas', 'Todas'], ['activa', 'Activas'], ['atencion', 'Atención'],
    ['riesgo', 'En riesgo'], ['nuevo', 'Sin historial'],
  ];
  const toolbar = document.getElementById('risk-toolbar');
  toolbar.innerHTML = defs.map(([key, label]) => `
    <button class="risk-chip ${riskStatusFilter === key ? 'active' : ''}" data-status="${key}">
      ${label}<span class="n">${counts[key] || 0}</span>
    </button>
  `).join('') + `<input class="risk-search" type="search" placeholder="Buscar cuenta o RUT…" value="${riskSearch.replace(/"/g,'&quot;')}">`;

  toolbar.querySelectorAll('.risk-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      riskStatusFilter = chip.dataset.status;
      renderCarteraRiesgo();
    });
  });
  const search = toolbar.querySelector('.risk-search');
  search.addEventListener('input', e => {
    riskSearch = e.target.value;
    renderRiskTable(buildRiskRoster());
  });
}

function renderRiskTable(rows) {
  const { current, prev, currentLabel, prevLabel } = riskMonthKeys();
  document.querySelector('#table-risk thead th[data-key="current"]').innerHTML = `Mes en curso (${currentLabel}) <span class="arrow"></span>`;
  document.querySelector('#table-risk thead th[data-key="prev"]').innerHTML = `Mes anterior (${prevLabel}) <span class="arrow"></span>`;

  let filtered = rows;
  if (riskStatusFilter !== 'todas') filtered = filtered.filter(r => r.status === riskStatusFilter);
  if (riskSearch.trim()) {
    const q = riskSearch.trim().toLowerCase();
    filtered = filtered.filter(r => r.name.toLowerCase().includes(q) || r.rut.toLowerCase().includes(q));
  }
  filtered = filtered.slice().sort((a, b) => {
    let av = riskSortKey === 'status' ? RISK_STATUS_RANK[a.status] : a[riskSortKey];
    let bv = riskSortKey === 'status' ? RISK_STATUS_RANK[b.status] : b[riskSortKey];
    if (riskSortKey === 'lastMonth') { av = av || ''; bv = bv || ''; }
    if (typeof av === 'string') return riskSortDir * av.localeCompare(bv);
    return riskSortDir * ((av || 0) - (bv || 0));
  });

  document.getElementById('tbody-risk').innerHTML = filtered.map(r => `
    <tr class="${r.status === 'nuevo' ? 'risk-row-nuevo' : ''}">
      <td class="risk-name"><strong>${r.name}</strong><small>${r.rut}</small></td>
      <td>${r.vendor}</td>
      <td><span class="pill ${r.status === 'activa' ? 'ok' : r.status === 'atencion' ? 'mid' : r.status === 'riesgo' ? 'low' : 'neutral'}">${RISK_STATUS_LABEL[r.status]}</span></td>
      <td>${r.current ? M(r.current) : '—'}</td>
      <td>${r.prev ? M(r.prev) : '—'}</td>
      <td>${r.lastMonth ? monthLabel(...r.lastMonth.split('-').map(Number)) : '—'}</td>
      <td class="risk-brands">${formatLastBrands(r.lastBrands)}</td>
    </tr>
  `).join('');
  document.getElementById('risk-count').textContent =
    `${filtered.length} de ${rows.length} cuenta${rows.length === 1 ? '' : 's'}`;
}

function renderCarteraRiesgo() {
  const card = document.getElementById('cartera-riesgo-card');
  if (selectedVendor === 'all') {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';
  document.getElementById('table-risk-title').textContent = `Cartera en riesgo — ${selectedVendor}`;
  const rows = buildRiskRoster();
  renderRiskToolbar(rows);
  renderRiskTable(rows);

  document.querySelectorAll('#table-risk thead th[data-key]').forEach(th => {
    th.onclick = () => {
      const key = th.dataset.key;
      if (riskSortKey === key) riskSortDir *= -1;
      else { riskSortKey = key; riskSortDir = (key === 'name' || key === 'vendor') ? 1 : -1; }
      document.querySelectorAll('#table-risk thead .arrow').forEach(a => a.textContent = '');
      th.querySelector('.arrow').textContent = riskSortDir === 1 ? '↑' : '↓';
      renderRiskTable(buildRiskRoster());
    };
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────
loadData().catch(err => {
  document.getElementById('loading').textContent = 'Error al cargar datos: ' + err.message;
});
