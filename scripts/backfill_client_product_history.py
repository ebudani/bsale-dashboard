"""
One-off backfill for data/ventas.json's "client_product_history": the
Teoxane / RRS / neto breakdown of EVERY month for EVERY client (not just
the most recent one, unlike last_purchase_brands) -- feeds the "Historico
por Cliente" card (por año de cada producto, mes a mes vs el año anterior).

Unlike backfill_last_purchase_brands.py (which only fetches each client's
most recent month of documents) this fetches line-item details for ALL
active documents, so it's slower -- but only needs to run once; going
forward fetch_data.py's daily run updates the current month for free
(by_client_brand is already computed there for every client).

Usage: BSALE_TOKEN=... python scripts/backfill_client_product_history.py
"""
import concurrent.futures as cf
import datetime
import json
import os
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(__file__))
from fetch_data import classify_brand  # noqa: E402

TOKEN = os.environ.get("BSALE_TOKEN", "")
BASE = "https://api.bsale.cl/v1"
HEADERS = {"access_token": TOKEN}
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
OUT_FILE = os.path.join(DATA_DIR, "ventas.json")

TIPO_FACTURA = {5}
TIPO_EXENTA = {15}
TIPO_NC = {2}
BRANDS = ["Teoxane", "RRS HA Long Lasting"]


def get(path, params=None, retries=6):
    """
    Retries both HTTP 429 and transport-level failures (connection reset,
    timeout) -- a burst of concurrent detail requests is exactly what
    triggered a ConnectionResetError from Bsale's end partway through the
    first run, which an earlier version of this only caught for 429 and let
    crash the whole backfill with nothing saved (it only writes at the end).
    """
    last_exc = None
    for attempt in range(retries):
        try:
            res = requests.get(BASE + path, headers=HEADERS, params=params, timeout=30)
        except requests.exceptions.RequestException as e:
            last_exc = e
            time.sleep(min(2 ** attempt, 30))
            continue
        if res.status_code == 429:
            time.sleep(min(2 ** attempt, 30))
            continue
        res.raise_for_status()
        return res.json()
    if last_exc:
        raise last_exc
    res.raise_for_status()


def get_all(path, params=None, limit=50, concurrency=20):
    params = dict(params or {})
    params["limit"] = limit
    params["offset"] = 0
    first = get(path, params)
    items = list(first["items"])
    count = first["count"]
    offsets = list(range(limit, count, limit))

    def fetch(offset):
        p = dict(params)
        p["offset"] = offset
        return get(path, p)["items"]

    with cf.ThreadPoolExecutor(max_workers=concurrency) as ex:
        for batch in ex.map(fetch, offsets):
            items.extend(batch)
    return items


def fetch_doc_brand_totals(doc_id):
    totals = {b: 0 for b in BRANDS}
    offset = 0
    while True:
        data = get(f"/documents/{doc_id}/details.json", {"limit": 50, "offset": offset})
        items = data.get("items", [])
        for item in items:
            variant = item.get("variant") or {}
            variant_id = variant.get("id")
            if variant_id is None:
                continue
            sku_name = variant.get("description") or ""
            brand = classify_brand(variant_id, sku_name)
            if brand in totals:
                totals[brand] += item.get("netAmount", 0)
        offset += len(items)
        if offset >= data.get("count", 0) or not items:
            break
    return totals


def main():
    print("Fetching documents (facturas/exentas/NC, active)...")
    documents = get_all("/documents.json", {"state": 0, "expand": "[client]"})
    docs = []
    for d in documents:
        type_id = int(d["document_type"]["id"])
        if type_id in TIPO_FACTURA or type_id in TIPO_EXENTA:
            sign = 1
        elif type_id in TIPO_NC:
            sign = -1
        else:
            continue
        client = d.get("client")
        if not client:
            continue
        docs.append((d, sign))
    print(f"  {len(docs)} documentos de venta/NC a procesar (de {len(documents)} activos)")

    history = {}  # cid -> month_key -> {neto, Teoxane, RRS HA Long Lasting}

    def process(item):
        d, sign = item
        cid = str(d["client"]["id"])
        dt = datetime.datetime.utcfromtimestamp(d["emissionDate"])
        month_key = f"{dt.year}-{dt.month:02d}"
        brand_totals = fetch_doc_brand_totals(d["id"])
        return cid, month_key, sign * d.get("netAmount", 0), {b: sign * brand_totals[b] for b in BRANDS}

    def checkpoint():
        rounded = {
            cid: {mk: {k: round(v) for k, v in vals.items()} for mk, vals in months.items()}
            for cid, months in history.items()
        }
        with open(OUT_FILE, encoding="utf-8") as f:
            ventas = json.load(f)
        ventas["client_product_history"] = rounded
        with open(OUT_FILE, "w", encoding="utf-8") as f:
            json.dump(ventas, f, ensure_ascii=False, indent=2)

    done = 0
    failed = 0
    # 15 en vez de 25 -- la corrida anterior corto la conexion a mitad de
    # camino con 25 en paralelo, probablemente porque Bsale le puso un
    # freno a la rafaga. Ademas guarda un checkpoint cada 300 documentos:
    # si se vuelve a cortar, el progreso ya hecho queda guardado en vez de
    # perderse todo (antes solo escribia el archivo al final).
    with cf.ThreadPoolExecutor(max_workers=15) as ex:
        futures = [ex.submit(process, item) for item in docs]
        for fut in cf.as_completed(futures):
            try:
                cid, month_key, neto, brand_vals = fut.result()
            except Exception as e:
                failed += 1
                print(f"\n  [fallo] {e}")
                continue
            bucket = history.setdefault(cid, {}).setdefault(
                month_key, {"neto": 0, "Teoxane": 0, "RRS HA Long Lasting": 0}
            )
            bucket["neto"] += neto
            for b in BRANDS:
                bucket[b] += brand_vals[b]
            done += 1
            if done % 100 == 0 or done == len(docs):
                print(f"\r  {done}/{len(docs)} (fallos: {failed})", end="", flush=True)
            if done % 300 == 0:
                checkpoint()
    print()

    checkpoint()
    n_months = sum(len(v) for v in history.values())
    print(f"Guardado client_product_history para {len(history)} clientes ({n_months} client-meses, {failed} documentos fallidos) -> {OUT_FILE}")


if __name__ == "__main__":
    main()
