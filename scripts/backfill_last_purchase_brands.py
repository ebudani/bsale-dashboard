"""
One-off catch-up for data/ventas.json's "last_purchase_brands": the Teoxane /
RRS breakdown of each client's most recent positive-neto month, for the
"Cartera en riesgo" view's "how big was that purchase" column.

Going forward this self-maintains for free: fetch_data.py's daily run
already computes the brand breakdown for every client in the current month
(by_client_brand), so it updates last_purchase_brands itself whenever a
client's current-month neto is positive. This script only needs to run once
(or whenever there's a gap) to backfill clients whose last purchase was
before this feature existed -- narrowly, by fetching just that one month's
documents per client (via the clientid filter), not the whole history.

Usage: BSALE_TOKEN=... python scripts/backfill_last_purchase_brands.py
"""
import calendar
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


def get(path, params=None, retries=5):
    for attempt in range(retries):
        res = requests.get(BASE + path, headers=HEADERS, params=params, timeout=30)
        if res.status_code == 429:
            time.sleep(2 ** attempt)
            continue
        res.raise_for_status()
        return res.json()
    res.raise_for_status()


def month_range_ts(month_key):
    year, month = map(int, month_key.split("-"))
    start = calendar.timegm(datetime.datetime(year, month, 1).timetuple())
    last_day = calendar.monthrange(year, month)[1]
    end = calendar.timegm(datetime.datetime(year, month, last_day, 23, 59, 59).timetuple())
    return start, end


def fetch_client_month_docs(cid, month_key):
    start, end = month_range_ts(month_key)
    data = get("/documents.json", {
        "clientid": cid, "state": 0, "limit": 50,
        "emissiondaterange": f"[{start},{end}]",
    })
    return [d for d in data.get("items", []) if int(d["document_type"]["id"]) in (TIPO_FACTURA | TIPO_EXENTA | TIPO_NC)]


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
    with open(OUT_FILE, encoding="utf-8") as f:
        ventas = json.load(f)

    client_activity = ventas.get("client_activity", {})
    existing = ventas.get("last_purchase_brands", {})

    todo = {}  # cid -> last positive month_key
    for cid, months in client_activity.items():
        positive = sorted(mk for mk, v in months.items() if v and v > 0)
        if not positive:
            continue
        last_month = positive[-1]
        if existing.get(cid, {}).get("month") == last_month:
            continue  # already have it for the right month
        todo[cid] = last_month

    print(f"Clientes a completar: {len(todo)} (de {len(client_activity)} con actividad)")

    def process(cid):
        month_key = todo[cid]
        docs = fetch_client_month_docs(cid, month_key)
        totals = {b: 0 for b in BRANDS}
        for d in docs:
            type_id = int(d["document_type"]["id"])
            sign = -1 if type_id in TIPO_NC else 1
            doc_totals = fetch_doc_brand_totals(d["id"])
            for b in BRANDS:
                totals[b] += sign * doc_totals[b]
        return cid, month_key, totals

    done = 0
    with cf.ThreadPoolExecutor(max_workers=15) as ex:
        futures = [ex.submit(process, cid) for cid in todo]
        for fut in cf.as_completed(futures):
            cid, month_key, totals = fut.result()
            existing[cid] = {
                "month": month_key,
                "Teoxane": round(totals["Teoxane"]),
                "RRS HA Long Lasting": round(totals["RRS HA Long Lasting"]),
            }
            done += 1
            if done % 25 == 0 or done == len(todo):
                print(f"\r  {done}/{len(todo)}", end="", flush=True)
    print()

    ventas["last_purchase_brands"] = existing
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(ventas, f, ensure_ascii=False, indent=2)
    print(f"Guardado last_purchase_brands para {len(existing)} clientes -> {OUT_FILE}")


if __name__ == "__main__":
    main()
