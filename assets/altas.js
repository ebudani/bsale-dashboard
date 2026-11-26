// Altas y cotizaciones (altas.html)
let DATA = { bajado:'', filas:[] };
let aniosDisponibles = [];
const MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
// grupo = como se agrupa en KPIs, tabla mensual y grafico
const ESTADOS = {
  cotizo_compro:      { grupo:'compro', texto:'Compró', pill:'p-ok' },
  cotizo_no_compro:   { grupo:'no', texto:'No compró', pill:'p-no' },
  compra_anulada:     { grupo:'no', texto:'Compra anulada', pill:'p-no' },
  en_plazo:           { grupo:'plazo', texto:'En plazo', pill:'p-pz' },
  seguimiento:        { grupo:'seg', texto:'Seguimiento pendiente', pill:'p-sg' },
  compro_sin_cotizar: { grupo:'otros', texto:'Compró sin cotizar', pill:'p-az' },
  venta_anulada:      { grupo:'otros', texto:'Venta anulada', pill:'p-gr' },
};
const CHIPS = [['todos','Todos'],['seg','Seguimiento pendiente'],['no','No compraron'],['plazo','En plazo'],['compro','Compraron'],['otros','Otros']];
const estado = { anio:'2026', vend:'todas', mes:'todos', grupo:'todos', texto:'' };
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const plata = v => v == null ? '—' : '$' + Math.round(v).toLocaleString('es-CL');
const fecha = s => s ? s.split('-').reverse().join('-') : '—';
const mesNombre = m => MESES[+m.slice(5) - 1] + '-' + m.slice(2, 4);
const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';

const base = () => DATA.filas.filter(r => (estado.anio === 'todo' || r.alta.startsWith(estado.anio)) && (estado.vend === 'todas' || r.vendedor === estado.vend));
function contar(filas) {
  const c = { altas: filas.length, compro:0, no:0, plazo:0, seg:0, otros:0 };
  filas.forEach(r => c[ESTADOS[r.estado].grupo]++);
  c.cotizaron = c.compro + c.no + c.plazo;
  return c;
}
const mesesDe = filas => [...new Set(filas.map(r => r.alta.slice(0, 7)))].sort();

