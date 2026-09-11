"""
One-off/rerunnable backfill for data/ventas.json's "client_activity" and
"client_vendor" fields (added so the "Cartera en riesgo" view can tell,
for every client -- not just each month's top 15 -- whether they bought
this month/last month/ever).

Unlike fetch_data.py this does NOT fetch per-document line-item details
(no brand/SKU breakdown needed here), so it can pull full history via
concurrent requests in well under a minute instead of a full slow rerun
of the brand-detail backfill. It only touches client_activity/client_vendor
in ventas.json -- the existing "months" records (brand/productivity/top
clients, all already correct) are left untouched.

Usage: BSALE_TOKEN=... python scripts/backfill_client_activity.py
"""
import concurrent.futures as cf
import datetime
import json
import os
import time

import requests

TOKEN = os.environ.get("BSALE_TOKEN", "")
BASE = "https://api.bsale.cl/v1"
HEADERS = {"access_token": TOKEN}
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
OUT_FILE = os.path.join(DATA_DIR, "ventas.json")
VENDORS_FILE = os.path.join(DATA_DIR, "vendedores.json")

TIPO_FACTURA = {5}
TIPO_EXENTA = {15}
TIPO_NC = {2}


def get(path, params=None):
    for attempt in range(5):
        res = requests.get(BASE + path, headers=HEADERS, params=params, timeout=30)
        if res.status_code == 429:
            time.sleep(2 ** attempt)
            continue
        res.raise_for_status()
        return res.json()
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


def main():
    with open(VENDORS_FILE, encoding="utf-8") as f:
        rut_to_vendor = json.load(f)
    rut_to_vendor.pop("_note", None)
    # vendedores.json carries the literal string "nan" for RUTs whose VENDEDOR
    # cell was blank in the source spreadsheet -- not a real assignment.
    rut_to_vendor = {r: v for r, v in rut_to_vendor.items() if str(v).strip().lower() != "nan"}

    print("Fetching clients...")
    clients = get_all("/clients.json")
    client_vendor = {}
    for c in clients:
        rut = (c.get("code") or "").strip()
        if rut in rut_to_vendor:
            client_vendor[str(c["id"])] = rut_to_vendor[rut]
    print(f"  {len(clients)} clients, {len(client_vendor)} mapped to a vendor")

    print("Fetching documents (facturas/exentas/NC, active)...")
    documents = get_all("/documents.json", {"state": 0, "expand": "[client]"})
    print(f"  {len(documents)} active documents")

    client_activity = {}
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
        cid = str(client["id"])
        dt = datetime.datetime.utcfromtimestamp(d["emissionDate"])
        month_key = f"{dt.year}-{dt.month:02d}"
        bucket = client_activity.setdefault(cid, {})
        bucket[month_key] = bucket.get(month_key, 0) + sign * d.get("netAmount", 0)

    for cid in client_activity:
        for mk in client_activity[cid]:
            client_activity[cid][mk] = round(client_activity[cid][mk])

    with open(OUT_FILE, encoding="utf-8") as f:
        ventas = json.load(f)
    ventas["client_activity"] = client_activity
    ventas["client_vendor"] = client_vendor
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(ventas, f, ensure_ascii=False, indent=2)

    n_months = sum(len(v) for v in client_activity.values())
    print(f"Saved client_activity for {len(client_activity)} clients ({n_months} client-months) -> {OUT_FILE}")


if __name__ == "__main__":
    main()
