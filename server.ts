import express from 'express';
import compression from 'compression'; // Standard import name
import { config as loadEnv } from 'dotenv';
import rateLimit from 'express-rate-limit';
import { promises as fs } from 'fs';
import path from 'path';

import {
    TrackBlock,
    LedMap,
    loadTrackBlocks,
    updateLedMapWithOccupancy
} from './trackBlocks';

import type { GTFSRealtime, Entity } from 'gtfs-types';

// --- Configuration Loading ---
loadEnv(); // Load environment variables from .env file

// Helper for safely parsing environment variables
function safeParseInt(value: string | undefined, defaultValue: number): number {
    if (value === undefined) return defaultValue;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) || parsed < 0 ? defaultValue : parsed;
}

// --- Application Constants & Config ---
// Log labels can be max 6 characters long
const LOG_LABELS = {
    SYSTEM: 'SYSTEM',
    SERVER: 'SERVER',
    CACHE: 'CACHE',
    FETCH: 'FETCH',
    LEDMAP: 'LEDMAP',
    BLOCK: 'BLOCK',
    ERROR: 'ERROR',
};

// GZIP_OPTIONS for Bun.gzipSync
const BUN_GZIP_OPTIONS = {
    level: 9 as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | -1,
    memLevel: 9 as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9,
    // strategy: 2, // Z_RLE - check if Bun supports this strategy identifier
    // windowBits: 31, // For gzip, this is typically 15. 16+15 might indicate gzip header. Verify with Bun docs.
};

const API_CONFIG = {
    url: process.env.GTFS_REALTIME_API_URL || 'https://api.at.govt.nz/realtime/legacy',
    key: process.env.API_KEY,
};

const CACHE_CONFIG = {
    folder: path.join(__dirname, 'cache'),
    file: path.join(__dirname, 'cache', 'gtfs-realtime-cache.json.gz'),
    saveIntervalMs: safeParseInt(process.env.SAVE_INTERVAL_S, 180) * 1000,
};

const SERVER_CONFIG = {
    port: safeParseInt(process.env.PORT, 3000),
    fetchIntervalMs: safeParseInt(process.env.FETCH_INTERVAL_S, 20) * 1000,
};

const TRACK_BLOCKS_CONFIG = {
    file: path.join(__dirname, 'trackBlocks.kml'),
};

const DOWNSTREAM_RATE_LIMIT_CONFIG = {
    windowMs: safeParseInt(process.env.RATE_LIMIT_WINDOW_MS, 60000),
    maxRequests: safeParseInt(process.env.RATE_LIMIT_MAX, 20),
};

// --- Critical Config Check ---
if (!API_CONFIG.key) {
    throw new Error('API_KEY environment variable is required. Please set it in your .env file.');
}

// --- Express App Setup ---
const app = express();

// --- Utility Functions ---
function getPrecisionTimestamp(): string {
    const d = new Date();
    const hours = d.getHours().toString().padStart(2, '0');
    const minutes = d.getMinutes().toString().padStart(2, '0');
    const seconds = d.getSeconds().toString().padStart(2, '0');
    const milliseconds = d.getMilliseconds().toString().padStart(3, '0');
    return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function log(label: string, message: string, extra?: Record<string, unknown>) {
    const timestamp = `[${getPrecisionTimestamp()}]`;
    const labelStr = `[${label}]`.padEnd(8);
    const extraStr = extra ? Object.entries(extra)
        .map(([k, v]) => `${k}=${v instanceof Date ? v.toISOString() : String(v)}`)
        .join(' | ') : '';

    console.log([timestamp, labelStr, message, extraStr].filter(Boolean).join(' | '));
}

// --- State Management ---
let cachedRealtimeData: GTFSRealtime | undefined;
let lastSuccessfulFetchTimestamp: number | undefined;
let isFetchInProgress = false;

let activeVehicleEntities = new Map<string, Entity>();
let activeTrainEntities: Entity[] = [];

let trackBlockDefinitions: TrackBlock[] = [];

// Initial LedMap structure
let currentLedMap: LedMap = {
    version: "1.0.0",
    lineColors: {
        "1": "#800080", // Default "out of service" color
        "2": "#004000",
        "3": "#804000",
        "4": "#008080",
        "5": "#ff0000",
    },
    busses: [
        { busId: "STRAND_MNK", leds: {} },
        { busId: "NAL_NIMT", leds: {} }
    ]
};

// --- Middleware Setup ---
const rateLimiter = rateLimit({
    windowMs: DOWNSTREAM_RATE_LIMIT_CONFIG.windowMs,
    max: DOWNSTREAM_RATE_LIMIT_CONFIG.maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        status: 429,
        error: 'Too many requests - please try again later',
    },
});
app.use(rateLimiter);

