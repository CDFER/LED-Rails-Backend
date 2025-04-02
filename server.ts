import express from 'express';
import compression from 'compression';
import { config } from 'dotenv';
import rateLimit from 'express-rate-limit';
import { promises as fs } from 'fs';
import path from 'path';

import type { GTFSRealtime, Entity } from 'gtfs-types';

config(); // Load environment variables from .env file

const app = express();
const port = process.env.PORT || 3000;
const subscriptionKey = process.env.API_KEY;
const realtimeApiUrl = 'https://api.at.govt.nz/realtime/legacy';
const rateLimiterWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const rateLimiterMaxRequests = parseInt(process.env.RATE_LIMIT_MAX || '20', 10);
const fetchIntervalMs = parseInt(process.env.FETCH_INTERVAL_S || '20', 10)*1000;
const saveIntervalMs = parseInt(process.env.SAVE_INTERVAL_S || '180', 10)*1000;

// File system paths
const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'realtime_cache.json.gz');

if (!subscriptionKey) {
    throw new Error('API_KEY environment variable is required');
}

const rateLimiter = rateLimit({
    windowMs: rateLimiterWindowMs,
    max: rateLimiterMaxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        status: 429,
        error: 'Too many requests - please try again later'
    }
});

app.use(rateLimiter);


function getPrecisionTimestamp(): string {
    const d = new Date();
    return [
        d.getHours().toString().padStart(2, '0'),
        d.getMinutes().toString().padStart(2, '0'),
        d.getSeconds().toString().padStart(2, '0') + '.' +
        d.getMilliseconds().toString().padStart(3, '0')
    ].join(':');
}

// Utility function for consistent log formatting
function log(label: string, message: string, extra?: Record<string, unknown>) {
    const parts = [
        `[${getPrecisionTimestamp()}]`,
        `[${label}]`.padEnd(8),
        message,
        ...Object.entries(extra || {}).map(([k, v]) => `${k}=${v}`)
    ];
    console.log(parts.join(' | '));
}

// Cache state management
let cachedRealtimeData: GTFSRealtime | undefined;
let lastSuccessfulFetchTimestamp: number | undefined;
let isFetchInProgress = false;
const activeVehiclePositions = new Map<string, Entity>();

// Initialize cache directory
async function initCacheDir() {
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (error) {
        console.error('Could not create cache directory:', error);
    }
}

// Save cache to disk
async function saveCache() {
    if (!cachedRealtimeData) return;

    try {
        const startTime = Date.now();
        const cacheData = {
            ...cachedRealtimeData
        };

        const jsonPayload = JSON.stringify(cacheData);
        const jsonSize = Buffer.byteLength(jsonPayload);  // Get byte length

        const entityStats = processEntityStatistics(cacheData.response.entity ?? []);

        // Compress with Bun's native GZIP
        const compressedData = Bun.gzipSync(jsonPayload, {
            level: 9,       // Highest compression level (0-9)
            memLevel: 9,    // Max memory usage for best compression
            strategy: 2,    // Z_RLE strategy for repetitive binary data
            windowBits: 31  // Max size of the history buffer
        });

        await fs.writeFile(CACHE_FILE, compressedData);
        log("CACHE", `Saved ${path.basename(CACHE_FILE)}`, {
            vehicles: entityStats.vehiclePositions,
            size: `${(compressedData.byteLength / 1024).toFixed(1)}KiB`,
            ratio: `${((compressedData.byteLength / jsonSize) * 100).toFixed(2)}%`,
            in: `${Date.now() - startTime}ms`
        });
    } catch (error) {
        console.error('Failed to persist compressed cache:', error);
    }
}

async function restoreCache() {
    const startTime = Date.now();
    try {
        const compressedData = await fs.readFile(CACHE_FILE);
        const decompressed = Bun.gunzipSync(compressedData);
        const parsed = JSON.parse(Buffer.from(decompressed).toString('utf8')) as GTFSRealtime;

        // Restore main data
        cachedRealtimeData = parsed;

        // Restore vehicle positions
        if (parsed.response?.entity) {
            parsed.response.entity.forEach(entity => {
                if (entity.vehicle && entity.id) {
                    activeVehiclePositions.set(entity.id, entity);
                }
            });
        }

        const msPerDay = 1000 * 60 * 60 * 24;
        log("CACHE", `Restored ${path.basename(CACHE_FILE)}`, {
            vehicles: activeVehiclePositions.size,
            writeRate: `~${((compressedData.byteLength * (msPerDay / saveIntervalMs)) / (1024 ** 2)).toFixed(0)}MiB/Day`,
            in: `${Date.now() - startTime}ms`
        });
    } catch (error) {
        console.log('No previous cache found or error restoring:', error instanceof Error ? error.message : String(error));

    }
}

app.use(compression({
    threshold: 1024,
    level: 9
}));

app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

