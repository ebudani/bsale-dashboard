"""
chile_regions.py - region de Chile a partir de la comuna / ciudad de una direccion.

Bsale no tiene un campo "region": la ficha del cliente trae address, municipality
(comuna) y city (ciudad), escritos a mano (mayusculas, sin tildes, "Vina del mar"...).
Aca se normaliza el texto y se busca la comuna en la division politico-administrativa
vigente (16 regiones, con Nuble desde 2018). Si la comuna no se reconoce se prueba con
la ciudad y despues con cada tramo de la direccion; si nada calza devuelve None.
"""
import unicodedata

# codigo (el mismo que usa el mapa) -> (nombre, comunas)
REGIONS = {
    "XV": ("Arica y Parinacota", "Arica, Camarones, Putre, General Lagos"),
    "I": ("Tarapacá", "Iquique, Alto Hospicio, Pozo Almonte, Camiña, Colchane, Huara, Pica"),
    "II": ("Antofagasta", "Antofagasta, Mejillones, Sierra Gorda, Taltal, Calama, Ollagüe, San Pedro de Atacama, Tocopilla, María Elena"),
    "III": ("Atacama", "Copiapó, Caldera, Tierra Amarilla, Chañaral, Diego de Almagro, Vallenar, Alto del Carmen, Freirina, Huasco"),
    "IV": ("Coquimbo", "La Serena, Coquimbo, Andacollo, La Higuera, Paiguano, Vicuña, Illapel, Canela, Los Vilos, Salamanca, Ovalle, Combarbalá, Monte Patria, Punitaqui, Río Hurtado"),
    "V": ("Valparaíso", "Valparaíso, Casablanca, Concón, Juan Fernández, Puchuncaví, Quintero, Viña del Mar, Isla de Pascua, Los Andes, Calle Larga, Rinconada, San Esteban, La Ligua, Cabildo, Papudo, Petorca, Zapallar, Quillota, La Calera, Calera, Hijuelas, La Cruz, Nogales, San Antonio, Algarrobo, Cartagena, El Quisco, El Tabo, Santo Domingo, San Felipe, Catemu, Llaillay, Panquehue, Putaendo, Santa María, Quilpué, Limache, Olmué, Villa Alemana"),
    "RM": ("Metropolitana de Santiago", "Cerrillos, Cerro Navia, Conchalí, El Bosque, Estación Central, Huechuraba, Independencia, La Cisterna, La Florida, La Granja, La Pintana, La Reina, Las Condes, Lo Barnechea, Lo Espejo, Lo Prado, Macul, Maipú, Ñuñoa, Pedro Aguirre Cerda, Peñalolén, Providencia, Pudahuel, Quilicura, Quinta Normal, Recoleta, Renca, San Joaquín, San Miguel, San Ramón, Santiago, Vitacura, Puente Alto, Pirque, San José de Maipo, Colina, Lampa, Tiltil, San Bernardo, Buin, Calera de Tango, Paine, Melipilla, Alhué, Curacaví, María Pinto, San Pedro, Talagante, El Monte, Isla de Maipo, Padre Hurtado, Peñaflor"),
    "VI": ("Libertador General Bernardo O'Higgins", "Rancagua, Codegua, Coinco, Coltauco, Doñihue, Graneros, Las Cabras, Machalí, Malloa, Mostazal, Olivar, Peumo, Pichidegua, Quinta de Tilcoco, Rengo, Requínoa, San Vicente, Pichilemu, La Estrella, Litueche, Marchihue, Navidad, Paredones, San Fernando, Chépica, Chimbarongo, Lolol, Nancagua, Palmilla, Peralillo, Placilla, Pumanque, Santa Cruz"),
    "VII": ("Maule", "Talca, Constitución, Curepto, Empedrado, Maule, Pelarco, Pencahue, Río Claro, San Clemente, San Rafael, Cauquenes, Chanco, Pelluhue, Curicó, Hualañé, Licantén, Molina, Rauco, Romeral, Sagrada Familia, Teno, Vichuquén, Linares, Colbún, Longaví, Parral, Retiro, San Javier, Villa Alegre, Yerbas Buenas"),
    "XVI": ("Ñuble", "Chillán, Chillán Viejo, Bulnes, Cobquecura, Coelemu, Coihueco, El Carmen, Ninhue, Ñiquén, Pemuco, Pinto, Portezuelo, Quillón, Quirihue, Ránquil, San Carlos, San Fabián, San Ignacio, San Nicolás, Treguaco, Yungay"),
    "VIII": ("Biobío", "Concepción, Coronel, Chiguayante, Florida, Hualqui, Lota, Penco, San Pedro de la Paz, Santa Juana, Talcahuano, Tomé, Hualpén, Lebu, Arauco, Cañete, Contulmo, Curanilahue, Los Álamos, Tirúa, Los Ángeles, Antuco, Cabrero, Laja, Mulchén, Nacimiento, Negrete, Quilaco, Quilleco, San Rosendo, Santa Bárbara, Tucapel, Yumbel, Alto Biobío"),
    "IX": ("La Araucanía", "Temuco, Carahue, Cunco, Curarrehue, Freire, Galvarino, Gorbea, Lautaro, Loncoche, Melipeuco, Nueva Imperial, Padre las Casas, Perquenco, Pitrufquén, Pucón, Saavedra, Teodoro Schmidt, Toltén, Vilcún, Villarrica, Cholchol, Angol, Collipulli, Curacautín, Ercilla, Lonquimay, Los Sauces, Lumaco, Purén, Renaico, Traiguén, Victoria"),
    "XIV": ("Los Ríos", "Valdivia, Corral, Lanco, Los Lagos, Máfil, Mariquina, Paillaco, Panguipulli, La Unión, Futrono, Lago Ranco, Río Bueno"),
    "X": ("Los Lagos", "Puerto Montt, Calbuco, Cochamó, Fresia, Frutillar, Los Muermos, Llanquihue, Maullín, Puerto Varas, Castro, Ancud, Chonchi, Curaco de Vélez, Dalcahue, Puqueldón, Queilén, Quellón, Quemchi, Quinchao, Osorno, Puerto Octay, Purranque, Puyehue, Río Negro, San Juan de la Costa, San Pablo, Chaitén, Futaleufú, Hualaihué, Palena"),
    "XI": ("Aysén", "Coyhaique, Coihaique, Lago Verde, Aysén, Cisnes, Guaitecas, Cochrane, O'Higgins, Tortel, Chile Chico, Río Ibáñez"),
    "XII": ("Magallanes y de la Antártica Chilena", "Punta Arenas, Laguna Blanca, Río Verde, San Gregorio, Cabo de Hornos, Antártica, Porvenir, Primavera, Timaukel, Natales, Puerto Natales, Torres del Paine"),
}

