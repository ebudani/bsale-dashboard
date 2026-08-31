"""
fetch_data.py  -  Bsale data fetcher for AestheticsPro dashboard

Block structure of /documents.json (ordered by internal ID, grouped by type):
  Offsets 0-2128:    Cotizaciones (24), NC (2), Exentas (15), Boletas (22)
  Offsets 2129-3099: Guias de despacho (7)
  Offsets 3100-5058: Facturas electronicas (5)

Net sales = facturas + exentas - NC

Modes:
  python fetch_data.py              # daily: refreshes current month only
  python fetch_data.py --backfill   # one-time: fetches Jan 2025 to today
  python fetch_data.py --backfill --from 2025-01
"""

import os
import json
import calendar
import datetime
import urllib.request
import argparse

TOKEN = os.environ.get("BSALE_TOKEN", "")
BASE_URL = "https://api.bsale.io/v1"
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
OUT_FILE = os.path.join(DATA_DIR, "ventas.json")
VENDORS_FILE = os.path.join(DATA_DIR, "vendedores.json")
HEADERS = {"access_token": TOKEN}

TIPO_FACTURA = {"5"}
TIPO_EXENTA  = {"15"}
TIPO_NC      = {"2"}

# Facturas electronicas are the newest document type adopted, so they occupy
# a suffix of /documents.json starting at this offset (stable historically).
# The end of that suffix is NOT fixed here -- it grows with every new factura,
# so it's fetched fresh each run via get_total_document_count() in main().
FACT_BLOCK_START = 3100
NC_BLOCK_START   = 0
NC_BLOCK_END     = 2128

# variant_id -> brand name (hardcoded from product catalog)
VARIANT_TO_BRAND = {
    68:  "RRS HA Long Lasting",
    94:  "Teoxane", 95:  "Teoxane", 96:  "Teoxane", 97:  "Teoxane",
    98:  "Teoxane", 112: "Teoxane", 135: "Teoxane", 136: "Teoxane", 137: "Teoxane",
    100: "FINE", 101: "FINE", 113: "FINE",
}
ALL_BRANDS = ["Teoxane", "RRS HA Long Lasting", "FINE"]


def get_json(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req) as r:
        return json.load(r)


# -- Metadata ------------------------------------------------------------------

def fetch_users():
    """Returns {user_id_str: "Nombre Apellido"}."""
    data = get_json(f"{BASE_URL}/users.json?limit=50")
    users = {}
    for u in data.get("items", []):
        name = f"{u.get('firstName','').strip()} {u.get('lastName','').strip()}".strip()
        users[str(u["id"])] = name
    return users


