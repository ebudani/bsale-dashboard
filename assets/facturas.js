// Facturas emitidas (facturas.html): se abre desde el cuadro del mismo nombre del tablero.
const MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const PERIODOS = ['this_month','prev_month','this_year','prev_year','all_time','custom'];
const estado = { periodo:'this_month', desde:'', hasta:'', vend:'todas', texto:'', orden:'mes', dir:-1 };
let FILAS = [];       // una por documento
let MESES_DATOS = []; // 'YYYY-MM' que maneja el tablero (los mismos de su filtro Periodo)
let ACTUALIZADO = '';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const plata = v => (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString('es-CL');
const mesNombre = m => MESES[+m.slice(5, 7) - 1] + '-' + m.slice(2, 4);
const limpio = s => String(s || '').replace(/\s+/g, ' ').trim();
const sinTildes = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Mismo criterio que monthsForPeriod() del tablero: la referencia es el ultimo mes con datos
function mesesDelPeriodo() {
  const n = MESES_DATOS.length, ref = MESES_DATOS[n - 1] || '', anio = +ref.slice(0, 4);
  switch (estado.periodo) {
    case 'prev_month': return [MESES_DATOS[n - 2] || ref];
    case 'this_year':  return MESES_DATOS.filter(m => +m.slice(0, 4) === anio);
    case 'prev_year':  return MESES_DATOS.filter(m => +m.slice(0, 4) === anio - 1);
    case 'all_time':   return MESES_DATOS;
    case 'custom': {
      const [a, b] = [estado.desde, estado.hasta].sort();
      return MESES_DATOS.filter(m => m >= a && m <= b);
    }
    default: return [ref];
  }
}

function etiquetaPeriodo(meses) {
  if (!meses.length) return 'sin datos';
  if (estado.periodo === 'all_time') return 'Todo';
  if (meses.length === 1) return mesNombre(meses[0]);
  if (estado.periodo === 'this_year' || estado.periodo === 'prev_year') return meses[0].slice(0, 4);
  return `${mesNombre(meses[0])} a ${mesNombre(meses[meses.length - 1])}`;
}

const ORDEN = {
  mes:     (a, b) => a.fecha.localeCompare(b.fecha) || a.numero - b.numero,
  numero:  (a, b) => a.numero - b.numero,
  cliente: (a, b) => a.cliente.localeCompare(b.cliente, 'es') || a.fecha.localeCompare(b.fecha),
  rut:     (a, b) => a.rut.localeCompare(b.rut, 'es', { numeric:true }),
  teox:    (a, b) => a.teox - b.teox,
  ll:      (a, b) => a.ll - b.ll,
  otros:   (a, b) => a.otros - b.otros,
  total:   (a, b) => a.total - b.total,
};

function filasVisibles() {
  const meses = new Set(mesesDelPeriodo());
  const q = sinTildes(estado.texto.trim());
  const sinPuntos = q.replace(/\./g, '');
  return FILAS.filter(r => meses.has(r.mes)
      && (estado.vend === 'todas' || r.vendedor === estado.vend)
      && (!q || sinTildes(r.cliente).includes(q) || r.rut.toLowerCase().replace(/\./g, '').includes(sinPuntos) || String(r.numero) === q))
    .sort((a, b) => ORDEN[estado.orden](a, b) * estado.dir);
}

function totales(filas) {
  const t = { facturas:0, nc:0, teox:0, ll:0, otros:0, total:0 };
  filas.forEach(r => {
    if (r.tipo === 'N') t.nc++; else t.facturas++;
    t.teox += r.teox; t.ll += r.ll; t.otros += r.otros; t.total += r.total;
  });
  return t;
}

const cuantas = t => `${t.facturas.toLocaleString('es-CL')} factura${t.facturas === 1 ? '' : 's'}`
  + (t.nc ? ` + ${t.nc} nota${t.nc === 1 ? '' : 's'} de crédito` : '');

// La columna Otros solo aparece si en lo que se esta viendo hay algo que no es Teoxane ni LL
const hayOtros = filas => filas.some(r => r.otros !== 0);

function columnas(filas) {
  return [['mes','Mes'],['numero','N° de factura'],['cliente','Cliente'],['rut','RUT'],
    ['teox','$ Teoxane',1],['ll','$ LL',1],...(hayOtros(filas) ? [['otros','Otros',1]] : []),['total','Total',1]];
}

const PILL = { N:'<span class="pill p-no">NC</span>', E:'<span class="pill p-gr">Exenta</span>', F:'' };
const celda = v => `<td class="num">${v ? plata(v) : '<span class="cero">—</span>'}</td>`;

function pintar() {
  const filas = filasVisibles(), cols = columnas(filas), otros = cols.some(c => c[0] === 'otros'), t = totales(filas);
  $('titulo').textContent = `Facturas emitidas — ${etiquetaPeriodo(mesesDelPeriodo())}` + (estado.vend !== 'todas' ? ` — ${estado.vend}` : '');
  const tabla = $('t-fact');
  tabla.tHead.innerHTML = '<tr>' + cols.map(([k, titulo, num]) =>
    `<th data-k="${k}" class="${num ? 'num' : ''}">${titulo} <span class="flecha">${estado.orden === k ? (estado.dir > 0 ? '▲' : '▼') : ''}</span></th>`).join('') + '</tr>';
  tabla.tHead.querySelectorAll('th').forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    if (estado.orden === k) estado.dir = -estado.dir;
    else { estado.orden = k; estado.dir = (k === 'cliente' || k === 'rut') ? 1 : -1; }
    pintar();
  });
  tabla.tBodies[0].innerHTML = filas.map(r =>
    `<tr class="${r.tipo === 'N' ? 'nc' : ''}"><td class="corta">${mesNombre(r.mes)}</td><td class="corta nro">${r.numero}${PILL[r.tipo]}</td><td>${esc(r.cliente)}</td><td class="corta">${esc(r.rut)}</td>`
    + celda(r.teox) + celda(r.ll) + (otros ? celda(r.otros) : '') + `<td class="num"><b>${plata(r.total)}</b></td></tr>`
  ).join('') || `<tr><td colspan="${cols.length}" class="vacio">No hay facturas con estos filtros.</td></tr>`;
  tabla.tFoot.innerHTML = `<tr><td>Total</td><td colspan="3">${cuantas(t)}</td><td class="num">${plata(t.teox)}</td><td class="num">${plata(t.ll)}</td>${otros ? `<td class="num">${plata(t.otros)}</td>` : ''}<td class="num">${plata(t.total)}</td></tr>`;
  guardarEnLink();
}

