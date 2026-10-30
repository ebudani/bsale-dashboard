"""
build_chile_map.py - arma data/chile_regiones.json (contornos de las 16 regiones, listos
para dibujar como SVG) a partir de un GeoJSON de regiones de Chile.

El GeoJSON de origen (Regional.geojson, repositorio publico fcortes/Chile-GeoJSON) NO se
guarda en el proyecto: pesa 1,4 MB. Este script lo simplifica (Douglas-Peucker), deja solo
Chile continental (sin Isla de Pascua, Juan Fernandez ni la Antartica) y escribe unos pocos
KB con el path de cada region en un viewBox fijo.

Uso: python scripts/build_chile_map.py ruta/a/Regional.geojson
"""
import json
import math
import os
import sys

OUT_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "chile_regiones.json")

# codregion del GeoJSON (codigo numerico oficial) -> codigo usado en scripts/chile_regions.py
CODE = {15: "XV", 1: "I", 2: "II", 3: "III", 4: "IV", 5: "V", 13: "RM", 6: "VI", 7: "VII",
        16: "XVI", 8: "VIII", 9: "IX", 14: "XIV", 10: "X", 11: "XI", 12: "XII"}

LON_MIN, LON_MAX = -76.0, -66.0   # deja afuera Isla de Pascua / Juan Fernandez
LAT_MIN = -56.0                   # deja afuera la Antartica chilena
HEIGHT = 700.0                    # alto del viewBox
TOLERANCE = 0.35                  # simplificacion, en unidades del viewBox
MIN_RING = 1.6                    # anillos (islas) mas chicos que esto, se descartan


def rings_of(geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    for poly in polys:
        yield poly[0]                       # solo el borde exterior de cada poligono


def dp(points, tol):
    """Douglas-Peucker iterativo. Un anillo cerrado (primer punto = ultimo) se parte en dos
    por el punto mas lejano al inicio, porque con la base de largo 0 no hay a que distancia medir."""
    if len(points) < 3:
        return points
    if points[0] == points[-1]:
        far = max(range(1, len(points) - 1), key=lambda i: math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]))
        return dp(points[:far + 1], tol)[:-1] + dp(points[far:], tol)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = points[a], points[b]
        dx, dy = x2 - x1, y2 - y1
        norm = math.hypot(dx, dy) or 1e-12
        best, idx = 0.0, None
        for i in range(a + 1, b):
            d = abs(dy * points[i][0] - dx * points[i][1] + x2 * y1 - y2 * x1) / norm
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(points, keep) if k]


def main(src):
    data = json.load(open(src, encoding="utf-8"))
    lat_top = -17.4
    k = HEIGHT / (lat_top - LAT_MIN)               # px por grado de latitud
    cos = math.cos(math.radians(36))               # achica la longitud (Chile esta en latitudes medias)
    x0 = LON_MIN

    def proj(lon, lat):
        return ((lon - x0) * cos * k, (lat_top - lat) * k)

    regions, width = {}, 0.0
    for f in data["features"]:
        code = CODE.get(f["properties"].get("codregion"))
        if not code:
            continue                                 # "Zona sin demarcar"
        paths, label_best = [], (0, None)
        for ring in rings_of(f["geometry"]):
            lons = [p[0] for p in ring]
            lats = [p[1] for p in ring]
            if not (LON_MIN <= sum(lons) / len(lons) <= LON_MAX and sum(lats) / len(lats) >= LAT_MIN):
                continue
            pts = dp([proj(lo, la) for lo, la in ring], TOLERANCE)
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            if math.hypot(max(xs) - min(xs), max(ys) - min(ys)) < MIN_RING or len(pts) < 4:
                continue
            width = max(width, max(xs))
            area = (max(xs) - min(xs)) * (max(ys) - min(ys))
            if area > label_best[0]:
                label_best = (area, [round(sum(xs) / len(xs), 1), round(sum(ys) / len(ys), 1)])
            paths.append("M" + "L".join(f"{x:.1f} {y:.1f}" for x, y in pts) + "Z")
        regions[code] = {"d": "".join(paths), "label": label_best[1]}

    out = {"viewBox": [round(width + 2), int(HEIGHT) + 2], "regions": regions}
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(regions)} regiones, viewBox {out['viewBox']}, {os.path.getsize(OUT_FILE) / 1024:.0f} KB -> {OUT_FILE}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
