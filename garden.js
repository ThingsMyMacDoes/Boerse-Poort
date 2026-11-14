// Default garden outline (from layer_1.geojson). Load another GeoJSON file in the sidebar to replace it.
const DEFAULT_GARDEN_GEOJSON = {
    "type": "FeatureCollection",
    "features": [{
        "type": "Feature",
        "properties": { "name": "boerse poort" },
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [3.686079, 51.057106], [3.686211, 51.057183], [3.686342, 51.057256], [3.686543, 51.057256],
                [3.686726, 51.057219], [3.686994, 51.057141], [3.68741, 51.057023], [3.687793, 51.05691],
                [3.688019, 51.056844], [3.688139, 51.056812], [3.686879, 51.056192], [3.686718, 51.056074],
                [3.686648, 51.056104], [3.686358, 51.056452], [3.686133, 51.056634], [3.685876, 51.056762],
                [3.685774, 51.056829], [3.685817, 51.056951], [3.686079, 51.057106]
            ]]
        }
    }]
};

// Clock times are shown in the garden's local time zone (handles summer/winter time).
const DEFAULT_TIME_ZONE = "Europe/Brussels";
