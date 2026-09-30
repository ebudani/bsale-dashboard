// ── Seguimiento de contacto en Cartera en riesgo (Firestore) ────────────────
// Un documento por cliente en la coleccion "risk_contacts", doc id = id de
// cliente de Bsale (string). Campos: contacted (bool), contactedAt (ISO
// string, fecha del ultimo marcado), contactedBy (nombre de vendedora o
// "Equipo"), note (string), updatedAt (Firestore serverTimestamp).
//
// Autenticacion anonima (sin login real) solo para que las reglas de
// Firestore puedan exigir request.auth != null -- no identifica a la
// persona (para eso esta el campo contactedBy, que lo completa el propio
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

function getRiskContact(cid) {
  return riskContactsCache[cid] || null;
}

// Nombre a guardar como "quien contacto" -- el vendedor al que esta
// bloqueada la pagina (vendor.html?v=...), o el filtro de vendedor
// elegido en el tablero general, o "Equipo" si no hay ninguno puntual.
function currentContactActor() {
  if (window.LOCKED_VENDOR && window.LOCKED_VENDOR !== '__invalid__') return window.LOCKED_VENDOR;
  if (typeof selectedVendor !== 'undefined' && selectedVendor !== 'all') return selectedVendor;
  return 'Equipo';
}

async function setRiskContacted(cid, contacted) {
  if (!riskContactsDb) return;
  const prev = riskContactsCache[cid] || {};
  const data = {
    contacted,
    contactedAt: contacted ? new Date().toISOString() : (prev.contactedAt || null),
    contactedBy: contacted ? currentContactActor() : (prev.contactedBy || null),
    note: prev.note || '',
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  riskContactsCache[cid] = { ...data, updatedAt: new Date().toISOString() };
  await riskContactsDb.collection('risk_contacts').doc(cid).set(data, { merge: true });
}

async function setRiskNote(cid, note) {
  if (!riskContactsDb) return;
  const prev = riskContactsCache[cid] || {};
  const data = {
    contacted: !!prev.contacted,
    contactedAt: prev.contactedAt || null,
    contactedBy: prev.contactedBy || null,
    note,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  riskContactsCache[cid] = { ...data, updatedAt: new Date().toISOString() };
  await riskContactsDb.collection('risk_contacts').doc(cid).set(data, { merge: true });
}
