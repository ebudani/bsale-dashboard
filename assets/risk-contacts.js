// ── Seguimiento de contacto en Cartera en riesgo (Firestore) ────────────────
// Un documento por cliente en la coleccion "risk_contacts", doc id = id de
// cliente de Bsale (string). Forma del documento:
//   {
//     months: {
//       "2026-09": { contacted, contactedAt, contactedBy, note },
//       "2026-10": { contacted, contactedAt, contactedBy, note },
//       ...
//     },
//     lastContactedAt, lastContactedBy,   // ultima vez que se marco Contactado (cualquier mes)
//     lastNote, lastNoteAt, lastNoteBy,   // ultimo comentario cargado (cualquier mes)
//     updatedAt,
//   }
// "Contactado" y el comentario arrancan en blanco cada mes (se leen de
// months[mesActual]) -- lastContactedAt/lastNote quedan como referencia de
// "la ultima vez" aunque el mes actual todavia no tenga nada cargado.
//
// Autenticacion anonima (sin login real) solo para que las reglas de
// Firestore puedan exigir request.auth != null -- no identifica a la
// persona (para eso esta contactedBy/lastNoteBy, que los completa el propio
// código con el vendedor bloqueado de la pagina).

let riskContactsDb = null;
let riskContactsCache = {};

async function initRiskContacts() {
  if (typeof firebase === 'undefined' || typeof FIREBASE_CONFIG === 'undefined') {
    console.warn('Firebase no esta cargado -- Cartera en riesgo queda de solo lectura.');
    return;
  }
  try {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    await firebase.auth().signInAnonymously();
    riskContactsDb = firebase.firestore();
    const snap = await riskContactsDb.collection('risk_contacts').get();
    riskContactsCache = {};
    snap.forEach(doc => { riskContactsCache[doc.id] = doc.data(); });
  } catch (err) {
    console.error('No se pudo inicializar Firestore:', err);
    riskContactsDb = null;
  }
}

// Mes actual en formato "YYYY-MM" -- misma definicion de "mes en curso" que
// el resto de Cartera en riesgo (riskMonthKeys(), en dashboard.js).
function riskCurrentMonthKey() {
  if (typeof riskMonthKeys === 'function') return riskMonthKeys().current;
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function currentContactActor() {
  if (window.LOCKED_VENDOR && window.LOCKED_VENDOR !== '__invalid__') return window.LOCKED_VENDOR;
  if (typeof selectedVendor !== 'undefined' && selectedVendor !== 'all') return selectedVendor;
  return 'Equipo';
}

// Devuelve el documento completo (o null) -- buildRiskRoster() en
// dashboard.js es quien separa "este mes" de "la ultima vez".
function getRiskContact(cid) {
  return riskContactsCache[cid] || null;
}

async function setRiskContacted(cid, contacted) {
  if (!riskContactsDb) return;
  const monthKey = riskCurrentMonthKey();
  const prev = riskContactsCache[cid] || {};
  const months = { ...(prev.months || {}) };
  const prevMonth = months[monthKey] || {};
  const nowIso = new Date().toISOString();
  months[monthKey] = {
    contacted,
    contactedAt: contacted ? nowIso : (prevMonth.contactedAt || null),
    contactedBy: contacted ? currentContactActor() : (prevMonth.contactedBy || null),
    note: prevMonth.note || '',
  };
  const data = { months };
  if (contacted) {
    data.lastContactedAt = nowIso;
    data.lastContactedBy = currentContactActor();
  }
  riskContactsCache[cid] = { ...prev, ...data };
  await riskContactsDb.collection('risk_contacts').doc(cid).set(
    { ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

async function setRiskNote(cid, note) {
  if (!riskContactsDb) return;
  const monthKey = riskCurrentMonthKey();
  const prev = riskContactsCache[cid] || {};
  const months = { ...(prev.months || {}) };
  const prevMonth = months[monthKey] || {};
  months[monthKey] = {
    contacted: !!prevMonth.contacted,
    contactedAt: prevMonth.contactedAt || null,
    contactedBy: prevMonth.contactedBy || null,
    note,
  };
  const data = { months };
  if (note && note.trim()) {
    data.lastNote = note;
    data.lastNoteAt = new Date().toISOString();
    data.lastNoteBy = currentContactActor();
  }
  riskContactsCache[cid] = { ...prev, ...data };
  await riskContactsDb.collection('risk_contacts').doc(cid).set(
    { ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

// "Volver a contactar": una sola fecha por cuenta (no por mes, a diferencia
// de Contactado/comentario) -- es un recordatorio a futuro ("llamar de
// nuevo el 15/11"), no algo que tenga sentido resetear cada mes.
async function setRiskNextContact(cid, dateStr) {
  if (!riskContactsDb) return;
  const prev = riskContactsCache[cid] || {};
  const data = {
    nextContactDate: dateStr || null,
    nextContactSetBy: dateStr ? currentContactActor() : (prev.nextContactSetBy || null),
  };
  riskContactsCache[cid] = { ...prev, ...data };
  await riskContactsDb.collection('risk_contacts').doc(cid).set(
    { ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}