app.use(compression({
    threshold: 1024, // Only compress responses larger than 1KB
    level: 9, // Max compression for 'compression' middleware
}));

app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// --- Data Processing ---
interface ProcessedFeed {
    transientEntities: Entity[];
    updatedVehicleEntities: Map<string, Entity>;
}

function processIncomingEntities(
    entities: Entity[] | undefined,
    currentVehicleEntities: Map<string, Entity>
): ProcessedFeed {
    const newVehicleEntities = new Map<string, Entity>(currentVehicleEntities);
    const transient: Entity[] = [];

    if (!entities) {
        return { transientEntities: transient, updatedVehicleEntities: newVehicleEntities };
    }

    entities.forEach(entity => {
        if (entity.trip_update) { // GTFS-RT specific check
            transient.push(entity);
        } else if (entity.vehicle) {
            if (!entity.is_deleted && entity.vehicle.vehicle?.id) { // Ensure vehicle_id exists
                newVehicleEntities.set(entity.vehicle.vehicle.id, entity);
            } else if (entity.is_deleted && entity.vehicle.vehicle?.id) {
                newVehicleEntities.delete(entity.vehicle.vehicle.id); // Handle deletions
            }
        } else if (entity.alert) { // GTFS-RT specific check
            transient.push(entity);
        } else {
            // Other entity types considered transient or logged if unexpected
            transient.push(entity);
        }
    });
    return { transientEntities: transient, updatedVehicleEntities: newVehicleEntities };
}

// --- Cache Operations ---
async function saveGtfsCache() {
    if (!cachedRealtimeData) {
        log(LOG_LABELS.CACHE, 'Skipping save, no data in memory.');
        return;
    }

    const startTime = Date.now();
    try {
        const jsonPayload = JSON.stringify(cachedRealtimeData);
        const compressedData = Bun.gzipSync(Buffer.from(jsonPayload), BUN_GZIP_OPTIONS);

        await fs.writeFile(CACHE_CONFIG.file, compressedData);

        const msPerDay = 86400000;
        const estimatedDailyWriteMiB = (compressedData.byteLength * (msPerDay / CACHE_CONFIG.saveIntervalMs)) / (1024 ** 2);

        log(LOG_LABELS.CACHE, `Saved ${path.basename(CACHE_CONFIG.file)}`, {
            activeVehicles: activeVehicleEntities.size,
            sizeKiB: (compressedData.byteLength / 1024).toFixed(1),
            estDailyWriteMiB: estimatedDailyWriteMiB.toFixed(1),
            durationMs: Date.now() - startTime,
        });
    } catch (error) {
        log(LOG_LABELS.ERROR, `Failed to save cache to ${CACHE_CONFIG.file}`, { errorMessage: error instanceof Error ? error.message : String(error) });
    }
}

async function restoreGtfsCache() {
    const startTime = Date.now();
    try {
        await fs.mkdir(CACHE_CONFIG.folder, { recursive: true });
    } catch (dirError) {
        log(LOG_LABELS.ERROR, `Could not create cache directory: ${CACHE_CONFIG.folder}`, { errorMessage: dirError instanceof Error ? dirError.message : String(dirError) });
        // Proceed, as we can run without cache
    }

    try {
        const compressedData = await fs.readFile(CACHE_CONFIG.file);
        const decompressed = Bun.gunzipSync(compressedData);
        const parsedData = JSON.parse(Buffer.from(decompressed).toString('utf8')) as GTFSRealtime;

        cachedRealtimeData = parsedData;

        // Rebuild active vehicle map from the restored entities
        const { updatedVehicleEntities } = processIncomingEntities(
            parsedData.response?.entity,
            new Map<string, Entity>() // Start fresh for rebuilding active vehicles
        );
        activeVehicleEntities = updatedVehicleEntities;

        const msPerDay = 86400000;
        const estimatedDailyWriteMiB = (compressedData.byteLength * (msPerDay / CACHE_CONFIG.saveIntervalMs)) / (1024 ** 2);

        log(LOG_LABELS.CACHE, `Restored ${path.basename(CACHE_CONFIG.file)}`, {
            restoredVehicles: activeVehicleEntities.size,
            sizeKiB: (compressedData.byteLength / 1024).toFixed(1),
            estDailyWriteMiB: estimatedDailyWriteMiB.toFixed(1),
            durationMs: Date.now() - startTime,
        });
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            log(LOG_LABELS.CACHE, `No previous cache file found at ${CACHE_CONFIG.file}. Starting fresh.`);
        } else {
            log(LOG_LABELS.ERROR, `Failed to restore cache from ${CACHE_CONFIG.file}`, { errorMessage: error instanceof Error ? error.message : String(error) });
        }
        cachedRealtimeData = undefined; // Ensure clean state if restore fails
        activeVehicleEntities.clear();
    }
}

