# GTFS Realtime Cache Server

A caching server for Auckland Transport's realtime GTFS data using Express and Bun.

## Features

- Fetches data every 20 seconds from AT API
- Gzip/Brotli compression
- CORS enabled
- Rate limiting protection
- Docker support
- Status monitoring endpoint

## 🚀 Quick Start

### Requirements

- Docker Desktop ([Download](https://www.docker.com/products/docker-desktop))
- Windows: Enable WSL2 for better performance

### Setup with Docker

1. Create `.env` file:

```env
API_KEY=your_api_key_here
PORT=3000

# Optional rate limiting (default: 20 requests/minute per IP)
# RATE_LIMIT_WINDOW_MS=60000
# RATE_LIMIT_MAX=20
```

2. Start container from PowerShell in project folder:

```powershell
docker compose up --build
```

3. Access:

- <http://localhost:3000/api/data>
- <http://localhost:3000/status>

## 💻 Local Development

1. Install Bun

2. Install dependencies:

```bash
bun install
```

3. Create `.env` file:

```env
API_KEY=your_api_key_here
```

4. Start server:

```bash
bun server.ts
```

## 🌐 Endpoints

| Endpoint       | Description                          | Rate Limited |
|----------------|--------------------------------------|--------------|
| `GET /`        | Basic server status                  | ✓            |
| `GET /api/data`| Cached GTFS data                     | ✓            |
| `GET /status`  | Server metrics and uptime            | ✓            |

## 🔧 Configuration

Environment variables:

- `API_KEY` (Required) - AT API subscription key
- `PORT` - Server port (default: 3000)
- `RATE_LIMIT_WINDOW_MS` - Rate limit window in ms (default: 60000)
- `RATE_LIMIT_MAX` - Max requests per IP per window (default: 20)

## ⚠️ Rate Limits

Default protection applied to all endpoints:

- 20 requests per minute per IP address
- Returns HTTP 429 status for exceeded limits
- Customizable via environment variables

## 📄 License

MIT License - See [LICENSE](LICENSE)