def load_rut_to_vendor():
    """Loads RUT -> vendor_name mapping from data/vendedores.json."""
    if os.path.exists(VENDORS_FILE):
        with open(VENDORS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def build_client_to_vendor(clients_meta, rut_to_vendor):
    """Returns {client_id_str: vendor_name} using RUT-based lookup."""
    result = {}
    for cid, info in clients_meta.items():
        rut = (info.get("rut") or "").strip()
        if rut in rut_to_vendor:
            result[cid] = rut_to_vendor[rut]
    return result


def fetch_clients():
    """Returns {client_id_str: {name, rut}}. Fetches all pages."""
    clients = {}
    offset = 0
    while True:
        data = get_json(f"{BASE_URL}/clients.json?limit=50&offset={offset}")
        items = data.get("items", [])
        if not items:
            break
        for c in items:
            cid = str(c["id"])
            company = (c.get("company") or "").strip()
            first   = (c.get("firstName") or "").strip()
            last    = (c.get("lastName") or "").strip()
            name    = company if company else f"{first} {last}".strip()
            clients[cid] = {"name": name, "rut": c.get("code", "")}
        if offset + 50 >= data.get("count", 0):
            break
        offset += 50
    return clients


# -- Document fetching ---------------------------------------------------------

def date_at_offset(offset, block_end):
    if offset > block_end:
        return 99999999999
    data = get_json(f"{BASE_URL}/documents.json?limit=1&offset={offset}")
    items = data.get("items", [])
    return items[0]["emissionDate"] if items else 99999999999


def get_total_document_count():
    """
    Total documents currently in the account. Facturas electronicas are the
    newest/last block in /documents.json, so this IS the true upper bound of
    that block -- it grows every time a new factura is issued. Fetching it
    fresh on every run keeps recently-issued facturas from silently falling
    outside the search range as the document count grows.
    """
    data = get_json(f"{BASE_URL}/documents.json?limit=1&offset=0")
    return data.get("count", 0)


def fetch_facturas_for_month(year, month, fact_block_end):
    """Binary search + paginated fetch within the facturas block."""
    start_ts = calendar.timegm(datetime.datetime(year, month, 1, 0, 0, 0).timetuple())
    last_day = calendar.monthrange(year, month)[1]
    end_ts = calendar.timegm(datetime.datetime(year, month, last_day, 23, 59, 59).timetuple())

    lo, hi = FACT_BLOCK_START, fact_block_end
    while lo < hi:
        mid = (lo + hi) // 2
        if date_at_offset(mid, fact_block_end) < start_ts:
            lo = mid + 1
        else:
            hi = mid
    s_off = lo

    lo2, hi2 = s_off, fact_block_end
    while lo2 < hi2:
        mid = (lo2 + hi2 + 1) // 2
        if date_at_offset(mid, fact_block_end) <= end_ts:
            lo2 = mid
        else:
            hi2 = mid - 1
    e_off = lo2

    docs = []
    off = s_off
    while off <= e_off:
        limit = min(50, e_off - off + 1)
        data = get_json(f"{BASE_URL}/documents.json?limit={limit}&offset={off}")
        for d in data.get("items", []):
            if (
                start_ts <= d.get("emissionDate", 0) <= end_ts
                and d.get("document_type", {}).get("id") in TIPO_FACTURA
            ):
                docs.append(d)
        off += limit
    return docs


def scan_nc_and_exentas_all_months():
    """
    Full scan of the NC block (0-2128).
    Returns {(year, month): {"nc": [...], "exenta": [...]}}
    NC internal IDs are not correlated with cotizacion date ordering.
    """
    by_month = {}
    print("  Scanning NC/exenta block...", end=" ", flush=True)
    for off in range(NC_BLOCK_START, NC_BLOCK_END + 1, 50):
        limit = min(50, NC_BLOCK_END - off + 1)
        data = get_json(f"{BASE_URL}/documents.json?limit={limit}&offset={off}")
        for d in data.get("items", []):
            tid = d.get("document_type", {}).get("id", "")
            if tid not in TIPO_NC and tid not in TIPO_EXENTA:
                continue
            ts = d.get("emissionDate", 0)
            dt = datetime.datetime.utcfromtimestamp(ts)
            key = (dt.year, dt.month)
            by_month.setdefault(key, {"nc": [], "exenta": []})
            if tid in TIPO_NC:
                by_month[key]["nc"].append(d)
            else:
                by_month[key]["exenta"].append(d)
    total = sum(len(v["nc"]) + len(v["exenta"]) for v in by_month.values())
    print(f"done ({total} docs)")
    return by_month


def fetch_document_details(doc_id):
    """
    Returns {"by_brand": {brand: {"neto","qty"}}, "by_sku": {product_name: {"neto","qty"}}}
    for ALL line items of a document (handles pagination). by_sku uses Bsale's own
    "Producto / Servicio" description (the variant's description field), independent
    of the hardcoded brand mapping.
    """
    try:
        brand_totals = {}
        sku_totals = {}
        offset = 0
        while True:
            data = get_json(
                f"{BASE_URL}/documents/{doc_id}/details.json?limit=50&offset={offset}"
            )
            items = data.get("items", [])
            count = data.get("count", 0)
            for item in items:
                variant = item.get("variant") or {}
                variant_id = variant.get("id")
                if variant_id is None:
                    continue
                neto = item.get("netAmount", 0)
                qty = item.get("quantity", 0)

                brand = VARIANT_TO_BRAND.get(variant_id, "Otros")
                bt = brand_totals.setdefault(brand, {"neto": 0, "qty": 0})
                bt["neto"] += neto
                bt["qty"] += qty

                sku_name = variant.get("description") or f"Variante {variant_id}"
                st = sku_totals.setdefault(sku_name, {"neto": 0, "qty": 0})
                st["neto"] += neto
                st["qty"] += qty
            offset += len(items)
            if offset >= count or not items:
                break
        return {"by_brand": brand_totals, "by_sku": sku_totals}
    except Exception:
        return {"by_brand": {}, "by_sku": {}}


def fetch_brand_details(facturas, exenta_docs, nc_docs):
    """
    Fetches line-item details for all documents.
    Returns {doc_id: {"by_brand": {brand: {"neto","qty"}}, "by_sku": {product: {"neto","qty"}}}}
    Facturas/exentas -> positive; NCs -> negative.
    """
    all_docs = list(facturas) + list(exenta_docs) + list(nc_docs)
    nc_ids = {d["id"] for d in nc_docs}
    total = len(all_docs)
    brand_details = {}

    def negate(totals):
        return {k: {"neto": -v["neto"], "qty": -v["qty"]} for k, v in totals.items()}

    for i, d in enumerate(all_docs, 1):
        if i % 20 == 0 or i == total:
            print(f"\r    details {i}/{total}...", end="", flush=True)
        raw = fetch_document_details(d["id"])
        if d["id"] in nc_ids:
            brand_details[d["id"]] = {
                "by_brand": negate(raw["by_brand"]),
                "by_sku": negate(raw["by_sku"]),
            }
        else:
            brand_details[d["id"]] = raw

    if total > 0:
        print()
    return brand_details


# -- Aggregation ---------------------------------------------------------------

def build_month_record(year, month, facturas, nc_docs, exenta_docs, clients_meta,
                       brand_details=None, client_to_vendor=None):
    neto_facturas = sum(d.get("netAmount", 0) for d in facturas + exenta_docs)
    neto_nc       = sum(d.get("netAmount", 0) for d in nc_docs)
    total_neto    = neto_facturas - neto_nc

    def vendor_for(doc):
        """Resolve vendor name: client's assigned vendor, else fallback label."""
        cid = str((doc.get("client") or {}).get("id", ""))
        if client_to_vendor and cid in client_to_vendor:
            return client_to_vendor[cid]
        return "Sin asignar"

    # By day (total and per vendor)
    by_day = {}
    by_vendor_day = {}
    for d in facturas + exenta_docs:
        dia = datetime.datetime.utcfromtimestamp(d["emissionDate"]).strftime("%Y-%m-%d")
        by_day.setdefault(dia, {"count": 0, "neto": 0})
        by_day[dia]["count"] += 1
        by_day[dia]["neto"] += d.get("netAmount", 0)

        vname = vendor_for(d)
        by_vendor_day.setdefault(vname, {})
        by_vendor_day[vname].setdefault(dia, {"count": 0, "neto": 0})
        by_vendor_day[vname][dia]["count"] += 1
        by_vendor_day[vname][dia]["neto"] += d.get("netAmount", 0)

    # By vendor (keyed by vendor name from client assignment)
    by_vendor = {}
    for d in facturas + exenta_docs:
        vname = vendor_for(d)
        by_vendor.setdefault(vname, {"count": 0, "neto": 0})
        by_vendor[vname]["count"] += 1
        by_vendor[vname]["neto"] += d.get("netAmount", 0)
    for d in nc_docs:
        vname = vendor_for(d)
        by_vendor.setdefault(vname, {"count": 0, "neto": 0})
        by_vendor[vname]["neto"] -= d.get("netAmount", 0)

    # By brand, by vendor+brand, by SKU ("Producto / Servicio") and by vendor+SKU
    by_brand = {b: 0 for b in ALL_BRANDS}
    by_vendor_brand = {}
    by_sku = {}
    by_vendor_sku = {}

    if brand_details:
        for d in facturas + exenta_docs + nc_docs:
            vname = vendor_for(d)
            doc_details = brand_details.get(d["id"], {})

            by_vendor_brand.setdefault(vname, {b: 0 for b in ALL_BRANDS})
            for brand, vals in doc_details.get("by_brand", {}).items():
                if brand in by_brand:
                    by_brand[brand] += vals["neto"]
                    by_vendor_brand[vname][brand] = by_vendor_brand[vname].get(brand, 0) + vals["neto"]

            by_vendor_sku.setdefault(vname, {})
            for sku, vals in doc_details.get("by_sku", {}).items():
                by_sku[sku] = by_sku.get(sku, 0) + vals["neto"]
                by_vendor_sku[vname][sku] = by_vendor_sku[vname].get(sku, 0) + vals["neto"]

    # Top clients (total and per vendor), including neto + units by brand
    def empty_brand_totals():
        return {"Teoxane": {"neto": 0, "qty": 0}, "RRS HA Long Lasting": {"neto": 0, "qty": 0}}

    by_client = {}
    by_client_brand = {}
    by_vendor_client = {}
    by_vendor_client_brand = {}
    for d in facturas + exenta_docs:
        cid = str(d.get("client", {}).get("id", "unknown"))
        by_client.setdefault(cid, {"count": 0, "neto": 0})
        by_client[cid]["count"] += 1
        by_client[cid]["neto"] += d.get("netAmount", 0)

        doc_brands = brand_details.get(d["id"], {}).get("by_brand", {}) if brand_details else {}
        brand_totals = by_client_brand.setdefault(cid, empty_brand_totals())
        for brand, vals in doc_brands.items():
            if brand in brand_totals:
                brand_totals[brand]["neto"] += vals.get("neto", 0)
                brand_totals[brand]["qty"] += vals.get("qty", 0)

        vname = vendor_for(d)
        by_vendor_client.setdefault(vname, {})
        by_vendor_client[vname].setdefault(cid, {"count": 0, "neto": 0})
        by_vendor_client[vname][cid]["count"] += 1
        by_vendor_client[vname][cid]["neto"] += d.get("netAmount", 0)

        vbrand_totals = by_vendor_client_brand.setdefault(vname, {}).setdefault(cid, empty_brand_totals())
        for brand, vals in doc_brands.items():
            if brand in vbrand_totals:
                vbrand_totals[brand]["neto"] += vals.get("neto", 0)
                vbrand_totals[brand]["qty"] += vals.get("qty", 0)

    def top_n(client_totals, brand_map, n=15):
        rows = []
        for cid, vals in client_totals.items():
            b = brand_map.get(cid, empty_brand_totals())
            rows.append({
                "id": cid,
                **vals,
                "teox_neto": b["Teoxane"]["neto"],
                "teox_units": b["Teoxane"]["qty"],
                "rrs_neto": b["RRS HA Long Lasting"]["neto"],
                "rrs_units": b["RRS HA Long Lasting"]["qty"],
                "name": clients_meta.get(cid, {}).get("name", cid),
            })
        return sorted(rows, key=lambda x: x["neto"], reverse=True)[:n]

    top_clients = top_n(by_client, by_client_brand)
    top_clients_by_vendor = {
        vname: top_n(totals, by_vendor_client_brand.get(vname, {}))
        for vname, totals in by_vendor_client.items()
    }

    record = {
        "year": year,
        "month": month,
        "count_facturas": len(facturas) + len(exenta_docs),
        "count_nc": len(nc_docs),
        "neto_facturas": neto_facturas,
        "neto_nc": neto_nc,
        "total_neto": total_neto,
        "by_day": [
            {"date": k, "count": v["count"], "neto": v["neto"]}
            for k, v in sorted(by_day.items())
        ],
        "by_vendor": by_vendor,
        "by_vendor_day": {
            vname: [{"date": k, "count": v["count"], "neto": v["neto"]}
                     for k, v in sorted(days.items())]
            for vname, days in by_vendor_day.items()
        },
        "by_brand": by_brand,
        "by_vendor_brand": by_vendor_brand,
        "by_sku": by_sku,
        "by_vendor_sku": by_vendor_sku,
        "top_clients": top_clients,
        "top_clients_by_vendor": top_clients_by_vendor,
    }
    return record


# -- Persistence ---------------------------------------------------------------

def load_existing():
    if os.path.exists(OUT_FILE):
        with open(OUT_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return (
            data.get("users", {}),
            data.get("clients", {}),
            {(r["year"], r["month"]): r for r in data.get("months", [])}
        )
    return {}, {}, {}


def save(users, clients, months_dict):
    months = sorted(months_dict.values(), key=lambda r: (r["year"], r["month"]))
    output = {
        "updated_at": datetime.datetime.utcnow().isoformat() + "Z",
        "users": users,
        "clients": clients,
        "months": months,
    }
    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"Saved {len(months)} months -> {OUT_FILE}")


# -- Main ----------------------------------------------------------------------

def months_range(from_year, from_month, to_year, to_month):
    y, m = from_year, from_month
    while (y, m) <= (to_year, to_month):
        yield y, m
        m += 1
        if m > 12:
            m = 1
            y += 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backfill", action="store_true")
    parser.add_argument("--from", dest="from_month", default="2025-01")
    args = parser.parse_args()

    today = datetime.date.today()
    _, _, existing = load_existing()

    if args.backfill:
        from_year, from_month = map(int, args.from_month.split("-"))
        targets = list(months_range(from_year, from_month, today.year, today.month))
        print(f"Backfill: {len(targets)} months ({args.from_month} -> {today.year}-{today.month:02d})")
    else:
        targets = [(today.year, today.month)]
        print(f"Daily mode: {today.year}-{today.month:02d}")

    print("Fetching users...", end=" ", flush=True)
    users = fetch_users()
    print(f"{len(users)} users")

    print("Fetching clients...", end=" ", flush=True)
    clients = fetch_clients()
    print(f"{len(clients)} clients")

    rut_to_vendor = load_rut_to_vendor()
    client_to_vendor = build_client_to_vendor(clients, rut_to_vendor)
    print(f"Vendor lookup: {len(client_to_vendor)} clients mapped")

    total_docs = get_total_document_count()
    fact_block_end = total_docs - 1
    print(f"Total documents in account: {total_docs} (facturas search range: {FACT_BLOCK_START}-{fact_block_end})")

    nc_by_month = scan_nc_and_exentas_all_months()

    for year, month in targets:
        label = f"{year}-{month:02d}"
        print(f"  Fetching facturas {label}...", end=" ", flush=True)
        facturas = fetch_facturas_for_month(year, month, fact_block_end)
        nc_data = nc_by_month.get((year, month), {"nc": [], "exenta": []})
        print(
            f"{len(facturas)} facturas | {len(nc_data['nc'])} NC | "
            f"{len(nc_data['exenta'])} exentas"
        )

        brand_details = fetch_brand_details(facturas, nc_data["exenta"], nc_data["nc"])

        record = build_month_record(
            year, month, facturas, nc_data["nc"], nc_data["exenta"],
            clients, brand_details, client_to_vendor
        )
        existing[(year, month)] = record
        print(
            f"    neto ${record['total_neto']:,.0f} | "
            f"Teoxane ${record['by_brand'].get('Teoxane', 0):,.0f} | "
            f"RRS ${record['by_brand'].get('RRS HA Long Lasting', 0):,.0f}"
        )

    save(users, clients, existing)


if __name__ == "__main__":
    main()
