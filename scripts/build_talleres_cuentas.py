"""
build_talleres_cuentas.py - arma data/talleres_cuentas.json: para cada cuenta de Bsale, la fecha del
ultimo taller / evento al que asistio alguna persona vinculada a esa cuenta (columna "Fecha ultimo
taller" de Cartera en riesgo).

Fuente: Excel "Talleres - Conversion eventos y talleres" (Drive: Eugenia Aestheticspro - 2026), hojas
"Detalle por evento" (eventos 2025-2026, con fecha exacta), "Base personas" (vinculo persona-empresa
y lista de eventos) y "Eventos historicos" (eventos 2020-2024, algunos con fecha aproximada).

Solo guarda, por cuenta, la fecha (y su precision). No copia nombres, correos ni telefonos.
No cuentan: inscritos que no asistieron, solo inscritos (SOCHIMCE) y eventos futuros.

Uso: python scripts/build_talleres_cuentas.py ruta/al/Conversion_eventos_y_talleres.xlsx [data/ventas.json]
"""
import datetime
import json
import os
import re
import sys

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_FILE = os.path.join(HERE, "..", "data", "talleres_cuentas.json")
DEFAULT_VENTAS = os.path.join(HERE, "..", "data", "ventas.json")
SOURCE = "Talleres - Conversion eventos y talleres 27-10-2026.xlsx (Drive: Eugenia Aestheticspro - 2026)"
HOY = datetime.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)


def norm_rut(s):
    if not s:
        return None
    m = re.search(r"(\d{1,2}\.?\d{3}\.?\d{3})\s*-\s*([\dkK])", str(s))
    return (m.group(1).replace(".", "") + "-" + m.group(2).upper()) if m else None


def main(conv_path, ventas_path):
    wb = openpyxl.load_workbook(conv_path, data_only=True)

    # ---- fecha de cada evento historico (por nombre)
    hist = {}
    for r in wb["Eventos históricos"].iter_rows(min_row=4, values_only=True):
        if r[1] and isinstance(r[2], datetime.datetime):
            hist[str(r[1]).strip()] = (r[2], r[3] or "día")

    # ---- asistencia 2025-2026 con fecha exacta (Detalle por evento)
    prec_ev = {}
    futuros = set()   # eventos marcados "Evento futuro" en el Excel: solo hay inscritos, no se sabe quien asistio
    for r in wb["Conversión por evento"].iter_rows(min_row=4, values_only=True):
        if r[0] and isinstance(r[1], datetime.datetime):
            prec_ev[str(r[0])] = r[2] or "día"
            if r[3] == "Evento futuro":
                futuros.add(str(r[0]))
    det = wb["Detalle por evento"]
    ultimo = {}      # rut persona -> (fecha, precision)
    for r in det.iter_rows(min_row=2, values_only=True):
        nombre, fecha, rut_p = r[0], r[1], norm_rut(r[3])
        if not nombre or not rut_p or not isinstance(fecha, datetime.datetime):
            continue
        s = str(nombre).lower()
        if "no asistieron" in s or s.endswith("– inscritos") or fecha > HOY or str(nombre) in futuros:
            continue                                  # no fue / solo inscrito / evento futuro o sin asistencia confirmada
        prec = prec_ev.get(str(nombre), "día")
        if rut_p not in ultimo or fecha > ultimo[rut_p][0]:
            ultimo[rut_p] = (fecha, prec)

    # ---- personas: vinculo con la empresa + eventos historicos
    bp = wb["Base personas"]
    hdr = [c.value for c in bp[1]]
    ix = {h: i for i, h in enumerate(hdr)}
    por_empresa = {}  # rut empresa -> (fecha, precision)
    sin_fecha_hist = set()
    for r in bp.iter_rows(min_row=2, values_only=True):
        if not r[0]:
            continue
        rut_p = norm_rut(r[ix["RUT persona"]])
        rut_e = norm_rut(r[ix["Vínculo persona-empresa"]])
        if not rut_e:
            continue
        cand = []
        if rut_p in ultimo:
            cand.append(ultimo[rut_p])
        for ev in str(r[ix["Eventos y cursos"]] or "").split(" | "):
            ev = ev.strip()
            if ev in hist and hist[ev][0] <= HOY:
                cand.append(hist[ev])
            elif ev and ev not in hist:
                sin_fecha_hist.add(ev)
        if not cand:
            continue
        best = max(cand, key=lambda x: x[0])
        if rut_e not in por_empresa or best[0] > por_empresa[rut_e][0]:
            por_empresa[rut_e] = best

    # ---- cuentas del tablero (por RUT)
    ventas = json.load(open(ventas_path, encoding="utf-8"))
    cuentas = {}
    for cid, meta in ventas["clients"].items():
        rut = norm_rut(meta.get("rut"))
        if rut in por_empresa:
            f, p = por_empresa[rut]
            cuentas[cid] = {"f": f.strftime("%Y-%m-%d"), "p": p}
    data = {
        "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "fuente": SOURCE,
        "cuentas": cuentas,
    }
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    anios = {}
    for v in cuentas.values():
        anios[v["f"][:4]] = anios.get(v["f"][:4], 0) + 1
    print(f"{len(cuentas)} cuentas con fecha de taller -> {OUT_FILE}")
    print("por año del ultimo taller:", dict(sorted(anios.items())))


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2] if len(sys.argv) == 3 else DEFAULT_VENTAS)
