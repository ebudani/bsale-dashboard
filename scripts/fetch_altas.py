"""
fetch_altas.py - Altas de clientes vs cotizaciones y compras -> data/altas.json

Solo consultas (GET). El archivo no lleva nombres, RUT ni datos de contacto:
cada fila se identifica con el id de la ficha y la pagina toma el nombre y la
vendedora de data/ventas.json. Los registros de GitHub Actions son publicos:
este script solo imprime cantidades.

Reglas:
  - Cuenta = RUT (junta fichas del mismo RUT); alta = fecha de la ficha mas antigua.
  - Quedan afuera las fichas de la carga inicial (hasta nov-2024) y diciembre 2024.
  - Compro = factura / boleta / exenta el dia de la 1a cotizacion o despues,
    descontando notas de credito.
  - En plazo = sin compra y ultima cotizacion de 7 dias o menos.
  - seguimiento = ficha sin ninguna cotizacion ni venta.
  - Una ficha sin movimientos que repite a otra cuenta nueva (mismo nombre, o mismo
    correo y telefono, creada con hasta 3 dias de diferencia) no se cuenta.

Uso: BSALE_TOKEN=... python scripts/fetch_altas.py
"""

import collections
import datetime as dt
import json
import os
import re
import sys

from fetch_data import BASE_URL, TOKEN, get_json

OUT_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "altas.json")
CARGA_INICIAL_HASTA = dt.date(2024, 11, 30)
DESDE = dt.date(2025, 1, 1)
EN_PLAZO_DIAS = 7
COTIZACION, VENTAS, NOTA_CREDITO = "24", ("5", "15", "22"), "2"
RUT_GENERICOS = {"", "666666666", "111111111", "555555555"}


def paginar(base):
    offset, items = 0, []
    while True:
        data = get_json(f"{base}&limit=50&offset={offset}")
        lote = data.get("items", [])
        items += lote
        offset += 50
        if not lote or offset >= data.get("count", 0):
            if len(items) < data.get("count", 0):
                sys.exit("Respuesta incompleta de Bsale: no se actualiza el archivo")
            return items


def norm_rut(rut):
    return re.sub(r"[^0-9K]", "", (rut or "").upper()).lstrip("0")


def nombre_de(ficha):
    company = (ficha.get("company") or "").strip()
    return company or f"{(ficha.get('firstName') or '').strip()} {(ficha.get('lastName') or '').strip()}".strip()


def palabras(texto):
    return {t for t in re.findall(r"\w+", texto.lower()) if len(t) > 2 and t not in ("spa", "eirl", "ltda")}


def contacto(ficha):
    """Correo y telefono solo en memoria, para detectar fichas repetidas."""
    correo = (ficha.get("email") or "").strip().lower()
    telefono = re.sub(r"\D", "", ficha.get("phone") or "")[-8:]
    return (correo, telefono) if "@" in correo and len(telefono) == 8 else None


def fecha_chile(ts):
    return (dt.datetime.fromtimestamp(ts, dt.timezone.utc) - dt.timedelta(hours=3)).date()


def fecha_doc(ts):
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).date()


def calcular(fichas, documentos, hoy):
    """documentos: {tipo: [documentos activos de Bsale]}"""
    cuentas = collections.defaultdict(lambda: {"fichas": [], "docs": collections.defaultdict(list)})
    clave_de = {}
    for f in fichas:
        rut = norm_rut(f.get("code"))
        clave = rut if rut not in RUT_GENERICOS and len(rut) >= 7 else f"id{f['id']}"
        clave_de[str(f["id"])] = clave
        cuentas[clave]["fichas"].append(f)
    for tipo, docs in documentos.items():
        for d in docs:
            clave = clave_de.get(str((d.get("client") or {}).get("id") or ""))
            if clave and d.get("state") == 0:
                cuentas[clave]["docs"][tipo].append(d)

    filas = []
    for q in cuentas.values():
        con_fecha = [f for f in q["fichas"] if f.get("createdAt")]
        if not con_fecha:
            continue
        alta = fecha_chile(min(f["createdAt"] for f in con_fecha))
        if alta <= CARGA_INICIAL_HASTA or alta < DESDE:
            continue
        if not any(q["docs"].values()) and all(f.get("state") == 97 for f in q["fichas"]):
            continue

        orden = lambda d: (d["emissionDate"], d["id"])
        cot = sorted(q["docs"][COTIZACION], key=orden)
        ven = sorted((d for t in VENTAS for d in q["docs"][t]), key=orden)
        monto = lambda d: d.get("netAmount") or d.get("totalAmount") or 0
        venta_neta = sum(map(monto, ven)) - sum(map(monto, q["docs"][NOTA_CREDITO]))
        compro = bool(ven) and venta_neta > 1000
        primera_cot = fecha_doc(cot[0]["emissionDate"]) if cot else None
        primera_venta = fecha_doc(ven[0]["emissionDate"]) if compro else None

        if cot and compro and primera_cot <= primera_venta:
            estado = "cotizo_compro"
        elif compro:
            estado = "compro_sin_cotizar"
        elif cot and ven:
            estado = "compra_anulada"
        elif cot:
            reciente = (hoy - fecha_doc(cot[-1]["emissionDate"])).days <= EN_PLAZO_DIAS
            estado = "en_plazo" if reciente else "cotizo_no_compro"
        else:
            estado = "venta_anulada" if ven else "seguimiento"

        vigente = max(q["fichas"], key=lambda f: (f.get("state") == 0, f.get("createdAt") or 0))
        filas.append({
            "fila": {
                "c": str(vigente["id"]), "a": alta.isoformat(), "e": estado,
                "q": [[d.get("number"), fecha_doc(d["emissionDate"]).isoformat(), d.get("totalAmount")] for d in cot],
                "p": primera_venta.isoformat() if primera_venta else None,
                "m": ven[0].get("totalAmount") if compro else None,
            },
            "alta": alta, "nombre": palabras(nombre_de(vigente)),
            "contactos": {contacto(f) for f in q["fichas"]} - {None},
        })

    def repetida(r):
        return r["fila"]["e"] == "seguimiento" and any(
            o is not r and o["fila"]["e"] != "seguimiento" and abs((o["alta"] - r["alta"]).days) <= 3
            and ((len(r["nombre"]) >= 2 and r["nombre"] <= o["nombre"]) or r["contactos"] & o["contactos"])
            for o in filas)

    finales = [r["fila"] for r in filas if not repetida(r)]
    finales.sort(key=lambda f: (f["a"], int(f["c"])))
    return finales, len(filas) - len(finales)


def main():
    if not TOKEN:
        sys.exit("Falta BSALE_TOKEN")
    fichas = []
    for estado in (0, 1, 3, 97):
        fichas += paginar(f"{BASE_URL}/clients.json?state={estado}")
    documentos = {t: paginar(f"{BASE_URL}/documents.json?documenttypeid={t}")
                  for t in (COTIZACION, *VENTAS, NOTA_CREDITO)}
    ahora = dt.datetime.now(dt.timezone.utc)
    filas, repetidas = calcular(fichas, documentos, (ahora - dt.timedelta(hours=3)).date())
    if not filas or not documentos[COTIZACION]:
        sys.exit("Sin datos: no se actualiza el archivo")
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump({"updated_at": ahora.strftime("%Y-%m-%dT%H:%M:%SZ"), "rows": filas}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"altas.json: {len(filas)} cuentas nuevas | {repetidas} fichas repetidas sin movimientos no contadas")
    print("por estado:", dict(collections.Counter(f["e"] for f in filas)))


if __name__ == "__main__":
    main()
