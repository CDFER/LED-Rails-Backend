# GTFS Realtime Cache Server

A caching server for Auckland Transport's realtime GTFS data using Express and Bun.

## Features

- Fetches data every 20 seconds from AT API
- Gzip/Brotli compression
- CORS enabled
- Docker support
- Status monitoring endpoint

## 🚀 Quick Start

### Requirements

- Docker Desktop with Windows Subsystem for Linux

### Setup with Docker

1. Create `.env` file:

```env
API_KEY=your_api_key_here
PORT=3000
```

2. Start container for a powershell terminal in the repo folder:

```powershell
docker compose up --build
```

3. Access:

- <http://localhost:3000/api/data>
- <http://localhost:3000/status>

## Local Development

1. Install Bun

2. Install dependencies:

```bash
bun install
```

3. Create `.env` file and start server:

```bash
bun server.ts
```

## 🌐 Endpoints

- `GET /` - Basic status
- `GET /api/data` - Cached GTFS data
- `GET /status` - Server operation metrics

## 🔧 Configuration

Environment variables:

- `API_KEY` (Required) - AT API subscription key
- `PORT` - Server port (default: 3000)

## 📄 License

MIT License - See [LICENSE](LICENSE)