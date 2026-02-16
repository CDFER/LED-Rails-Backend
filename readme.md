# LED-Rails-Backend

A backend service for real-time rail vehicle tracking for Live LED maps. Built with TypeScript, and Bun.

This project is built for the Live Train Maps that I sell through my store: [keastudios.co.nz](https://keastudios.co.nz)

## Features

- **Multi-city Support:** Currently I have Auckland, Wellington and Melbourne rail networks but it should be easy to add more cities, with separate config folders containing `trackBlocks.kml` and `config.json` files.
- **Real-time GTFS Data Fetching:** Periodically fetches and caches GTFS-realtime vehicle data for supported cities.
- **LED Map Generation:** Computes and serves LED board updates based on train positions and track block occupancy.
- **Train Pair Detection:** Identifies and tracks pairs of trains running in close proximity.
- **Train Blocks:** The `trackBlocks.kml` file can be edited with Google Earth for custom block layouts.
- **API Endpoints:** RESTful endpoints for vehicle, train, and LED map data.
- **Compression:** Built-in zstd / brotli / gzip / deflate compression.
- **Docker Support:** Ready-to-run with Docker Compose for easy deployment.

## Project Structure

- `server.ts` - Main Express server, API endpoints, and periodic data refresh logic.
- `railNetwork.ts` - City-specific configuration loader and documentation for `config.json` structure.
- `trackBlocks.ts` - KML parsing, block occupancy, and LED map update logic.
- `trainPairs.ts` - Train pair detection and caching.
- `cache.ts` - Caching to and from gzipped JSON files.
- `customUtils.ts` - Utility functions, including colorized logging.
- `map.html` - Leaflet-based web map for visualizing live train positions and track blocks (for debugging).
- `viewer.html` - Preview of the circuit board

### Currently Supported Networks

- `railNetworks/AKL/` - Auckland
- `railNetworks/WLG/` - Wellington
- `railNetworks/MEL/` - Melbourne

## API Endpoints

Endpoints use city code (e.g. AKL, WLG, MEL) and version (e.g. 100 for V1.0.0):

| Endpoint                      | Description                        |
|-------------------------------|------------------------------------|
| `/`                           | Basic server status                |
| `/status`                     | Server metrics and uptime          |
| `/city/api/vehicles`          | All active vehicle entities        |
| `/city/api/vehicles/trains`   | Filtered list of active trains     |
| `/city-ltm/version.json`      | LED map update for the city board  |

All endpoints are rate-limited by default.

## Configuration

Set environment variables in `.env`:

- `PORT`: Server port (default: 3000)
- `AKL`, `WLG`: Add API keys for each city using their city ID

City-specific configurations are in `railNetworks/` and the documentation for the structure of `config.json` is at the top of `railNetwork.ts`.

### Editing Track Blocks

- Edit `trackBlocks.kml` in Google Earth to customize block layouts for each city.
- Update `config.json` for each city to change API settings, colors, and thresholds.

## License

MIT License. See [LICENSE](LICENSE).
