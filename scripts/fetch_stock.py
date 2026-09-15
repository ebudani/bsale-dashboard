"""
fetch_stock.py  -  Bsale current stock snapshot for the Stock page.

Unlike fetch_data.py this has no historical dimension -- stock is a
point-in-time snapshot, so every run just overwrites data/stock.json with
whatever Bsale reports right now.

Usage: python fetch_stock.py
"""

import os
import json
import datetime
import time
import urllib.request
import urllib.error

TOKEN = os.environ.get("BSALE_TOKEN", "")
BASE_URL = "https://api.bsale.io/v1"
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
OUT_FILE = os.path.join(DATA_DIR, "stock.json")
HEADERS = {"access_token": TOKEN}


def get_json(url, retries=5):
    req = urllib.request.Request(url, headers=HEADERS)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            if attempt == retries - 1:
                raise
            wait = 2 ** attempt
            print(f"\n  [retry] {url} -> {e} (intento {attempt+1}/{retries}, esperando {wait}s)", flush=True)
            time.sleep(wait)


def fetch_stock():
    """Returns a list of {sku, code, office_id, office_name, quantity,
    quantity_available, quantity_reserved}, one row per variant+office."""
    items = []
    offset = 0
    while True:
        data = get_json(f"{BASE_URL}/stocks.json?limit=50&offset={offset}&expand=[office,variant]")
        page = data.get("items", [])
        if not page:
            break
        for it in page:
            variant = it.get("variant") or {}
            office = it.get("office") or {}
            items.append({
                "sku": variant.get("description") or f"Variante {variant.get('id')}",
                "code": variant.get("code", ""),
                "office_id": office.get("id"),
                "office_name": (office.get("name") or "").strip(),
                "quantity": it.get("quantity", 0),
                "quantity_available": it.get("quantityAvailable", 0),
                "quantity_reserved": it.get("quantityReserved", 0),
            })
        if offset + 50 >= data.get("count", 0):
            break
        offset += 50
    return items


def main():
    print("Fetching stock...", end=" ", flush=True)
    items = fetch_stock()
    print(f"{len(items)} registros")

    output = {
        "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "items": items,
    }
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"Saved -> {OUT_FILE}")


if __name__ == "__main__":
    main()
