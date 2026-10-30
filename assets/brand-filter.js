// ── Filtro de Marca (compartido por todas las paginas) ──────────────────────
// 'all' deja cada pagina como siempre; Teoxane o RRS HA Long Lasting la limita
// a esa marca. La eleccion se guarda en este navegador (localStorage) y se
// mantiene al pasar de una pagina a otra. Cada pagina define applyBrandChange()
// para volver a pintarse cuando se cambia el selector.
const BRAND_KEY = 'aestheticspro-brand';
const BRAND_LIST = ['Teoxane', 'RRS HA Long Lasting'];
const BRAND_SHORT = { 'Teoxane': 'Teoxane', 'RRS HA Long Lasting': 'RRS' };
const BRAND_CLASS = { 'Teoxane': 'teox', 'RRS HA Long Lasting': 'rrs' };

let selectedBrand = (() => {
  try {
    const b = localStorage.getItem(BRAND_KEY);
    return BRAND_LIST.includes(b) ? b : 'all';
  } catch (e) { return 'all'; }   // sin almacenamiento (ventana privada, etc.): arranca en Todas
})();

function brandOn() { return selectedBrand !== 'all'; }

// Misma regla por nombre de producto que classify_brand() en fetch_data.py
// (verificada contra by_brand: coincide en todos los meses y vendedoras).
const TEOXANE_NAME_MARKERS = ['rha ', 'rha1', 'rha2', 'rha3', 'rha4', 'redensity', 'puresense'];
const RRS_NAME_MARKERS = ['rrs', 'jeringa monodosis x 3ml'];
function skuBrand(name) {
  const n = (name || '').toLowerCase();
  if (TEOXANE_NAME_MARKERS.some(k => n.includes(k))) return 'Teoxane';
  if (RRS_NAME_MARKERS.some(k => n.includes(k))) return 'RRS HA Long Lasting';
  return 'Otros';
}

// body[data-brand] = teox | rrs | '' -- el CSS oculta con eso las columnas y
// tablas de la otra marca.
function setBodyBrand() {
  document.body.dataset.brand = brandOn() ? BRAND_CLASS[selectedBrand] : '';
}

// Si la marca se cambia en otra pestaña o ventana (o la pagina vuelve de "atras"
// con su estado viejo), esta pagina la toma de localStorage y se repinta.
function syncBrandFromStorage() {
  let b;
  try { b = localStorage.getItem(BRAND_KEY); } catch (e) { return; }
  if (!BRAND_LIST.includes(b)) b = 'all';
  if (b === selectedBrand) return;
  selectedBrand = b;
  const sel = document.getElementById('brand-select');
  if (sel) sel.value = selectedBrand;
  setBodyBrand();
  if (typeof applyBrandChange === 'function') applyBrandChange();
}
window.addEventListener('storage', e => { if (e.key === BRAND_KEY) syncBrandFromStorage(); });
window.addEventListener('pageshow', e => { if (e.persisted) syncBrandFromStorage(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncBrandFromStorage(); });

// Pone el selector "Marca" en el encabezado de la pagina (primer filtro, a la
// izquierda de los demas) y deja listo el atributo del body.
function initBrandFilter() {
  setBodyBrand();
  const right = document.querySelector('.header-right');
  if (!right || document.getElementById('brand-select')) return;
  const group = document.createElement('div');
  group.className = 'filter-group';
  group.id = 'brand-filter-group';
  group.innerHTML =
    '<span class="filter-label">Marca</span>' +
    '<select id="brand-select" class="filter-select">' +
    '<option value="all">Todas</option>' +
    BRAND_LIST.map(b => `<option value="${b}">${b}</option>`).join('') +
    '</select>';
  const updated = document.getElementById('updated-at');
  if (updated && updated.parentNode === right) updated.after(group); else right.prepend(group);
  const sel = group.querySelector('select');
  sel.value = selectedBrand;
  sel.addEventListener('change', () => {
    selectedBrand = sel.value;
    try { localStorage.setItem(BRAND_KEY, selectedBrand); } catch (e) { /* sin almacenamiento: vale solo para esta pagina */ }
    setBodyBrand();
    if (typeof applyBrandChange === 'function') applyBrandChange();
  });
}