// --- Core Data Refresh Logic ---
async function refreshRealtimeData() {
    if (isFetchInProgress) {
        log(LOG_LABELS.FETCH, 'Skipping fetch, another is in progress.');
        return;
    }
    isFetchInProgress = true;
    const requestStartTime = Date.now();

    try {
        // log(LOG_LABELS.FETCH, `Requesting data from ${API_CONFIG.url}`);
        const response = await fetch(API_CONFIG.url, {
            headers: {
                'Ocp-Apim-Subscription-Key': API_CONFIG.key as string,
                'Accept': 'application/json,application',
                'Accept-Encoding': 'gzip, deflate, br',
            },
            redirect: 'follow', // Handle redirects
            timeout: 15000, // 15 second timeout for fetch
        });

        const processingStartTime = Date.now();
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status} ${response.statusText}. URL: ${response.url}`);
        }

        const freshData = await response.json() as GTFSRealtime;
        const responseEncoding = response.headers.get('Content-Encoding') || 'identity';

        const { transientEntities, updatedVehicleEntities } = processIncomingEntities(
            freshData.response?.entity,
            activeVehicleEntities // Pass current map to update from
        );

        activeVehicleEntities = updatedVehicleEntities; // Update global state

        cachedRealtimeData = {
            header: freshData.header,
            response: {
                ...(freshData.response || {}),
                entity: [
                    ...transientEntities,
                    ...Array.from(activeVehicleEntities.values()), // Combine for full cache
                ],
            },
        };

        activeTrainEntities = Array.from(activeVehicleEntities.values()).filter(entity =>
            entity.vehicle?.vehicle?.id?.startsWith('59') ?? false
        );

        currentLedMap = await updateLedMapWithOccupancy(trackBlockDefinitions, activeTrainEntities, currentLedMap);

        lastSuccessfulFetchTimestamp = Date.now();

        log(LOG_LABELS.FETCH, 'GTFS Realtime Data', {
            vehiclesTracked: activeVehicleEntities.size,
            trainsTracked: activeTrainEntities.length,
            encoding: responseEncoding,
            memoryMiB: (process.memoryUsage().rss / (1024 ** 2)).toFixed(0),
            requestMs: processingStartTime - requestStartTime,
            processingMs: Date.now() - processingStartTime,
        });

    } catch (error) {
        log(LOG_LABELS.ERROR, 'Data refresh failed.', { errorMessage: error instanceof Error ? error.message : String(error) });
    } finally {
        isFetchInProgress = false;
    }
}

// --- Server Initialization and Routes ---
async function initializeServer() {
    log(LOG_LABELS.SYSTEM, 'Initializing Server...', {
        env: process.env.NODE_ENV || 'development',
        bunVersion: Bun.version,
        pid: process.pid,
        platform: `${process.platform}/${process.arch}`,
        initialMemoryMiB: (process.memoryUsage().rss / (1024 ** 2)).toFixed(0),
    });

    await restoreGtfsCache();

    try {
        trackBlockDefinitions = await loadTrackBlocks(TRACK_BLOCKS_CONFIG.file);
        if (trackBlockDefinitions.length > 0) {
            log(LOG_LABELS.BLOCK, `${trackBlockDefinitions.length} track blocks loaded from ${TRACK_BLOCKS_CONFIG.file}`);
        } else {
            log(LOG_LABELS.BLOCK, `No track blocks found or loaded from ${TRACK_BLOCKS_CONFIG.file}. LED map functionality might be limited.`);
        }
    } catch (error) {
        log(LOG_LABELS.ERROR, `Failed to load track blocks from ${TRACK_BLOCKS_CONFIG.file}`, { errorMessage: error instanceof Error ? error.message : String(error) });
    }


    log(LOG_LABELS.SYSTEM, 'Performing initial data fetch...');
    await refreshRealtimeData();

    if (cachedRealtimeData) {
        await saveGtfsCache();
    } else {
        log(LOG_LABELS.CACHE, 'Skipping initial cache save due to failed initial data fetch.');
    }

    log(LOG_LABELS.SYSTEM, `Setting fetch interval to ${SERVER_CONFIG.fetchIntervalMs / 1000}s.`);
    setInterval(refreshRealtimeData, SERVER_CONFIG.fetchIntervalMs);

    log(LOG_LABELS.SYSTEM, `Setting cache save interval to ${CACHE_CONFIG.saveIntervalMs / 1000}s.`);
    setInterval(saveGtfsCache, CACHE_CONFIG.saveIntervalMs);

    const isDataReady = (res: express.Response): boolean => {
        if (!cachedRealtimeData || !lastSuccessfulFetchTimestamp) {
            res.status(503).json({
                error: 'Service Unavailable: Data is initializing or first fetch failed.',
                lastAttemptIso: lastSuccessfulFetchTimestamp ? new Date(lastSuccessfulFetchTimestamp).toISOString() : null,
            });
            return false;
        }
        return true;
    };

    app.get('/ledmap100.json', (_req, res) => {
        if (!isDataReady(res)) return;
        res.json(currentLedMap);
    });

    app.get('/api/data', (_req, res) => {
        if (!isDataReady(res)) return;
        res.json(cachedRealtimeData); // Entire cached GTFS-RT feed
    });

    app.get('/api/vehicles', (_req, res) => {
        if (!isDataReady(res)) return;
        res.json(activeVehicleEntities);
    });

    app.get('/api/vehicles/trains', (_req, res) => {
        if (!isDataReady(res)) return;
        res.json(activeTrainEntities);
    });

    app.get('/status', (_req, res) => {
        const now = Date.now();
        let nextRefreshInSec: number | null = null;
        if (lastSuccessfulFetchTimestamp) {
            const elapsedSinceLastFetchMs = now - lastSuccessfulFetchTimestamp;
            const remainingTimeMs = SERVER_CONFIG.fetchIntervalMs - elapsedSinceLastFetchMs;
            nextRefreshInSec = Math.max(0, Math.round(remainingTimeMs / 1000));
        }

        res.json({
            status: cachedRealtimeData && lastSuccessfulFetchTimestamp ? 'OK' : 'INITIALIZING_OR_ERROR',
            serverTimeIso: new Date(now).toISOString(),
            processUptimeSec: process.uptime().toFixed(1),
            refreshIntervalSec: SERVER_CONFIG.fetchIntervalMs / 1000,
            lastSuccessfulUpdateIso: lastSuccessfulFetchTimestamp ? new Date(lastSuccessfulFetchTimestamp).toISOString() : 'N/A',
            trackedVehiclesTotal: activeVehicleEntities.size,
            trackedTrains: activeTrainEntities.length,
            fetchInProgress: isFetchInProgress,
            nextRefreshInSec: nextRefreshInSec !== null ? nextRefreshInSec : (isFetchInProgress ? 'pending_completion' : 'N/A'),
            memoryUsageMiB: (process.memoryUsage().rss / (1024 ** 2)).toFixed(1),
        });
    });

    app.get('/', (_req, res) => {
        res.type('text/plain').send('GTFS-Realtime Cache Server is operational.');
    });

    app.listen(SERVER_CONFIG.port, () => {
        log(LOG_LABELS.SERVER, `Server listening on port ${SERVER_CONFIG.port}`, {
            startupDurationSec: process.uptime().toFixed(1),
            mode: process.env.NODE_ENV || 'development'
        });
    });
}

initializeServer().catch(error => {
    log(LOG_LABELS.ERROR, 'Server initialization failed catastrophically.', {
        errorMessage: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
    });
    process.exit(1);
});