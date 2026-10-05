// Mapeo compartido entre vendor.html y client-history.html: que vendedora
// corresponde a cada ?v=codigo y el hash de su PIN propio. Un solo lugar
// para agregar una vendedora nueva -- antes estaba duplicado inline en cada
// HTML y quedaba facil que se desincronizaran.
const VENDOR_LINKS = {
  monica: 'Monica Urrutia',
  daisy: 'Daisy Ponce',
  cindy: 'Cindy Monsalves',
  francisca: 'Francisca Salinas',
};

// sha256 de un PIN de 4 digitos, mismo formato que el PIN_HASH de dashboard.js.
const PIN_HASHES = {
  monica: '93d842ed8c8969c60d6807c4438a3765fe93e0de68a3301f5a6c997a045d26aa',
  cindy: 'e4a6258e6ff7094ad1cec2fda9ee04a6c41763dd0326e5df6506b273799c6ab3',
  daisy: '648da2ec87858ef68c2145ad40fd52c9ffcbe2e0673ab7adc921e70b0f65c4ea',
  francisca: '38bc3d1c4787dd15fb6b16dccd548786cb773da29ffeb075602c76d2ca87f9fd',
};

const code = new URLSearchParams(location.search).get('v');
// Unknown/missing code still sets LOCKED_VENDOR (to a value no real vendor
// has) so dashboard.js's applyVendorLock() shows its "link inválido" error
// instead of silently falling through to the unlocked all-vendors view.
// client-history.html tambien se abre desde el tablero general, sin ?v= ni vendedora
// fija (window.ALLOW_GENERAL): ahi no se bloquea nada y rige el PIN general.
// window.GENERAL_ONLY (objetivos-historico.html): pagina solo del tablero general,
// con cualquier ?v= se muestra "link invalido" en vez de abrirla con el PIN de una vendedora.
if (window.GENERAL_ONLY && code) {
  window.LOCKED_VENDOR = '__invalid__';
} else if (!(window.ALLOW_GENERAL && !code)) {
  window.LOCKED_VENDOR = VENDOR_LINKS[code] || '__invalid__';
}
window.LOCKED_PIN_HASH = PIN_HASHES[code] || null;
// Distinto localStorage key por vendedora tambien -- si no, desbloquear con
// el PIN de una vendedora desbloquearia (por compartir el mismo origen) el
// link de cualquier otra.
window.LOCKED_CODE = code;
