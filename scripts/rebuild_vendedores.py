"""
One-off: rebuild data/vendedores.json (RUT -> vendedor) from a fresh
"Razon Social;vendedor" CSV export, matching each company name against the
Bsale client list already cached in data/ventas.json (no API calls needed).

Usage: python scripts/rebuild_vendedores.py "C:\\path\\to\\clientes.csv"
"""
import json
import os
import re
import sys
import unicodedata

import pandas as pd

HERE = os.path.dirname(__file__)
DATA_DIR = os.path.join(HERE, "..", "data")
VENTAS_FILE = os.path.join(DATA_DIR, "ventas.json")
VENDORS_FILE = os.path.join(DATA_DIR, "vendedores.json")

KNOWN_VENDORS = ["Cindy Monsalves", "Daisy Ponce", "Francisca Salinas", "Ivan Salinas", "Monica Urrutia"]


def norm(s):
    if not s or not isinstance(s, str):
        return ""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"[^A-Za-z0-9 ]", " ", s)
    s = re.sub(r"\s+", " ", s).strip().upper()
    return s


def tokens(s):
    return norm(s).split()


def subsequence_extra(short_tokens, long_tokens):
    """
    True if every token of short_tokens appears in long_tokens, in the same
    order (gaps allowed) -- e.g. a missing middle name or a missing "DRA.".
    Returns the number of extra/gap tokens in long_tokens, or None if it's
    not a subsequence at all. Rejects matches on shared filler words alone
    (SOCIEDAD/SERVICIOS/SPA/LIMITADA) by requiring EVERY distinguishing
    token -- not just most of them -- to actually be present.
    """
    i = 0
    for tok in short_tokens:
        found = False
        while i < len(long_tokens):
            if long_tokens[i] == tok:
                found = True
                i += 1
                break
            i += 1
        if not found:
            return None
    return len(long_tokens) - len(short_tokens)


def norm_vendedor(raw):
    if not isinstance(raw, str) or not raw.strip():
        return None, None
    v = re.sub(r"\s+", " ", raw.strip())
    canon = {n.upper(): n for n in KNOWN_VENDORS}.get(v.upper())
    if canon:
        return canon, None
    return None, raw  # unrecognized value (e.g. "Providencia") -> flagged, not assigned


def main():
    csv_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not csv_path:
        print("Usage: python scripts/rebuild_vendedores.py <csv_path>")
        sys.exit(1)

    df = pd.read_csv(csv_path, sep=";", encoding="utf-8-sig")
    df.columns = [c.strip() for c in df.columns]
    df = df.rename(columns={df.columns[0]: "razonSocial", df.columns[1]: "vendedorRaw"})
    df = df[df["vendedorRaw"].notna()].copy()

    flagged = []
    rows = []
    for _, row in df.iterrows():
        canon, bad = norm_vendedor(row["vendedorRaw"])
        if canon:
            rows.append((row["razonSocial"], canon))
        elif bad:
            flagged.append((row["razonSocial"], bad))

    with open(VENTAS_FILE, encoding="utf-8") as f:
        ventas = json.load(f)
    clients = ventas["clients"]  # {id: {name, rut}}

    name_to_rut = {}
    name_to_tokens = {}
    for cid, info in clients.items():
        n = norm(info.get("name", ""))
        if n and n not in name_to_rut:
            name_to_rut[n] = info.get("rut", "")
            name_to_tokens[n] = tokens(info.get("name", ""))

    rut_to_vendor = {}
    unmatched = []
    fuzzy_used = []
    for razon, vendor in rows:
        rn = norm(razon)
        rtoks = tokens(razon)
        if rn in name_to_rut:
            rut = name_to_rut[rn]
        else:
            # Only accept a fuzzy match when EVERY token of the shorter name
            # is present, in order, inside the longer one (e.g. a missing
            # middle name or "DRA.") -- never on shared filler words alone.
            best_rut, best_extra, best_name = None, None, None
            for cand_name, cand_toks in name_to_tokens.items():
                short, long_ = (rtoks, cand_toks) if len(rtoks) <= len(cand_toks) else (cand_toks, rtoks)
                extra = subsequence_extra(short, long_)
                if extra is not None and extra <= 3 and (best_extra is None or extra < best_extra):
                    best_extra, best_rut, best_name = extra, name_to_rut[cand_name], cand_name
            if best_rut is not None:
                rut = best_rut
                fuzzy_used.append((razon, best_name, best_extra))
            else:
                unmatched.append((razon, vendor))
                continue
        if not rut:
            unmatched.append((razon, vendor))
            continue
        rut_to_vendor[rut] = vendor

    print(f"Filas con vendedor asignado: {len(rows)}")
    print(f"Matcheadas por RUT: {len(rut_to_vendor)}")
    print(f"  (via fuzzy: {len(fuzzy_used)})")
    for r in fuzzy_used:
        print(f"    fuzzy[+{r[2]} extra tok]: {r[0]!r} -> {r[1]!r}")
    print(f"Sin match en Bsale: {len(unmatched)}")
    for u in unmatched:
        print(f"    {u}")
    print(f"Valores de vendedor no reconocidos (excluidos): {flagged}")

    out = {"_note": "Actualizar manualmente cada mes. Claves: RUT del cliente en Bsale.", **rut_to_vendor}
    with open(VENDORS_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2, sort_keys=True)
    print(f"\nGuardado {len(rut_to_vendor)} RUT->vendedor -> {VENDORS_FILE}")


if __name__ == "__main__":
    main()
