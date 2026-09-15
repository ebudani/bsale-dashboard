// ── PIN gate ───────────────────────────────────────────────────────────────
// Shared by index.html, vendor.html and stock.html. Deterrent only, not real
// access control: this is a public static site, so data/*.json is reachable
// directly by URL regardless of this gate. The PIN is stored hashed just so
// it isn't sitting in plain text in "view source".
//
// vendor.html sets window.LOCKED_PIN_HASH/LOCKED_CODE (per vendedora) before
// this script loads; index.html and stock.html set neither, so they share
// the original admin PIN/storage key below (stock.html is reached via a
// button from the general dashboard, so sharing its unlock is the expected
// behavior, not a separate access level). The storage key is per-vendedora
// when locked -- otherwise unlocking with Monica's PIN would (same origin,
// same localStorage) silently unlock Daisy's or Cindy's link too.
const PIN_HASH = window.LOCKED_PIN_HASH || '38bc3d1c4787dd15fb6b16dccd548786cb773da29ffeb075602c76d2ca87f9fd';
const PIN_STORAGE_KEY = 'aestheticspro-pin-ok' + (window.LOCKED_CODE ? '-' + window.LOCKED_CODE : '');

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