function processEntityStatistics(entities: Entity[]) {
    return entities.reduce((acc, entity) => {
        if (entity.trip_update) acc.tripUpdates++;
        if (entity.vehicle) acc.vehiclePositions++;
        if (entity.alert) acc.alerts++;
        return acc;
    }, { tripUpdates: 0, vehiclePositions: 0, alerts: 0 });
}

async function refreshRealtimeData() {
    const startTime = Date.now();

    if (isFetchInProgress) return;
    isFetchInProgress = true;

    try {
        const response = await fetch(realtimeApiUrl, {
            headers: {
                'Ocp-Apim-Subscription-Key': subscriptionKey as string,
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip, deflate, br'
            }
        });

        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const freshData = await response.json() as GTFSRealtime;

        if (freshData.response.entity) {
            const transientEntities: Entity[] = [];

            freshData.response.entity.forEach(entity => {
                if (entity.vehicle) {
                    if (entity.is_deleted) {
                        activeVehiclePositions.delete(entity.id);
                    } else {
                        activeVehiclePositions.set(entity.id, entity);
                    }
                } else {
                    transientEntities.push(entity);
                }
            });

            cachedRealtimeData = {
                ...freshData,
                response: {
                    ...freshData.response,
                    entity: [
                        ...transientEntities,
                        ...Array.from(activeVehiclePositions.values())
                    ]
                }
            };

            const entityStats = processEntityStatistics(freshData.response.entity ?? []);

            log("FETCH", `Realtime data`, {
                trips: entityStats.tripUpdates,
                vehicles: entityStats.vehiclePositions,
                alerts: entityStats.alerts,
                Mem: `${(process.memoryUsage().rss / (1024 ** 2)).toFixed(0)}MiB`,
                encoding: `.${response.headers.get('Content-Encoding')}`,
                in: `${Date.now() - startTime}ms`
            });

            const fastestEntity = cachedRealtimeData?.response?.entity?.reduce((fastest, current) => {
                const currSpeed = current.vehicle?.position?.speed || 0;
                const fastSpeed = fastest?.vehicle?.position?.speed || 0;
                return currSpeed > fastSpeed && current.id.startsWith('59') ? current : fastest;
            });

            if (fastestEntity?.vehicle?.position?.speed) {
                log("FASTEST", `${fastestEntity.vehicle.vehicle?.label?.replace(/\s+/g, '')}` +
                    ` ${fastestEntity.vehicle.trip?.route_id?.split("-")[0]}` +
                    ` ${fastestEntity.vehicle.trip?.direction_id ? 'DOWN' : 'UP'}`, { //UP is toward Britomart
                    v: `${(fastestEntity.vehicle.position.speed * 3.6).toFixed(1)}km/h 🚀`,
                    link: `https://maps.google.com/?q=${fastestEntity.vehicle.position.latitude.toFixed(6)},${fastestEntity.vehicle.position.longitude.toFixed(6)}`
                });
            }

        } else {
            cachedRealtimeData = freshData;
        }

        lastSuccessfulFetchTimestamp = Date.now();
    } catch (error) {
        console.error(`Data refresh failed: ${error}`);
    } finally {
        isFetchInProgress = false;
    }
}

// Startup sequence
async function initializeServer() {

    log("SYSTEM", `ENV=${process.env.NODE_ENV || 'development'}`, {
        Bun: `${Bun.version} [${Bun.revision.slice(0, 7)}]`,
        PID: `${process.pid}`,
        Platform: `${process.platform}/${process.arch}`,
        Mem: `${(process.memoryUsage().rss / (1024 * 1024)).toFixed(0)}MiB`,
    });

    await initCacheDir();
    await restoreCache();

    // Initial data fetch
    await refreshRealtimeData();
    await saveCache();

    // Setup intervals
    setInterval(refreshRealtimeData, fetchIntervalMs);
    setInterval(saveCache, saveIntervalMs);

    app.listen(port, () => {
        log("SERVER", `Listening on`, {
            port,
            uptime: `${process.uptime().toFixed(1)}s`
        });
    });
}

initializeServer().catch(error => {
    console.error('Server initialization failed:', error);
    process.exit(1);
});

app.get('/api/data', (_req, res) => {
    if (!cachedRealtimeData) {
        res.status(503).json({
            error: 'Initial data load in progress',
            lastUpdated: lastSuccessfulFetchTimestamp
        });
        return;
    }
    res.json(cachedRealtimeData);
});

app.get('/status', (_req, res) => {
    res.json({
        status: cachedRealtimeData ? 'OK' : 'INITIALIZING',
        uptime: process.uptime(),
        refreshInterval: `${fetchIntervalMs}ms`,
        lastUpdate: lastSuccessfulFetchTimestamp,
        trackedVehicles: activeVehiclePositions.size,
        nextRefreshIn: lastSuccessfulFetchTimestamp
            ? Math.max(0, Math.round(
                (fetchIntervalMs - (Date.now() - lastSuccessfulFetchTimestamp)) / 1000
            )) + 's'
            : 'N/A'
    });
});

app.get('/', (_req, res) => {
    res.send('GTFS-Realtime-Cache-Server is running');
});
