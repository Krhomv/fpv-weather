# FPV Weather

A small phone-first web app (PWA) for deciding whether you can go fly at a given spot.

- **Now**: will it rain at your location in the next hour, 4 hours or 24 hours, with a rain intensity graph, plus wind, gusts and a fly / no-fly verdict.
- **Spots**: pin your FPV spots on a map with a name, photo and notes. Each spot shows the last 7 days and the next 16 days of rain, wind and gusts, a 48-hour chart, and how many good flying hours each day has.
- **Day timeline**: 3-hour columns per day (sky, temperature, feels-like, wind, gusts, rain, chance, fly verdict) with a small rain map of the ~20 km around the spot. Tap a rain map to see it bigger.
- **Settings**: wind unit and your own fly limits (wind, gusts, rain, rain chance, daylight only). Export/import your spots as a JSON backup.

Install it on your phone with "Add to Home screen". Spots, photos and settings stay on your device.

## Data sources (free, no API key)

- [Open-Meteo](https://open-meteo.com/) forecast and geocoding (CC BY 4.0)
- Open-Meteo historical forecast API for the past week
- [BigDataCloud](https://www.bigdatacloud.com/) reverse geocoding for the place name
- Base map © OpenStreetMap contributors; map by [Leaflet](https://leafletjs.com/)

## Hosting

Plain static files, no build step. GitHub Pages serves the `main` branch root.
Run locally with `python3 -m http.server` and open http://localhost:8000.