// [titulo corto, fechas] del periodo de alta elegido; el año en curso llega hasta la fecha de los datos
function periodo() {
  const hoy = DATA.bajado.slice(0, 10), corte = +hoy.slice(8) + '-' + MESES[+hoy.slice(5, 7) - 1].toLowerCase();
  if (estado.anio === 'todo') return ['2025 y 2026', `1-ene-2025 al ${corte}-${hoy.slice(0, 4)}`];
  return [estado.anio, estado.anio === hoy.slice(0, 4) ? `1-ene al ${corte}` : '1-ene al 31-dic'];
}
function pintarKpis(filas) {
  const c = contar(filas);
  const monto = g => filas.filter(r => ESTADOS[r.estado].grupo === g && r.cotizaciones.length).reduce((s, r) => s + r.cotizaciones[r.cotizaciones.length - 1].total, 0);
  const k = (cls, t, v, s) => `<div class="kpi ${cls}"><label>${t}</label><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const n = mesesDe(filas).length;
  $('kpis').innerHTML =
    k('', `Clientes nuevos ${periodo()[0]}`, c.altas, `${periodo()[1]}` + (n ? ` · ${(c.altas / n).toFixed(0)} por mes en promedio` : '')) +
    k('', 'Cotizaron', c.cotizaron, `${pct(c.cotizaron, c.altas)} de los nuevos`) +
    k('ok', 'Compraron', c.compro, `${pct(c.compro, c.cotizaron)} de los que cotizaron`) +
    k('no', 'No compraron', c.no, `${plata(monto('no'))} en su última cotización`) +
    k('pz', 'En plazo', c.plazo, `${plata(monto('plazo'))} cotizado hace 7 días o menos`) +
    k('sg', 'Seguimiento pendiente', c.seg, 'Alta sin cotización ni compra · tocá para ver');
  document.querySelector('#kpis .kpi.sg').onclick = () => {
    estado.grupo = 'seg'; estado.mes = 'todos'; pintar();
    $('detalle').scrollIntoView({ behavior:'smooth' });
  };
}

function pintarMeses(filas) {
  const hayOtros = contar(filas).otros > 0;
  // [nombre completo, nombre corto para el telefono]
  const cab = [['Mes','Mes'],['Altas','Altas'],['Cotizaron','Cotiz.'],['Compraron','Compró'],['No compraron','No'],['En plazo','Plazo'],['A seguir','Seguir'],...(hayOtros ? [['Otros','Otros']] : []),['% compra','%']];
  $('t-mes').tHead.innerHTML = '<tr>' + cab.map(([l, c], i) => `<th class="${i ? 'num' : ''}"><span class="largo">${l}</span><span class="corto">${c}</span></th>`).join('') + '</tr>';
  const celdas = (nombre, c) => `<td>${nombre}</td><td class="num"><b>${c.altas}</b></td><td class="num">${c.cotizaron}</td><td class="num c-ok">${c.compro}</td><td class="num c-no">${c.no || '—'}</td><td class="num c-pz">${c.plazo || '—'}</td><td class="num c-sg">${c.seg || '—'}</td>${hayOtros ? `<td class="num">${c.otros || '—'}</td>` : ''}<td class="num">${pct(c.compro, c.cotizaron)}</td>`;
  $('t-mes').tBodies[0].innerHTML = mesesDe(filas).reverse().map(m =>
    `<tr data-mes="${m}" class="${estado.mes === m ? 'sel' : ''}">${celdas(mesNombre(m), contar(filas.filter(r => r.alta.startsWith(m))))}</tr>`).join('');
  $('t-mes').tFoot.innerHTML = `<tr>${celdas('Total', contar(filas))}</tr>`;
  $('t-mes').tBodies[0].querySelectorAll('tr').forEach(tr => tr.onclick = () => {
    estado.mes = estado.mes === tr.dataset.mes ? 'todos' : tr.dataset.mes;
    pintar();
  });
}

let grafico;
function pintarGrafico(filas) {
  const meses = mesesDe(filas);
  const por = meses.map(m => contar(filas.filter(r => r.alta.startsWith(m))));
  if (grafico) grafico.destroy();
  if (!window.Chart) return;
  grafico = new Chart($('graf'), {
    type:'bar',
    data:{ labels: meses.map(mesNombre), datasets:[['Compraron','compro','#22a05a'],['No compraron','no','#dc2626'],['En plazo','plazo','#f59e0b'],['Seguimiento pendiente','seg','#7c3aed'],['Otros','otros','#cbd5e1']]
      .filter(([, k]) => k !== 'otros' || por.some(c => c.otros))
      .map(([label, k, color]) => ({ label, data: por.map(c => c[k]), backgroundColor: color })) },
    options:{ responsive:true, maintainAspectRatio:false, interaction:{ mode:'index', intersect:false },
      plugins:{ legend:{ position:'top', labels:{ boxWidth:12, font:{ size:11 } } }, tooltip:{ callbacks:{ footer: it => it.length ? 'Altas: ' + por[it[0].dataIndex].altas : '' } } },
      scales:{ x:{ stacked:true, grid:{ display:false }, ticks:{ font:{ size:10 } } }, y:{ stacked:true, beginAtZero:true, ticks:{ precision:0 } } } },
  });
}

const sinTildes = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function filasDetalle() {
  const q = sinTildes(estado.texto.trim());
  return base().filter(r => (estado.mes === 'todos' || r.alta.startsWith(estado.mes))
      && (estado.grupo === 'todos' || ESTADOS[r.estado].grupo === estado.grupo)
      && (!q || sinTildes(r.nombre).includes(q) || sinTildes(r.contacto).includes(q) || r.rut.toLowerCase().includes(q)))
    .sort((a, b) => b.alta.localeCompare(a.alta) || a.nombre.localeCompare(b.nombre));
}
const dias = r => r.estado === 'cotizo_compro' ? r.dias_a_compra
  : r.estado === 'seguimiento' ? Math.round((Date.parse(DATA.bajado.slice(0, 10)) - Date.parse(r.alta)) / 864e5)
  : (r.primera_compra ? null : r.dias_desde_cot);

function pintarDetalle(filas) {
  const enMes = filas.filter(r => estado.mes === 'todos' || r.alta.startsWith(estado.mes));
  const c = contar(enMes);
  if (estado.grupo === 'otros' && !c.otros) estado.grupo = 'todos';
  $('chips').innerHTML = CHIPS.filter(([k]) => k !== 'otros' || c.otros).map(([k, t]) => `<button type="button" class="chip ${estado.grupo === k ? 'on' : ''}" data-g="${k}">${t} (${k === 'todos' ? c.altas : c[k]})</button>`).join('');
  $('chips').querySelectorAll('button').forEach(b => b.onclick = () => { estado.grupo = b.dataset.g; pintar(); });
  $('f-mes').innerHTML = '<option value="todos">Todos los meses</option>' + mesesDe(filas).reverse().map(m => `<option value="${m}">${mesNombre(m)}</option>`).join('');
  $('f-mes').value = estado.mes;
  pintarFilas();
}
function pintarFilas() {
  const lista = filasDetalle();
  $('det-titulo').textContent = 'Detalle' + (estado.mes === 'todos' ? '' : ' — altas de ' + mesNombre(estado.mes));
  $('t-det').tBodies[0].innerHTML = lista.map(r => {
    const cot = r.cotizaciones;
    // a quien compro le alcanza con la primera; a quien no, se le muestran las ultimas
    const ver = r.estado === 'cotizo_compro' ? cot.slice(0, 1) : cot.slice(-3);
    const resto = cot.length - ver.length;
    const lineas = ver.map(x => `<div class="cot">${x.numero} · ${fecha(x.fecha)} · ${plata(x.total)}</div>`).join('') + (resto ? `<div class="sub">+ ${resto} más</div>` : '');
    const e = ESTADOS[r.estado];
    return `<tr><td class="cot">${fecha(r.alta)}</td><td>${esc(r.nombre)}</td><td class="contacto">${r.contacto ? `<small class="c-nombre">${esc(r.contacto)}</small>` : ''}${r.rut ? `<small>RUT: ${esc(r.rut)}</small>` : ''}${r.telefono ? `<small class="c-tel">Teléfono: ${esc(r.telefono)}</small>` : ''}</td><td class="col-vend">${esc(r.vendedor)}</td><td><span class="pill ${e.pill}">${e.texto}</span></td><td>${lineas || '—'}</td><td class="cot">${fecha(r.primera_compra)}</td><td class="num">${plata(r.monto_primera_compra)}</td><td class="num">${dias(r) ?? '—'}</td></tr>`;
  }).join('') || '<tr><td colspan="9" class="vacio">No hay clientes con estos filtros.</td></tr>';
  $('det-cuenta').textContent = `${lista.length} cliente${lista.length === 1 ? '' : 's'}`;
}

function pintar() {
  const filas = base();
  if (estado.mes !== 'todos' && !mesesDe(filas).includes(estado.mes)) estado.mes = 'todos';
  pintarKpis(filas); pintarMeses(filas); pintarGrafico(filas); pintarDetalle(filas);
}

async function bajarExcel() {
  if (!window.ExcelJS) { alert('Para descargar el Excel hace falta conexión a internet.'); return; }
  const wb = new ExcelJS.Workbook();
  const hoja = (nombre, cols, filas) => {
    const ws = wb.addWorksheet(nombre, { views:[{ state:'frozen', ySplit:1 }] });
    ws.columns = cols.map(([header, width, numFmt]) => ({ header, width, style: numFmt ? { numFmt } : {} }));
    filas.forEach(f => ws.addRow(f));
    ws.getRow(1).eachCell(c => { c.font = { bold:true }; c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFD9D9D9' } }; });
    ws.autoFilter = { from:{ row:1, column:1 }, to:{ row:1, column:cols.length } };
  };
  const filas = base();
  hoja('Resumen por mes', [['Mes de alta',14],['Altas',9],['Cotizaron',11],['Compraron',11],['No compraron',14],['En plazo',10],['Seguimiento pendiente',22],['Otros',9],['% compra',10,'0%']],
    mesesDe(filas).map(m => { const c = contar(filas.filter(r => r.alta.startsWith(m))); return [mesNombre(m), c.altas, c.cotizaron, c.compro, c.no, c.plazo, c.seg, c.otros, c.cotizaron ? c.compro / c.cotizaron : null]; }));
  const f = s => s ? new Date(s + 'T00:00:00Z') : null;
  hoja('Detalle', [['Fecha alta',12,'dd-mm-yyyy'],['Cliente',48],['RUT',14],['Contacto',26],['Teléfono',14],['Vendedora',20],['Estado',24],['Cant. cotizaciones',12],['N° cotizaciones',22],['1ª cotización',13,'dd-mm-yyyy'],['Última cotización',15,'dd-mm-yyyy'],['Total última cotización (con IVA)',18,'"$"#,##0'],['1ª compra',12,'dd-mm-yyyy'],['Total 1ª compra (con IVA)',16,'"$"#,##0'],['Días',8]],
    filasDetalle().map(r => { const c = r.cotizaciones, u = c[c.length - 1];
      return [f(r.alta), r.nombre, r.rut, r.contacto, r.telefono, r.vendedor, ESTADOS[r.estado].texto, c.length, c.map(x => x.numero).join(', '), f(c[0]?.fecha), f(u?.fecha), u ? u.total : null, f(r.primera_compra), r.monto_primera_compra, dias(r)]; }));
  const blob = new Blob([await wb.xlsx.writeBuffer()], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const quien = window.LOCKED_VENDOR || (estado.vend !== 'todas' ? estado.vend : '');
  a.download = `altas-y-cotizaciones${quien ? '_' + quien.replace(/\s+/g, '-') : ''}_${DATA.bajado.slice(0, 10)}.xlsx`;
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

// Contacto de la ficha, con el mismo criterio que Cartera en riesgo: no se repite si es la
// misma razon social (empresas con el nombre cargado en nombre y apellido).
function contactNameFor(meta) {
  const fn = (meta.firstName || '').trim();
  const ln = (meta.lastName || '').trim();
  const full = `${fn} ${ln}`.trim();
  if (!full) return '';
  if (fn && fn === ln) return '';
  if (full.toLowerCase() === (meta.name || '').trim().toLowerCase()) return '';
  return full;
}

// Nombre, RUT y vendedora ("Vendedor" de la ficha, igual que Cartera en riesgo) salen de
// ventas.json; altas.json solo trae el id de cada ficha, sus fechas y cotizaciones.
function armarFilas(ventas, altas) {
  // fecha de los datos en hora de Chile
  const hoyChile = new Date(Date.parse(altas.updated_at) - 3 * 36e5).toISOString().slice(0, 10);
  const entre = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
  const filas = altas.rows.map(r => {
    const m = (ventas.clients || {})[r.c] || {};
    const cot = r.q.map(([numero, fecha, total]) => ({ numero, fecha, total }));
    return {
      nombre: (m.name || 'Ficha ' + r.c).replace(/\s+/g, ' ').trim(), rut: m.rut || '', contacto: contactNameFor(m), telefono: m.phone || '',
      alta: r.a, vendedor: ((ventas.client_vendor || {})[r.c] || 'Sin asignar').replace(/\s+/g, ' ').trim(),
      estado: ESTADOS[r.e] ? r.e : 'venta_anulada', cotizaciones: cot, primera_compra: r.p, monto_primera_compra: r.m,
      dias_a_compra: r.p && cot.length ? entre(cot[0].fecha, r.p) : null,
      dias_desde_cot: cot.length ? entre(cot[cot.length - 1].fecha, hoyChile) : null,
    };
  });
  return { bajado: hoyChile, actualizado: altas.updated_at, filas };
}

async function cargar() {
  const bloqueada = window.LOCKED_VENDOR;
  if (bloqueada === '__invalid__') {
    document.querySelector('main').innerHTML = '<div class="aviso">Link inválido. Pedí tu enlace correcto.</div>';
    return;
  }
  const pedir = async url => { const res = await fetch(url, { cache:'no-cache' }); if (!res.ok) throw new Error(url + ' ' + res.status); return res.json(); };
  const [ventas, altas] = await Promise.all([pedir('data/ventas.json'), pedir('data/altas.json')]);
  DATA = armarFilas(ventas, altas);
  aniosDisponibles = [...new Set(DATA.filas.map(r => r.alta.slice(0, 4)))].sort().reverse();

  if (bloqueada) {
    // Link de una vendedora: solo su cartera, en todo (tarjetas, tablas, grafico y Excel)
    DATA.filas = DATA.filas.filter(r => r.vendedor === bloqueada);
    estado.vend = 'todas';
    document.body.classList.add('una-vendedora');
    $('filtro-vend').classList.add('solo-general-oculto');
    document.querySelector('header h1').innerHTML = `AestheticsPro <span>· Altas — ${esc(bloqueada)}</span>`;
  } else {
    const vendedoras = [...new Set(DATA.filas.map(r => r.vendedor))].sort();
    $('f-vend').innerHTML = '<option value="todas">Todas</option>' + vendedoras.map(v => `<option>${esc(v)}</option>`).join('');
    // Desde el tablero general llega la vendedora que estaba elegida alla
    const pedida = new URLSearchParams(location.search).get('vendedor');
    if (pedida) {
      if (!vendedoras.includes(pedida)) $('f-vend').insertAdjacentHTML('beforeend', `<option>${esc(pedida)}</option>`);
      estado.vend = pedida;
    }
    $('f-vend').value = estado.vend;
    $('f-vend').onchange = e => { estado.vend = e.target.value; pintar(); };
  }

  estado.anio = aniosDisponibles[0] || 'todo';
  $('actualizado').textContent = 'Actualizado: ' + DATA.actualizado.slice(0, 16).replace('T', ' ') + ' UTC';
  $('f-anio').innerHTML = aniosDisponibles.map(a => `<option value="${a}">${a}</option>`).join('') + '<option value="todo">Todo</option>';
  $('f-anio').value = estado.anio;
  $('f-anio').onchange = e => { estado.anio = e.target.value; estado.mes = 'todos'; pintar(); };
  $('f-mes').onchange = e => { estado.mes = e.target.value; pintar(); };
  $('f-texto').oninput = e => { estado.texto = e.target.value; pintarFilas(); };
  $('excel').onclick = bajarExcel;
  pintar();
}
cargar().catch(err => {
  $('kpis').innerHTML = `<div class="aviso">No se pudieron cargar los datos (${esc(err.message)}).</div>`;
});