# Como la gente escribe a veces la comuna en la ficha (barrios, abreviaturas).
ALIASES = {
    "santiago centro": "Santiago", "stgo": "Santiago", "stgo centro": "Santiago", "la dehesa": "Lo Barnechea",
    "con con": "Concón", "vina": "Viña del Mar", "vina del mar": "Viña del Mar", "nunoa": "Ñuñoa",
    "san pedro de la paz": "San Pedro de la Paz", "padre las casas": "Padre las Casas",
    "el arrayan": "Lo Barnechea", "las vizcachas": "Puente Alto",
    "coyahique": "Coyhaique", "san vicente de tagua tagua": "San Vicente",
}


def norm(text):
    """Minusculas, sin tildes ni signos, espacios simples. 'Viña  Del Mar' -> 'vina del mar'."""
    t = unicodedata.normalize("NFD", (text or "").strip().lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    t = "".join(c if c.isalnum() or c == " " else " " for c in t)
    return " ".join(t.split())


_BY_COMMUNE = {}
for code, (_name, communes) in REGIONS.items():
    for c in communes.split(", "):
        _BY_COMMUNE.setdefault(norm(c), code)
for alias, official in ALIASES.items():
    _BY_COMMUNE.setdefault(norm(alias), _BY_COMMUNE[norm(official)])

REGION_NAME = {code: v[0] for code, v in REGIONS.items()}


def region_code(*candidates):
    """Codigo de region para el primer texto (comuna, ciudad, tramo de direccion...) que calce."""
    for text in candidates:
        code = _BY_COMMUNE.get(norm(text))
        if code:
            return code
    return None


def region_from_address(address, municipality="", city=""):
    """municipality y city primero; si no, los tramos de 'address' de derecha a izquierda."""
    parts = [p for p in (address or "").split(",")]
    return region_code(municipality, city, *reversed(parts))
