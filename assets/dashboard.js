// PIN gate lives in assets/pin-gate.js (shared with vendor.html and
// stock.html) -- loaded as a separate <script> before this file.

// ── Config ─────────────────────────────────────────────────────────────────
// Piloto de Contactado/Comentario/Volver a contactar: mientras se prueba,
// solo visible en el link de estas vendedoras (y siempre en el tablero
// general, para poder revisarlo). Agregar mas nombres (o vaciar el array
// para mostrarlo a todas) cuando este validado.
const RISK_CONTACT_PILOT_VENDORS = ['Cindy Monsalves'];
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
let clientProductHistory = {};
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
let chartClientHistoryYears, chartClientHistoryMonthsTeox, chartClientHistoryMonthsRrs;
const CLIENT_HISTORY_YEAR_COLOR = { current: '#1d4ed8', prev: '#94a3b8' }; // mismo criterio que la tabla: año en curso solido/azul, anterior gris
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
      totals[sku] = (totals[sku] || 0) + v.neto;
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

// "← Volver" de las paginas aparte: usa el historial del navegador (trae la
// misma pagina que se estaba viendo, con su scroll y filtros) y solo abre el
// link a mano si se llego directo, sin pasar antes por este sitio. Abrir
// siempre el link podia traer una copia vieja de la pagina guardada en cache.
function goBack(fallbackUrl) {
  let sameSite = false;
  try { sameSite = !!document.referrer && new URL(document.referrer).origin === location.origin; } catch (e) {}
  if (sameSite && history.length > 1) history.back();
  else location.href = fallbackUrl;
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
  clientProductHistory = ventas.client_product_history || {};

  document.getElementById('updated-at').textContent =
    'Actualizado: ' + (ventas.updated_at || '').slice(0, 16).replace('T', ' ') + ' UTC';

  buildSkuColorMap();
  buildVendorSelector();
  if (!applyVendorLock()) return; // window.LOCKED_VENDOR set but not a real vendor -- bail, error already shown

  // objetivos-historico.html: pagina aparte con el cuadro de objetivos vs
  // real, mes a mes, por vendedor (solo tablero general).
  if (window.OBJETIVOS_ONLY) {
    renderObjetivosHistorico();
    document.getElementById('loading').style.display = 'none';
    document.getElementById('content').classList.add('loaded');
    return;
  }

  // client-history.html: pagina chica aparte, solo el buscador de historico
  // por cliente (sin KPIs/Cumplimiento/Cartera en riesgo, que no existen en
  // su HTML) -- no llamar renderDispatch(), rompe porque busca elementos
  // que esa pagina no tiene.
  if (window.CLIENT_HISTORY_ONLY) {
    if (typeof initClientHistory === 'function') initClientHistory();
    document.getElementById('loading').style.display = 'none';
    document.getElementById('content').classList.add('loaded');
    return;
  }

  // cartera-riesgo.html: pagina aparte solo con la tabla de Cartera en
  // riesgo (tablero general, con selector de vendedor).
  if (window.CARTERA_ONLY) {
    if (typeof initRiskContacts === 'function') await initRiskContacts();
    renderDispatch = renderCarteraRiesgo;
    renderDispatch();
    document.getElementById('loading').style.display = 'none';
    document.getElementById('content').classList.add('loaded');
    return;
  }

  buildCustomRangeSelectors();
  if (typeof initRiskContacts === 'function') await initRiskContacts();
  if (typeof initClientHistory === 'function') initClientHistory();
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
  // La columna Vendedor es redundante en una pagina bloqueada a una sola
  // vendedora (todas las filas dicen lo mismo) -- sacarla libera ancho para
  // que el resto de la tabla entre sin scroll horizontal.
  const riskTable = document.getElementById('table-risk');
  if (riskTable) riskTable.classList.add('hide-vendor-col');
  // Piloto de Contactado/Comentario/Volver a contactar -- oculto para
  // quien no esta en RISK_CONTACT_PILOT_VENDORS (ver comentario arriba).
  if (riskTable && !RISK_CONTACT_PILOT_VENDORS.includes(window.LOCKED_VENDOR)) {
    riskTable.classList.add('hide-contact-cols');
  }
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
// vendor.html tiene su propio filtro de Periodo en el header (afecta solo el
// KPI row via renderVendorSimple -> monthsForPeriod()); Cumplimiento queda
// fijo a mes actual/anterior y Top Clientes tiene su propio filtro aparte.
function buildCustomRangeSelectors() {
  const from = document.getElementById('custom-from');
  const to   = document.getElementById('custom-to');
  if (!from || !to) return;
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
      const bs = agg.by_sku[sku] || (agg.by_sku[sku] = { neto: 0, qty: 0 });
      bs.neto += v.neto || 0;
      bs.qty  += v.qty  || 0;
    });
    Object.entries(mm.by_vendor_sku || {}).forEach(([k, skus]) => {
      const name = canonVendor(k);
      agg.by_vendor_sku[name] = agg.by_vendor_sku[name] || {};
      Object.entries(skus || {}).forEach(([sku, v]) => {
        const bvs = agg.by_vendor_sku[name][sku] || (agg.by_vendor_sku[name][sku] = { neto: 0, qty: 0 });
        bvs.neto += v.neto || 0;
        bvs.qty  += v.qty  || 0;
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

// Dashboard principal only: with a specific vendor selected, Top Clientes
// moves in under Cumplimiento (same column) so Cartera en riesgo can take
// the full row width instead of sharing it -- with "Todos" nothing changes.
// DOM move rather than pure CSS since the two live in different grid rows.
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
  renderSinAsignarDetail(agg, label);
  renderProductivityTable('tbody-prod-teox', 'Teoxane');
  renderProductivityTable('tbody-prod-rrs', 'RRS HA Long Lasting');
  renderTopClients(view, label, months.length > 1);
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
// A fixed subset of the main dashboard's own render functions/data (no
// duplicated logic), always for "this month" -- there's no Período selector
// on this page, periodMode just stays at its default.
function renderVendorSimple() {
  const months = monthsForPeriod();
  const label  = periodLabel(months);
  const agg    = aggregateMonths(months);
  const t      = months.length === 1 ? aggregateTargets(months) : null;
  const view   = applyVendorFilter(agg, selectedVendor);

  renderKPIs(view, t, label);
  renderCumplDetail();
  renderTopClientsForVendor();
  renderCarteraRiesgo();
}

// Top 10 Clientes on vendor.html has its own period filter (YTD / mes
// actual / mes anterior / últimos 3 meses), independent of the rest of the
// page (KPIs and Cumplimiento always show "mes actual").
let topClientsPeriod = 'this_month';

function monthsForTopClientsPeriod() {
  const refIdx = allMonths.length - 1;
  const ref = allMonths[refIdx];
  switch (topClientsPeriod) {
    case 'prev_month': return refIdx > 0 ? [allMonths[refIdx - 1]] : [ref];
    case 'last_3': return allMonths.slice(-3);
    case 'ytd': return allMonths.filter(m => m.year === ref.year);
    default: return [ref]; // this_month
  }
}

function topClientsPeriodLabel(months) {
  if (!months.length) return '—';
  if (months.length === 1) return monthLabel(months[0].year, months[0].month);
  const first = months[0], last = months[months.length - 1];
  return `${monthLabel(first.year, first.month)} – ${monthLabel(last.year, last.month)}`;
}

function renderTopClientsForVendor() {
  const months = monthsForTopClientsPeriod();
  const label  = topClientsPeriodLabel(months);
  const agg    = aggregateMonths(months);
  const view   = applyVendorFilter(agg, selectedVendor);
  renderTopClients(view, label, months.length > 1);
}

function onTopClientsPeriodChange(mode) {
  topClientsPeriod = mode;
  renderTopClientsForVendor();
}

function renderCumplDetail() {
  const tbody = document.getElementById('tbody-cumpl-detail');
  if (!tbody || !allMonths.length) return;

  const curMonth  = allMonths[allMonths.length - 1];
  const prevMonth = allMonths.length > 1 ? allMonths[allMonths.length - 2] : null;
  const periods = [curMonth, prevMonth].filter(Boolean).map(mm => ({
    label: monthLabel(mm.year, mm.month),
    view: applyVendorFilter(aggregateMonths([mm]), selectedVendor),
    t: aggregateTargets([mm]),
  }));

  const cell = (real, obj) => {
    const ratio = obj ? real / obj : null;
    return `<td class="group-start">${M(real)}</td>` +
      (ratio !== null
        ? `<td><span class="pill ${pillClass(ratio)}">${PCT0(ratio)}</span><br><small>${M(obj)}</small></td>`
        : `<td>—</td>`);
  };

  tbody.innerHTML = periods.map(p => {
    const vendorTarget = p.t ? (p.t.by_vendor[selectedVendor] || {}) : {};
    const teoxReal = (p.view.by_brand || {})['Teoxane'] || 0;
    const rrsReal  = (p.view.by_brand || {})['RRS HA Long Lasting'] || 0;
    const teoxObj  = vendorTarget['Teoxane'] || 0;
    const rrsObj   = vendorTarget['RRS HA Long Lasting'] || 0;
    const totalReal = teoxReal + rrsReal;
    const totalObj  = teoxObj + rrsObj;
    const totalRatio = totalObj ? totalReal / totalObj : null;

    return `
      <tr>
        <td><strong>${p.label}</strong></td>
        ${cell(teoxReal, teoxObj)}
        ${cell(rrsReal, rrsObj)}
        <td class="group-start col-total"><strong>${M(totalReal)}</strong></td>
        <td class="col-total">${totalRatio !== null
          ? `<span class="pill ${pillClass(totalRatio)}">${PCT0(totalRatio)}</span><br><small>${M(totalObj)}</small>`
          : '—'}</td>
      </tr>`;
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

  const entries = Object.entries(m.by_sku || {})
    .map(([sku, v]) => [sku, v.neto])
    .filter(([, v]) => v !== 0);
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

// Cuentas sin vendedor asignado en Bsale -- solo tiene sentido mirando el
// total de la empresa (con un vendedor puntual seleccionado, Cumplimiento ya
// no muestra la fila "Sin asignar"), y solo si hubo ventas de esas cuentas
// en el periodo.
function renderSinAsignarDetail(agg, label) {
  const wrap = document.getElementById('sinasignar-detail');
  if (!wrap) return;

  const rows = (agg.top_clients_by_vendor || {})['Sin asignar'] || [];
  if (selectedVendor !== 'all' || !rows.length) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  document.getElementById('sinasignar-title').textContent = `Cuentas sin asignar — ${label}`;
  document.getElementById('tbody-sinasignar').innerHTML = rows.map(c => `
    <tr>
      <td>${c.name}</td>
      <td>${c.count}</td>
      <td>${M(c.neto)}</td>
    </tr>
  `).join('');
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

// Nombre de contacto de la cuenta, solo cuando aporta algo distinto de la
// Razon Social -- en Bsale, para varias empresas cargadas sin el campo
// "company", el firstName y el lastName quedan los dos con el mismo nombre
// de la empresa (no es un contacto real), y para personas naturales el
// nombre ya es la Razon Social. En ambos casos no se muestra de nuevo.
function contactNameFor(meta) {
  const fn = (meta.firstName || '').trim();
  const ln = (meta.lastName || '').trim();
  const full = `${fn} ${ln}`.trim();
  if (!full) return '';
  if (fn && fn === ln) return '';
  if (full.toLowerCase() === (meta.name || '').trim().toLowerCase()) return '';
  return full;
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
    const rc = (typeof getRiskContact === 'function') ? getRiskContact(cid) : null;
    // "Contactado" y el comentario son por mes -- arrancan en blanco cada
    // mes nuevo. lastContactedAt/lastNote quedan aparte como referencia de
    // "la ultima vez", aunque el mes en curso todavia no tenga nada.
    const thisMonthEntry = (rc && rc.months && rc.months[current]) || null;
    rows.push({
      cid, vendor, status,
      name: meta.name || cid,
      rut: meta.rut || '',
      contact: contactNameFor(meta),
      phone: meta.phone || '',
      current: curVal, prev: prevVal,
      lastMonth, lastBrands,
      lastAmount: lastBrands ? (lastBrands['Teoxane'] || 0) + (lastBrands['RRS HA Long Lasting'] || 0) : 0,
      contacted: !!(thisMonthEntry && thisMonthEntry.contacted),
      contactedAt: thisMonthEntry ? (thisMonthEntry.contactedAt || null) : null,
      contactedBy: thisMonthEntry ? (thisMonthEntry.contactedBy || null) : null,
      note: thisMonthEntry ? (thisMonthEntry.note || '') : '',
      lastContactedAt: rc ? (rc.lastContactedAt || null) : null,
      lastContactedBy: rc ? (rc.lastContactedBy || null) : null,
      lastNote: rc ? (rc.lastNote || '') : '',
      lastNoteAt: rc ? (rc.lastNoteAt || null) : null,
      lastNoteBy: rc ? (rc.lastNoteBy || null) : null,
      nextContactDate: rc ? (rc.nextContactDate || '') : '',
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
  `).join('')
    + `<input class="risk-search" type="search" placeholder="Buscar cuenta o RUT…" value="${riskSearch.replace(/"/g,'&quot;')}">`
    + `<button class="risk-export-btn" title="Baja la vista actual (con estos filtros) a un archivo que abre en Excel">⬇ Descargar CSV</button>`;

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
  toolbar.querySelector('.risk-export-btn').addEventListener('click', downloadRiskCSV);
}

// Fila por fila, tal cual quedo la ultima vez que se pinto la tabla (mismos
// filtros/orden que esta viendo la vendedora) -- lo llena renderRiskTable().
let riskFilteredRowsForExport = [];

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function downloadRiskCSV() {
  const headers = [
    'Cuenta', 'RUT', 'Vendedor', 'Estado', 'Mes en curso', 'Mes anterior',
    'Última compra', 'Teoxane (última compra)', 'RRS (última compra)',
    'Contactado este mes', 'Fecha de contacto', 'Contactado por', 'Comentario',
    'Último contacto (referencia)', 'Último comentario (referencia)', 'Volver a contactar',
  ];
  const lines = [headers.map(csvCell).join(',')];
  riskFilteredRowsForExport.forEach(r => {
    lines.push([
      r.name, r.rut, r.vendor, RISK_STATUS_LABEL[r.status],
      r.current, r.prev,
      r.lastMonth ? monthLabel(...r.lastMonth.split('-').map(Number)) : '',
      r.lastBrands ? (r.lastBrands['Teoxane'] || 0) : '',
      r.lastBrands ? (r.lastBrands['RRS HA Long Lasting'] || 0) : '',
      r.contacted ? 'Sí' : 'No',
      r.contactedAt ? formatContactDate(r.contactedAt) : '',
      r.contactedBy || '',
      r.note || '',
      r.lastContactedAt ? formatContactDate(r.lastContactedAt) : '',
      r.lastNote || '',
      r.nextContactDate || '',
    ].map(csvCell).join(','));
  });
  // BOM al inicio para que Excel en Windows lea bien las tildes/ñ.
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const vendorLabel = selectedVendor === 'all' ? 'todos' : selectedVendor.replace(/\s+/g, '-');
  const today = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `cartera-en-riesgo_${vendorLabel}_${today}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function renderRiskTable(rows) {
  const { current, prev, currentLabel, prevLabel } = riskMonthKeys();
  document.querySelector('#table-risk thead th[data-key="current"]').innerHTML = `Mes en curso (${currentLabel}) <span class="arrow"></span>`;
  document.querySelector('#table-risk thead th[data-key="prev"]').innerHTML = `Mes anterior (${prevLabel}) <span class="arrow"></span>`;

  let filtered = rows;
  if (riskStatusFilter !== 'todas') filtered = filtered.filter(r => r.status === riskStatusFilter);
  if (riskSearch.trim()) {
    const q = riskSearch.trim().toLowerCase();
    filtered = filtered.filter(r =>
      r.name.toLowerCase().includes(q) || r.rut.toLowerCase().includes(q) ||
      r.contact.toLowerCase().includes(q) || r.phone.includes(q)
    );
  }
  filtered = filtered.slice().sort((a, b) => {
    let av = riskSortKey === 'status' ? RISK_STATUS_RANK[a.status] : a[riskSortKey];
    let bv = riskSortKey === 'status' ? RISK_STATUS_RANK[b.status] : b[riskSortKey];
    if (riskSortKey === 'lastMonth') { av = av || ''; bv = bv || ''; }
    // "Sin fecha" siempre al final, en cualquier direccion -- si no, el
    // orden ascendente (mas logico: proximas primero) mandaba las ~270
    // cuentas sin fecha cargada antes que la unica con fecha real.
    if (riskSortKey === 'nextContactDate') {
      if (!av && !bv) return 0;
      if (!av) return 1;
      if (!bv) return -1;
      return riskSortDir * av.localeCompare(bv);
    }
    if (typeof av === 'string') return riskSortDir * av.localeCompare(bv);
    return riskSortDir * ((av || 0) - (bv || 0));
  });

  riskFilteredRowsForExport = filtered;

  document.getElementById('tbody-risk').innerHTML = filtered.map(r => `
    <tr class="${r.status === 'nuevo' ? 'risk-row-nuevo' : ''}">
      <td class="risk-name">
        <strong>${r.name}</strong>
        <small>RUT: ${r.rut}</small>
        ${r.contact ? `<small class="risk-contact-name">${r.contact}</small>` : ''}
        ${r.phone ? `<small class="risk-contact-phone">Teléfono: ${r.phone}</small>` : ''}
      </td>
      <td>${r.vendor}</td>
      <td><span class="pill ${r.status === 'activa' ? 'ok' : r.status === 'atencion' ? 'mid' : r.status === 'riesgo' ? 'low' : 'neutral'}">${RISK_STATUS_LABEL[r.status]}</span></td>
      <td>${r.current ? M(r.current) : '—'}</td>
      <td>${r.prev ? M(r.prev) : '—'}</td>
      <td>${r.lastMonth ? monthLabel(...r.lastMonth.split('-').map(Number)) : '—'}</td>
      <td class="risk-brands">${formatLastBrands(r.lastBrands)}</td>
      <td class="risk-contacted">
        <label class="risk-contacted-check">
          <input type="checkbox" ${r.contacted ? 'checked' : ''} onchange="onRiskContactedToggle('${r.cid}', this.checked)">
          ${r.contacted ? 'Contactado' : 'Marcar'}
        </label>
        ${r.contacted
          ? `<small>${formatContactDate(r.contactedAt)}${r.contactedBy ? ' · ' + escapeHtml(r.contactedBy) : ''}</small>`
          : (r.lastContactedAt ? `<small class="risk-last-ref">Último: ${formatContactDate(r.lastContactedAt)}${r.lastContactedBy ? ' · ' + escapeHtml(r.lastContactedBy) : ''}</small>` : '')}
      </td>
      <td class="risk-note">
        <input type="text" class="risk-note-input" placeholder="Comentario…" value="${escapeHtml(r.note)}"
               onblur="onRiskNoteBlur('${r.cid}', this.value)"
               onkeydown="if(event.key==='Enter') this.blur()">
        ${r.lastNote ? `<small class="risk-last-ref" title="${escapeHtml(r.lastNote)}">Último: ${escapeHtml(truncateText(r.lastNote, 36))}</small>` : ''}
      </td>
      <td class="risk-next-contact">
        <input type="date" class="risk-next-contact-input" value="${r.nextContactDate || ''}"
               onchange="onRiskNextContactChange('${r.cid}', this.value)">
      </td>
    </tr>
  `).join('');
  document.getElementById('risk-count').textContent =
    `${filtered.length} de ${rows.length} cuenta${rows.length === 1 ? '' : 's'}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function truncateText(s, max) {
  if (!s || s.length <= max) return s || '';
  return s.slice(0, max - 1) + '…';
}

function formatContactDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return ''; }
}

// Los checkbox/input llaman a estas dos funciones globales -- vuelven a
// pintar solo la tabla (no todo el tablero) para no perder el filtro/orden
// ni saltar el scroll mientras se escribe un comentario.
async function onRiskContactedToggle(cid, checked) {
  await setRiskContacted(cid, checked);
  renderRiskTable(buildRiskRoster());
}

async function onRiskNoteBlur(cid, value) {
  const prev = (typeof getRiskContact === 'function') ? getRiskContact(cid) : null;
  const monthKey = (typeof riskCurrentMonthKey === 'function') ? riskCurrentMonthKey() : riskMonthKeys().current;
  const prevNote = (prev && prev.months && prev.months[monthKey] && prev.months[monthKey].note) || '';
  if (prevNote === value) return; // sin cambios, no pegarle a Firestore
  await setRiskNote(cid, value);
  renderRiskTable(buildRiskRoster());
}

async function onRiskNextContactChange(cid, value) {
  await setRiskNextContact(cid, value);
  renderRiskTable(buildRiskRoster());
}

function renderCarteraRiesgo() {
  const card = document.getElementById('cartera-riesgo-card');
  card.style.display = 'block';
  document.getElementById('table-risk-title').textContent =
    `Cartera en riesgo — ${selectedVendor === 'all' ? 'Todas las vendedoras' : selectedVendor}`;
  const rows = buildRiskRoster();
  renderRiskToolbar(rows);
  renderRiskTable(rows);

  document.querySelectorAll('#table-risk thead th[data-key]').forEach(th => {
    th.onclick = () => {
      const key = th.dataset.key;
      if (riskSortKey === key) riskSortDir *= -1;
      else { riskSortKey = key; riskSortDir = (key === 'name' || key === 'vendor' || key === 'nextContactDate') ? 1 : -1; }
      document.querySelectorAll('#table-risk thead .arrow').forEach(a => a.textContent = '');
      th.querySelector('.arrow').textContent = riskSortDir === 1 ? '↑' : '↓';
      renderRiskTable(buildRiskRoster());
    };
  });
}

// ── Histórico de Objetivos ───────────────────────────────────────────────────
// Un bloque por vendedor con los meses que tienen objetivos cargados en
// targets.json (mas reciente primero), mas un bloque "Total empresa".
// Real = Teoxane + RRS, igual que el Cumplimiento del tablero general.
function renderObjetivosHistorico() {
  const BR_T = 'Teoxane', BR_R = 'RRS HA Long Lasting';
  const currentMm = allMonths[allMonths.length - 1];
  const periods = Object.keys(targetsData).sort().reverse().map(key => {
    const [y, m] = key.split('-').map(Number);
    const mm = allMonths.find(x => x.year === y && x.month === m);
    return mm ? { mm, t: targetsData[key], inProgress: mm === currentMm } : null;
  }).filter(Boolean);

  const tbody = document.getElementById('tbody-objetivos-historico');
  if (!periods.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="color:#94a3b8;text-align:center">Todavía no hay objetivos cargados.</td></tr>';
    return;
  }

  const vendors = [...new Set(periods.flatMap(p => Object.keys(p.t.by_vendor || {})))]
    .sort((a, b) => a.localeCompare(b, 'es'));

  const group = (obj, real) => {
    const pct = obj ? real / obj : null;
    return `<td class="group-start">${obj ? M(obj) : '—'}</td>` +
      `<td class="col-real">${M(real)}</td>` +
      `<td>${pct === null ? '—' : `<span class="pill ${pillClass(pct)}">${PCT0(pct)}</span>`}</td>`;
  };
  const row = (label, objT, realT, objR, realR, rowClass = '') => `<tr${rowClass ? ` class="${rowClass}"` : ''}>
      <td>${label}</td>
      ${group(objT, realT)}
      ${group(objR, realR)}
      ${group(objT + objR, realT + realR)}
    </tr>`;
  const labelFor = p => monthLabel(p.mm.year, p.mm.month) + (p.inProgress ? ' <small>(en curso)</small>' : '');

  const html = [];
  vendors.forEach(name => {
    html.push(`<tr class="obj-block-row"><td colspan="10">${escapeHtml(name)}</td></tr>`);
    periods.forEach(p => {
      const targets = (p.t.by_vendor || {})[name];
      if (!targets) return;
      html.push(row(
        labelFor(p),
        targets[BR_T] || 0, vendorBrandForMonth(p.mm, name, BR_T),
        targets[BR_R] || 0, vendorBrandForMonth(p.mm, name, BR_R),
      ));
    });
  });

  html.push('<tr class="obj-block-row obj-total-block"><td colspan="10">Total empresa</td></tr>');
  periods.forEach(p => {
    const sumObj = brand => Object.values(p.t.by_vendor || {}).reduce((s, b) => s + ((b || {})[brand] || 0), 0);
    const by = p.mm.by_brand || {};
    html.push(row(labelFor(p), sumObj(BR_T), by[BR_T] || 0, sumObj(BR_R), by[BR_R] || 0, 'obj-total-row'));
  });

  tbody.innerHTML = html.join('');
}

// ── Histórico por Cliente ─────────────────────────────────────────────────────
// Vive en client-history.html -- se sale temprano en las demas paginas,
// donde estos elementos no estan en el DOM.
let clientHistorySelectedCid = null;
let clientHistorySuggestionIndex = -1;

function initClientHistory() {
  const search = document.getElementById('client-history-search');
  if (!search) return;
  const box = document.getElementById('client-history-suggestions');

  search.addEventListener('input', () => renderClientHistorySuggestions(search.value));
  search.addEventListener('focus', () => { if (search.value.trim()) renderClientHistorySuggestions(search.value); });
  search.addEventListener('keydown', e => {
    const items = [...box.querySelectorAll('.client-history-suggestion')];
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); clientHistorySuggestionIndex = Math.min(clientHistorySuggestionIndex + 1, items.length - 1); highlightSuggestion(items); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); clientHistorySuggestionIndex = Math.max(clientHistorySuggestionIndex - 1, 0); highlightSuggestion(items); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = items[clientHistorySuggestionIndex] || items[0]; if (it) selectClientHistory(it.dataset.cid); }
    else if (e.key === 'Escape') { box.classList.remove('open'); }
  });
  document.addEventListener('click', e => {
    if (!box.contains(e.target) && e.target !== search) box.classList.remove('open');
  });
}

function highlightSuggestion(items) {
  items.forEach((it, i) => it.classList.toggle('active', i === clientHistorySuggestionIndex));
}

function renderClientHistorySuggestions(query) {
  const box = document.getElementById('client-history-suggestions');
  const q = query.trim().toLowerCase();
  clientHistorySuggestionIndex = -1;
  if (q.length < 2) { box.classList.remove('open'); box.innerHTML = ''; return; }

  const matches = [];
  for (const cid in clientsMeta) {
    // Tablero de una vendedora puntual: no mostrar historico de cuentas de otras vendedoras.
    if (window.LOCKED_VENDOR && clientVendorMap[cid] !== window.LOCKED_VENDOR) continue;
    const meta = clientsMeta[cid];
    const name = (meta.name || '').toLowerCase();
    const rut = (meta.rut || '').toLowerCase();
    if (name.includes(q) || rut.includes(q)) {
      matches.push({ cid, name: meta.name || cid, rut: meta.rut || '' });
      if (matches.length >= 8) break;
    }
  }

  if (!matches.length) {
    box.innerHTML = `<div class="client-history-suggestion" style="cursor:default;color:var(--gray-600)">Sin resultados</div>`;
    box.classList.add('open');
    return;
  }

  box.innerHTML = matches.map(m => `
    <div class="client-history-suggestion" data-cid="${m.cid}">
      <strong>${escapeHtml(m.name)}</strong><small>${escapeHtml(m.rut)}</small>
    </div>
  `).join('');
  box.querySelectorAll('.client-history-suggestion[data-cid]').forEach(el => {
    el.addEventListener('click', () => selectClientHistory(el.dataset.cid));
  });
  box.classList.add('open');
}

function selectClientHistory(cid) {
  clientHistorySelectedCid = cid;
  const box = document.getElementById('client-history-suggestions');
  box.classList.remove('open');
  const meta = clientsMeta[cid] || {};
  document.getElementById('client-history-search').value = meta.name || cid;
  renderClientHistory(cid);
}

function renderClientHistory(cid) {
  const history = clientProductHistory[cid] || {};
  const monthKeys = Object.keys(history).sort();
  document.getElementById('client-history-empty').style.display = monthKeys.length ? 'none' : 'block';
  document.getElementById('client-history-content').style.display = monthKeys.length ? 'block' : 'none';
  if (!monthKeys.length) return;

  const meta = clientsMeta[cid] || {};
  const vendor = clientVendorMap[cid] || null;
  document.getElementById('client-history-header').innerHTML = `
    <div class="name">${escapeHtml(meta.name || cid)}</div>
    <div class="meta">RUT: ${escapeHtml(meta.rut || '—')}${vendor ? ' · Vendedor: ' + escapeHtml(vendor) : ''}</div>
  `;

  // Por año -- suma cada mes de ese cliente agrupado por año, mas reciente primero.
  const byYear = {};
  monthKeys.forEach(mk => {
    const year = mk.slice(0, 4);
    const y = byYear[year] || (byYear[year] = { Teoxane: 0, 'RRS HA Long Lasting': 0, neto: 0 });
    const m = history[mk];
    y.Teoxane += m.Teoxane || 0;
    y['RRS HA Long Lasting'] += m['RRS HA Long Lasting'] || 0;
    y.neto += m.neto || 0;
  });
  const years = Object.keys(byYear).sort().reverse();
  document.getElementById('tbody-client-history-years').innerHTML = years.map(y => `
    <tr>
      <td>${y}</td>
      <td>${M(byYear[y].Teoxane)}</td>
      <td>${M(byYear[y]['RRS HA Long Lasting'])}</td>
      <td class="total">${M(byYear[y].neto)}</td>
    </tr>
  `).join('');

  // Cronologico (2025, 2026, ...), no "mas reciente primero" como la tabla --
  // en el grafico el eje X es el PRODUCTO (Teoxane / RRS LL), y cada uno
  // tiene una barra por año al lado de la otra, mas vieja primero.
  const yearsAsc = years.slice().reverse();
  const yearBarColor = (i) => i === yearsAsc.length - 1 ? CLIENT_HISTORY_YEAR_COLOR.current : CLIENT_HISTORY_YEAR_COLOR.prev;
  if (chartClientHistoryYears) chartClientHistoryYears.destroy();
  chartClientHistoryYears = new Chart(document.getElementById('chart-client-history-years'), {
    type: 'bar',
    data: {
      labels: ['Teoxane', 'RRS LL'],
      datasets: yearsAsc.map((y, i) => ({
        label: y,
        data: [byYear[y].Teoxane, byYear[y]['RRS HA Long Lasting']],
        backgroundColor: yearBarColor(i),
        borderRadius: 4,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 10, font: { size: 10 } } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${M(ctx.raw)}` } },
        datalabels: { display: false },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { min: 0, ticks: { font: { size: 9 }, callback: v => M(v) }, grid: { color: '#f1f5f9' } },
      },
    },
  });

  // Mes a mes: año en curso vs el año anterior, neto total por mes.
  const now = new Date();
  const curYear = now.getUTCFullYear();
  const prevYear = curYear - 1;
  document.getElementById('client-history-months-title').textContent = `Mes a mes: ${curYear} vs ${prevYear}`;
  const monthNames = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const curMonth1based = now.getUTCMonth() + 1; // meses futuros del año en curso: no pasaron todavia
  const curTeox = [], prevTeox = [], curRrs = [], prevRrs = [];
  const rows = monthNames.map((label, i) => {
    const monthNum = i + 1;
    const isFuture = monthNum > curMonth1based;
    const mm = String(monthNum).padStart(2, '0');
    const curEntry = history[`${curYear}-${mm}`] || {};
    const prevEntry = history[`${prevYear}-${mm}`] || {};
    curTeox.push(isFuture ? null : (curEntry.Teoxane || 0));
    prevTeox.push(prevEntry.Teoxane || 0);
    curRrs.push(isFuture ? null : (curEntry['RRS HA Long Lasting'] || 0));
    prevRrs.push(prevEntry['RRS HA Long Lasting'] || 0);
    const varPct = (c, p) => {
      if (isFuture) return '—';
      if (p) {
        const pct = ((c - p) / Math.abs(p)) * 100;
        return `<span class="${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%</span>`;
      }
      if (c) return '<span class="up">Nuevo</span>';
      return '—';
    };
    const cell = v => (v ? M(v) : '—');
    const curTeoxVal = isFuture ? 0 : (curEntry.Teoxane || 0);
    const curRrsVal = isFuture ? 0 : (curEntry['RRS HA Long Lasting'] || 0);
    const prevTeoxVal = prevEntry.Teoxane || 0;
    const prevRrsVal = prevEntry['RRS HA Long Lasting'] || 0;
    return `<tr${isFuture ? ' class="client-history-future"' : ''}>
      <td>${label}</td>
      <td class="group-start col-teox">${isFuture ? '—' : cell(curTeoxVal)}</td>
      <td>${isFuture ? '—' : cell(curRrsVal)}</td>
      <td class="group-start col-teox">${cell(prevTeoxVal)}</td>
      <td>${cell(prevRrsVal)}</td>
      <td class="group-start col-teox">${varPct(curTeoxVal, prevTeoxVal)}</td>
      <td>${varPct(curRrsVal, prevRrsVal)}</td>
    </tr>`;
  });
  document.getElementById('tbody-client-history-months').innerHTML = rows.join('');

  // Un mini-grafico por producto, cada uno con la linea de 2025 (punteada,
  // se dibuja primero / va primero en la leyenda) y la de 2026 (solida).
  function renderMonthProductChart(prevChartRef, canvasId, prevData, curData) {
    if (prevChartRef) prevChartRef.destroy();
    return new Chart(document.getElementById(canvasId), {
      type: 'line',
      data: {
        labels: monthNames,
        datasets: [
          {
            label: String(prevYear),
            data: prevData,
            borderColor: CLIENT_HISTORY_YEAR_COLOR.prev,
            backgroundColor: 'transparent',
            pointRadius: 3,
            pointBackgroundColor: CLIENT_HISTORY_YEAR_COLOR.prev,
            borderWidth: 2,
            borderDash: [5, 3],
            tension: 0.25,
          },
          {
            label: String(curYear),
            data: curData,
            borderColor: CLIENT_HISTORY_YEAR_COLOR.current,
            backgroundColor: 'transparent',
            pointRadius: 3,
            pointBackgroundColor: CLIENT_HISTORY_YEAR_COLOR.current,
            borderWidth: 2,
            tension: 0.25,
            spanGaps: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 10, font: { size: 10 } } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.raw == null ? '—' : M(ctx.raw)}` } },
          datalabels: { display: false },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 9 } } },
          y: { min: 0, ticks: { font: { size: 8 }, callback: v => M(v) }, grid: { color: '#f1f5f9' } },
        },
      },
    });
  }

  chartClientHistoryMonthsTeox = renderMonthProductChart(chartClientHistoryMonthsTeox, 'chart-client-history-months-teox', prevTeox, curTeox);
  chartClientHistoryMonthsRrs = renderMonthProductChart(chartClientHistoryMonthsRrs, 'chart-client-history-months-rrs', prevRrs, curRrs);
}

// ── Init ─────────────────────────────────────────────────────────────────────
loadData().catch(err => {
  document.getElementById('loading').textContent = 'Error al cargar datos: ' + err.message;
});
