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
const fetchIntervalMs = parseInt(process.env.FETCH_INTERVAL_MS || '20000', 10);
const saveIntervalMs = parseInt(process.env.SAVE_INTERVAL_MS || '30000', 10);

// File system paths
const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'realtime_cache.json');

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

// Cache state management
let cachedRealtimeData: GTFSRealtime | undefined;
let lastSuccessfulFetchTimestamp: Date | undefined;
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
async function persistCache() {
    if (!cachedRealtimeData) return;

    try {
        const cacheData = {
            ...cachedRealtimeData,
            _metadata: {
                savedAt: new Date().toISOString(),
                vehicleCount: activeVehiclePositions.size
            }
        };

        await fs.writeFile(CACHE_FILE, JSON.stringify(cacheData));
        console.log(`Cache persisted at ${new Date().toLocaleTimeString()}`);
    } catch (error) {
        console.error('Failed to persist cache:', error);
    }
}

// Load cache from disk
async function restoreCache() {
    try {
        const data = await fs.readFile(CACHE_FILE, 'utf-8');
        const parsed = JSON.parse(data) as GTFSRealtime & {
            _metadata?: {
                savedAt: string;
                vehicleCount: number
            }
        };

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

        // Restore timestamp if available
        if (parsed._metadata?.savedAt) {
            lastSuccessfulFetchTimestamp = new Date(parsed._metadata.savedAt);
        }

        console.log(`Restored cache with ${activeVehiclePositions.size} vehicles`);
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

function logEntityStatistics(entities: Entity[]) {
    const statistics = entities.reduce((acc, entity) => {
        if (entity.trip_update) acc.tripUpdates++;
        if (entity.vehicle) acc.vehiclePositions++;
        if (entity.alert) acc.alerts++;
        return acc;
    }, { tripUpdates: 0, vehiclePositions: 0, alerts: 0 });

    console.log(`Realtime Data Statistics:
    - Trip Updates: ${statistics.tripUpdates}
    - Vehicle Positions: ${statistics.vehiclePositions}
    - Alerts: ${statistics.alerts}`);
}

async function refreshRealtimeData() {
    if (isFetchInProgress) return;
    isFetchInProgress = true;

    try {
        const response = await fetch(realtimeApiUrl, {
            headers: {
                'Ocp-Apim-Subscription-Key': subscriptionKey as string,
                'Accept': 'application/json'
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

            logEntityStatistics(cachedRealtimeData.response.entity ?? []);
        } else {
            cachedRealtimeData = freshData;
        }

        lastSuccessfulFetchTimestamp = new Date();
        console.log(`Data refreshed at ${lastSuccessfulFetchTimestamp.toISOString()}`);
    } catch (error) {
        console.error(`Data refresh failed: ${error}`);
    } finally {
        isFetchInProgress = false;
    }
}

// Modified startup sequence
async function initializeServer() {
    await initCacheDir();
    await restoreCache();

    // Initial data fetch
    await refreshRealtimeData();

    // Setup intervals
    setInterval(refreshRealtimeData, fetchIntervalMs);
    setInterval(persistCache, saveIntervalMs);

    app.listen(port, () => {
        console.log(`Server operational on port ${port}`);
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
                (fetchIntervalMs - (Date.now() - lastSuccessfulFetchTimestamp.getTime())) / 1000
            )) + 's'
            : 'N/A'
    });
});

app.get('/', (_req, res) => {
    res.send('GTFS-Realtime-Cache-Server is running');
});