// Los filtros quedan en la direccion: al recargar la pagina se mantienen
function guardarEnLink() {
  const p = new URLSearchParams();
  const v = new URLSearchParams(location.search).get('v');
  if (v) p.set('v', v);
  p.set('periodo', estado.periodo);
  if (estado.periodo === 'custom') { p.set('desde', estado.desde); p.set('hasta', estado.hasta); }
  if (!window.LOCKED_VENDOR && estado.vend !== 'todas') p.set('vendedor', estado.vend);
  history.replaceState(history.state, '', location.pathname + '?' + p.toString());
}

async function bajarExcel() {
  if (!window.ExcelJS) { alert('Para descargar el Excel hace falta conexión a internet.'); return; }
  const filas = filasVisibles(), otros = hayOtros(filas), t = totales(filas);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Facturas', { views:[{ state:'frozen', ySplit:1 }] });
  const pesos = '"$"#,##0;-"$"#,##0';
  const cols = [['Mes',10],['N° de factura',14],['Tipo',16],['Cliente',50],['RUT',14],['$ Teoxane',16,pesos],['$ LL',15,pesos],
    ...(otros ? [['Otros',12,pesos]] : []),['Total',16,pesos]];
  ws.columns = cols.map(([header, width, numFmt]) => ({ header, width, style: numFmt ? { numFmt } : {} }));
  const TIPOS = { F:'Factura', E:'Factura exenta', N:'Nota de crédito' };
  filas.forEach(r => ws.addRow([mesNombre(r.mes), r.numero, TIPOS[r.tipo], r.cliente, r.rut, r.teox, r.ll, ...(otros ? [r.otros] : []), r.total]));
  const ultima = filas.length + 1;
  ws.autoFilter = { from:{ row:1, column:1 }, to:{ row:ultima, column:cols.length } };
  const total = ws.addRow(['Total', cuantas(t), '', '', '', t.teox, t.ll, ...(otros ? [t.otros] : []), t.total]);
  total.font = { bold:true };
  total.eachCell({ includeEmpty:true }, c => { c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFE8EEF7' } }; c.border = { top:{ style:'medium' } }; });
  ws.getRow(1).eachCell(c => { c.font = { bold:true }; c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFD9D9D9' } }; });
  const blob = new Blob([await wb.xlsx.writeBuffer()], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const quien = estado.vend !== 'todas' ? '_' + estado.vend.replace(/\s+/g, '-') : '';
  a.download = `facturas-emitidas${quien}_${etiquetaPeriodo(mesesDelPeriodo()).replace(/\s+/g, '-')}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// "← Volver": mismo criterio que el resto del tablero
function goBack(fallbackUrl) {
  let sameSite = false;
  try { sameSite = !!document.referrer && new URL(document.referrer).origin === location.origin; } catch (e) {}
  if (sameSite && history.length > 1) history.back();
  else location.href = fallbackUrl;
}

// Nombre, RUT y vendedora salen de ventas.json; facturas.json solo trae el id de cada ficha
function armarFilas(ventas, facturas) {
  const filas = [];
  Object.entries(facturas.months || {}).forEach(([mes, docs]) => docs.forEach(([numero, tipo, fecha, cid, teox, ll, total]) => {
    const m = (ventas.clients || {})[cid] || {};
    filas.push({
      mes, numero, tipo, fecha, teox, ll, total, otros: total - teox - ll,
      cliente: limpio(m.name) || 'Ficha ' + cid, rut: m.rut || '',
      vendedor: limpio((ventas.client_vendor || {})[cid]) || 'Sin asignar',
    });
  }));
  // diferencias de redondeo de pocos pesos entre las lineas y el documento no son "Otros"
  filas.forEach(r => { if (Math.abs(r.otros) <= 2) r.otros = 0; });
  return filas;
}

function mensaje(texto) { document.querySelector('main').innerHTML = `<div class="aviso">${esc(texto)}</div>`; }

async function cargar() {
  const bloqueada = window.LOCKED_VENDOR;
  if (bloqueada === '__invalid__') { mensaje('Link inválido. Pedí tu enlace correcto.'); return; }
  const pedir = async url => { const res = await fetch(url, { cache:'no-cache' }); if (!res.ok) throw new Error(url + ' ' + res.status); return res.json(); };
  const [ventas, facturas] = await Promise.all([pedir('data/ventas.json'), pedir('data/facturas.json')]);
  FILAS = armarFilas(ventas, facturas);
  MESES_DATOS = (ventas.months || []).map(m => `${m.year}-${String(m.month).padStart(2, '0')}`);
  ACTUALIZADO = facturas.updated_at || '';
  const pedido = new URLSearchParams(location.search);

  if (bloqueada) {
    // Link de una vendedora: solo las facturas de su cartera, en la tabla, los totales y el Excel
    FILAS = FILAS.filter(r => r.vendedor === bloqueada);
    estado.vend = 'todas';
    $('filtro-vend').classList.add('solo-general-oculto');
    document.querySelector('header h1').innerHTML = `AestheticsPro <span>· Facturas — ${esc(bloqueada)}</span>`;
  } else {
    const vendedoras = [...new Set(FILAS.map(r => r.vendedor))].sort((a, b) => a.localeCompare(b, 'es'));
    const elegida = limpio(pedido.get('vendedor'));
    if (elegida && !vendedoras.includes(elegida)) vendedoras.push(elegida);
    $('f-vend').innerHTML = '<option value="todas">Total</option>' + vendedoras.map(v => `<option>${esc(v)}</option>`).join('');
    estado.vend = elegida || 'todas';
    $('f-vend').value = estado.vend;
    $('f-vend').onchange = e => { estado.vend = e.target.value; pintar(); };
  }

  const opciones = MESES_DATOS.map(m => `<option value="${m}">${mesNombre(m)}</option>`).join('');
  $('f-desde').innerHTML = opciones;
  $('f-hasta').innerHTML = opciones;
  const ultimo = MESES_DATOS[MESES_DATOS.length - 1];
  const valido = m => MESES_DATOS.includes(m) ? m : ultimo;
  estado.periodo = PERIODOS.includes(pedido.get('periodo')) ? pedido.get('periodo') : 'this_month';
  estado.desde = valido(pedido.get('desde'));
  estado.hasta = valido(pedido.get('hasta'));
  $('f-periodo').value = estado.periodo;
  $('f-desde').value = estado.desde;
  $('f-hasta').value = estado.hasta;
  $('rango').hidden = estado.periodo !== 'custom';
  $('f-periodo').onchange = e => { estado.periodo = e.target.value; $('rango').hidden = estado.periodo !== 'custom'; pintar(); };
  $('f-desde').onchange = e => { estado.desde = e.target.value; pintar(); };
  $('f-hasta').onchange = e => { estado.hasta = e.target.value; pintar(); };
  $('f-texto').oninput = e => { estado.texto = e.target.value; pintar(); };
  $('excel').onclick = bajarExcel;
  $('actualizado').textContent = 'Actualizado: ' + ACTUALIZADO.slice(0, 16).replace('T', ' ') + ' UTC';
  pintar();
}
cargar().catch(err => mensaje(`No se pudieron cargar los datos (${err.message}).`));
