# LED-Rails-Backend

A backend service for real-time Auckland rail vehicle tracking, LED map generation, and train block analytics. Built with TypeScript, Express, and Bun, this project provides a robust API and caching layer for GTFS-realtime data, LED board integration, and advanced train pairing logic.

---

## Features

- **Real-time GTFS Data Fetching:** Periodically fetches and caches Auckland Transport's GTFS-realtime vehicle data.
- **LED Map Generation:** Computes and serves LED board updates based on train positions and track block occupancy.
- **Train Pair Detection:** Identifies and tracks pairs of trains running in close proximity.
- **Track Block Analytics:** Maps train positions to KML-defined track blocks and provides block-level occupancy data.
- **API Endpoints:** RESTful endpoints for vehicle, train, and LED map data.
- **Rate Limiting & Compression:** Built-in CORS, gzip/brotli compression, and configurable rate limiting.
- **Docker Support:** Ready-to-run with Docker Compose for easy deployment.

---

## Project Structure

- `server.ts` — Main Express server, API endpoints, and periodic data refresh logic.
- `trackBlocks.ts` — KML parsing, block occupancy, and LED map update logic.
- `trainPairs.ts` — Train pair detection and caching.
- `map.html` — Leaflet-based web map for visualizing live train positions and track blocks.
- `cache/` — Stores compressed GTFS data, LED map state, and train pair cache.
- `blockDatabase/` — Track block metadata and jump rules.

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) (for local development)
- [Docker Desktop](https://www.docker.com/products/docker-desktop) (for containerized deployment)

### Local Development

1. Install dependencies:

   ```bash
   bun install
   ```

2. Create a `.env` file with your AT API key:

   ```env
   API_KEY=your_api_key_here
   PORT=3000
   ```

3. Start the server:

   ```bash
   bun server.ts
   ```

4. Open [http://localhost:3000/status](http://localhost:3000/status) to check server status.

### Docker Deployment

1. Create a `.env` file as above.
2. Build and run with Docker Compose:

   ```powershell
   docker compose up --build
   ```

3. Access endpoints at [http://localhost:3000](http://localhost:3000)

---

## API Endpoints

| Endpoint                      | Description                        |
|-------------------------------|------------------------------------|
| `/`                           | Basic server status                |
| `/status`                     | Server metrics and uptime          |
| `/api/data`                   | Cached GTFS vehicle data           |
| `/api/vehicles`               | All active vehicle entities        |
| `/api/vehicles/trains`        | Filtered list of active trains     |
| `/akl-ltm/100.json`           | LED map update (for LED board)     |
| `/trackedtrains`              | Tracked train block assignments    |

All endpoints are CORS-enabled and rate-limited by default.

---

## Configuration

Set environment variables in `.env`:

- `API_KEY` (required): Auckland Transport API key
- `PORT`: Server port (default: 3000)
- `RATE_LIMIT_WINDOW_MS`: Rate limit window (default: 60000)
- `RATE_LIMIT_MAX`: Max requests per window (default: 20)

---

## License

MIT License. See [LICENSE](LICENSE).
