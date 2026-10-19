"""
fetch_info_bsale.py - cuentas de Bsale SIN direccion cargada, para el boton "Info Bsale".

Para cada cliente activo con al menos una venta (factura 5 o exenta 15):
  - Direccion de facturacion  = campos address / municipality / city de la ficha
                                (pestana "Informacion basica").
  - Direcciones del cliente   = coleccion addresses (pestana "Direcciones"); solo las
                                activas (state 0) y con texto en "address".
  - Fecha de ultima venta     = mayor emissionDate de sus facturas/exentas.

Guarda en data/info_bsale.json SOLO las cuentas que no tienen ninguna direccion en
"Direcciones del cliente", de la venta mas reciente a la mas antigua. Asi el archivo
publico no lleva direcciones de las cuentas que ya estan completas.

Uso: BSALE_TOKEN=... python scripts/fetch_info_bsale.py
Si algo falla NO toca el archivo existente.
"""
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

TOKEN = os.environ.get("BSALE_TOKEN", "")
BASE_URL = "https://api.bsale.io/v1"
OUT_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "info_bsale.json")
HEADERS = {"access_token": TOKEN}
SALE_TYPES = {"5", "15"}  # factura electronica y factura exenta (las notas de credito no cuentan como venta)


def get_json(url, retries=5):
    """Reintenta 429, 5xx y cortes de red; un 4xx (distinto de 429) se propaga enseguida."""
    req = urllib.request.Request(url, headers=HEADERS)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429 and e.code < 500:
                raise
            err = e
        except (urllib.error.URLError, TimeoutError) as e:
            err = e
        if attempt == retries - 1:
            raise err
        wait = 2 ** attempt
        print(f"  [retry] {url} -> {err} (intento {attempt + 1}/{retries}, espera {wait}s)", flush=True)
        time.sleep(wait)


def fetch_active_clients():
    """Clientes activos (state 0). Intenta traer addresses expandido; si Bsale lo rechaza, sin expandir."""
    for expand in ("&expand=[addresses]", ""):
        clients, offset = [], 0
        try:
            while True:
                data = get_json(f"{BASE_URL}/clients.json?limit=50&offset={offset}&state=0{expand}")
                items = data.get("items", [])
                if not items:
                    break
                clients.extend(items)
                if offset + 50 >= data.get("count", 0):
                    break
                offset += 50
            return clients, bool(expand)
        except urllib.error.HTTPError as e:
            if expand and e.code in (400, 422):
                print(f"  expand=[addresses] rechazado ({e.code}); sigo sin expandir", flush=True)
                continue
            raise
    return [], False


def last_sale_by_client():
    """{client_id: emissionDate (unix)} de la ultima factura/exenta de cada cliente."""
    last, offset = {}, 0
    while True:
        data = get_json(f"{BASE_URL}/documents.json?state=0&limit=50&offset={offset}&expand=[client]")
        items = data.get("items", [])
        if not items:
            break
        for d in items:
            if str((d.get("document_type") or {}).get("id", "")) not in SALE_TYPES:
                continue
            cid = str((d.get("client") or {}).get("id", ""))
            ts = d.get("emissionDate", 0)
            if cid and ts > last.get(cid, 0):
                last[cid] = ts
        offset += 50
        if offset >= data.get("count", 0):
            break
    return last


def active_addresses(items):
    """Direcciones activas con texto, a partir de la lista de entradas de 'addresses'."""
    return [a for a in items if a.get("state", 0) == 0 and (a.get("address") or "").strip()]


def addresses_from_node(node):
    """Lista de entradas si 'addresses' viene expandido; None si Bsale solo mando el link."""
    if isinstance(node, dict) and isinstance(node.get("items"), list):
        return node["items"]
    return None


def fetch_client_addresses(cid):
    data = get_json(f"{BASE_URL}/clients/{cid}/addresses.json?limit=50")
    return data.get("items", [])


def contact_name(first, last, name):
    first, last = (first or "").strip(), (last or "").strip()
    full = f"{first} {last}".strip()
    if not full or first == last or full.lower() == (name or "").strip().lower():
        return ""
    return full


def billing_address(c):
    parts = [(c.get("address") or "").strip(), (c.get("municipality") or "").strip(), (c.get("city") or "").strip()]
    return ", ".join(p for p in parts if p)


def build_accounts(clients, last_sales, has_address):
    """Cuentas con venta y sin direccion, ordenadas de la venta mas reciente a la mas antigua."""
    rows = []
    for c in clients:
        cid = str(c["id"])
        if cid not in last_sales or has_address.get(cid, False):
            continue
        company = (c.get("company") or "").strip()
        first, last = (c.get("firstName") or "").strip(), (c.get("lastName") or "").strip()
        name = company if company else f"{first} {last}".strip()
        rows.append({
            "id": cid,
            "name": name,
            "rut": c.get("code") or "",
            "contact": contact_name(first, last, name),
            "phone": (c.get("phone") or "").strip(),
            "billing_address": billing_address(c),
            "last_sale": datetime.datetime.fromtimestamp(last_sales[cid], datetime.timezone.utc).strftime("%Y-%m-%d"),
            "_ts": last_sales[cid],
        })
    rows.sort(key=lambda r: r["_ts"], reverse=True)
    for r in rows:
        del r["_ts"]
    return rows


def main():
    if not TOKEN:
        sys.exit("Falta BSALE_TOKEN")
    print("Clientes activos...", flush=True)
    clients, expanded = fetch_active_clients()
    print(f"  {len(clients)} clientes (addresses expandido: {expanded})", flush=True)

    print("Ultima venta por cliente...", flush=True)
    last_sales = last_sale_by_client()
    candidates = [c for c in clients if str(c["id"]) in last_sales]
    print(f"  {len(last_sales)} clientes con ventas; {len(candidates)} activos", flush=True)

    has_address, pending = {}, []
    for c in candidates:
        items = addresses_from_node(c.get("addresses"))
        if items is None:
            pending.append(c)
        else:
            has_address[str(c["id"])] = bool(active_addresses(items))
    if pending:
        print(f"  consultando direcciones una por una para {len(pending)} clientes...", flush=True)
        with ThreadPoolExecutor(max_workers=6) as ex:
            for c, items in zip(pending, ex.map(lambda c: fetch_client_addresses(c["id"]), pending)):
                has_address[str(c["id"])] = bool(active_addresses(items))

    accounts = build_accounts(candidates, last_sales, has_address)
    out = {
        "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "accounts_with_sales": len(candidates),
        "accounts_without_address": len(accounts),
        "accounts": accounts,
    }
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"Guardado {OUT_FILE}: {len(accounts)} de {len(candidates)} cuentas con venta no tienen direccion.")


if __name__ == "__main__":
    main()
