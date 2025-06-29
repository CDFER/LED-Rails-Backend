import express from 'express';
import compression from 'compression'; // Standard import name
import { config as loadEnv } from 'dotenv';
import rateLimit from 'express-rate-limit';
import { promises as fs } from 'fs';
import path from 'path';

import {
    LEDMapUpdate,
    loadTrackBlocks,
    updateTrackedTrains,
    trackedTrains,
    generateLedMap,
} from './trackBlocks';

import { loadTrainPairsFromCache, checkForTrainPairs } from './trainPairs';

import type { GTFSRealtime, Entity } from 'gtfs-types';

// --- Configuration Loading ---
loadEnv(); // Load environment variables from .env file

// Helper for safely parsing environment variables
function safeParseInt(value: string | undefined, defaultValue: number): number {
    if (value === undefined) return defaultValue;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) || parsed < 0 ? defaultValue : parsed;
}

// Helper to get a consistent error message
function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
    level: 9 as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | -1, // Compression level (0-9, 9 for max compression)
    memLevel: 9 as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9, // Maximum memory usage for compression (9 is max memory)
    strategy: 2 as 0 | 1 | 2 | 3 | 4, // Z_RLE: Limit match distances to one (run-length encoding)
    // 25..31 (16+9..15): The output will have a gzip header and footer (gzip)
    windowBits: 31 as 9 | 10 | 11 | 12 | 13 | 14 | 15 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | -9 | -10 | -11 | -12 | -13 | -14 | -15,
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
let lastSuccessfulFetchTimestamp: number | undefined;
let isFetchInProgress = false;

let activeVehicleEntities: Entity[] = [];
let activeTrainEntities: Entity[] = [];

// Default LED Map structure
const defaultLedMap: LEDMapUpdate = {
    version: "default",
    timestamp: 0,
    update: Math.floor(SERVER_CONFIG.fetchIntervalMs / 1000),
    colors: {
        0: [0, 0, 0],         // Default "unoccupied" color
        1: [255, 0, 255],     // Default "out of service" color
        2: [0, 255, 0],
        3: [255, 128, 0],
        4: [0, 255, 255],
        5: [255, 0, 0],
    },
    updates: [],
};

let currentLedMap100: LEDMapUpdate = { ...defaultLedMap, version: "100" };
let currentLedMap110: LEDMapUpdate = { ...defaultLedMap, version: "110" };

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
    updatedVehicleEntities: Entity[];
}

function processIncomingEntities(
    entities: Entity[] | undefined,
    currentVehicleEntities: Entity[]
): ProcessedFeed {
    const newVehicleEntities: Entity[] = [...currentVehicleEntities];
    const transient: Entity[] = [];

    if (!entities) {
        return { transientEntities: transient, updatedVehicleEntities: newVehicleEntities };
    }

    entities.forEach(entity => {
        if (entity.trip_update) { // GTFS-RT specific check
            transient.push(entity);
        } else if (entity.vehicle) {
            if (!entity.is_deleted && entity.vehicle?.vehicle?.id) { // Ensure vehicle_id exists
                // Replace or add entity by vehicle id
                const vehicleId = entity.vehicle?.vehicle?.id;
                const idx = newVehicleEntities.findIndex(e => e.vehicle?.vehicle?.id === vehicleId);
                if (idx !== -1) {
                    newVehicleEntities[idx] = entity;
                } else {
                    newVehicleEntities.push(entity);
                }
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
    const startTime = Date.now();
    try {
        const jsonPayload = JSON.stringify(activeVehicleEntities);
        const compressedData = Bun.gzipSync(Buffer.from(jsonPayload), BUN_GZIP_OPTIONS);
        await fs.writeFile(CACHE_CONFIG.file, compressedData);
        const msPerDay = 1000 * 60 * 60 * 24; // 24 hours in milliseconds
        const estimatedDailyWriteMiB = (compressedData.byteLength * (msPerDay / CACHE_CONFIG.saveIntervalMs)) / (1024 ** 2);
        log(LOG_LABELS.CACHE, `Saved ${path.basename(CACHE_CONFIG.file)}`,
            {
                activeVehicles: activeVehicleEntities.length,
                sizeKiB: (compressedData.byteLength / 1024).toFixed(1),
                estDailyWriteMiB: estimatedDailyWriteMiB.toFixed(1),
                durationMs: Date.now() - startTime,
            });
    } catch (error) {
        log(LOG_LABELS.ERROR, `Failed to save cache to ${CACHE_CONFIG.file}`, { errorMessage: getErrorMessage(error) });
    }
}

async function restoreGtfsCache() {
    const startTime = Date.now();
    try {
        await fs.mkdir(CACHE_CONFIG.folder, { recursive: true });
    } catch (error) {
        log(LOG_LABELS.ERROR, `Could not create cache directory: ${CACHE_CONFIG.folder}`, { errorMessage: getErrorMessage(error) });
        // Proceed, as we can run without cache
    }
    try {
        const compressedData = await fs.readFile(CACHE_CONFIG.file);
        const decompressed = Bun.gunzipSync(compressedData);
        const parsedCacheData = JSON.parse(Buffer.from(decompressed).toString('utf8'));
        if (Array.isArray(parsedCacheData)) {
            activeVehicleEntities = parsedCacheData as Entity[];
        } else {
            log(LOG_LABELS.CACHE, `Restored cache data is not an array (type: ${typeof parsedCacheData}). Initializing with empty array.`);
            activeVehicleEntities = [];
        }
        const msPerDay = 1000 * 60 * 60 * 24; // 24 hours in milliseconds
        const estimatedDailyWriteMiB = (compressedData.byteLength * (msPerDay / CACHE_CONFIG.saveIntervalMs)) / (1024 ** 2);
        log(LOG_LABELS.CACHE, `Restored ${path.basename(CACHE_CONFIG.file)}`,
            {
                restoredVehicles: activeVehicleEntities.length,
                sizeKiB: (compressedData.byteLength / 1024).toFixed(1),
                estDailyWriteMiB: estimatedDailyWriteMiB.toFixed(1),
                durationMs: Date.now() - startTime,
            });
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            log(LOG_LABELS.CACHE, `No previous cache file found at ${CACHE_CONFIG.file}. Starting fresh.`);
        } else {
            log(LOG_LABELS.ERROR, `Failed to restore cache from ${CACHE_CONFIG.file}`, { errorMessage: getErrorMessage(error) });
        }
        activeVehicleEntities = [];
    }
}

// --- Core Data Refresh Logic ---
async function refreshRealtimeData() {
    if (isFetchInProgress) {
        log(LOG_LABELS.FETCH, 'Skipping fetch, another is in progress.');
        return;
    }
    isFetchInProgress = true;

    try {
        let startTime = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout
        const response = await fetch(API_CONFIG.url, {
            headers: {
                'Ocp-Apim-Subscription-Key': API_CONFIG.key as string,
                'Accept': 'application/json,application',
                'Accept-Encoding': 'gzip, deflate, br',
            },
            redirect: 'follow', // Handle redirects
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status} ${response.statusText}. URL: ${response.url}`);
        }

        const freshData = await response.json() as GTFSRealtime;
        const responseEncoding = response.headers.get('Content-Encoding') || 'identity';
        const requestTime = Date.now() - startTime;
        startTime = Date.now();
        const { updatedVehicleEntities } = processIncomingEntities(
            freshData.response?.entity,
            activeVehicleEntities // Pass current array to update from
        );

        activeVehicleEntities = updatedVehicleEntities; // Update global state

        activeTrainEntities = activeVehicleEntities.filter(entity =>
            entity.vehicle?.vehicle?.id?.startsWith('59') ?? false
        );
        const preprocessingTime = Date.now() - startTime;

        startTime = Date.now();
        const invisibleTrainIds = await checkForTrainPairs(activeTrainEntities);
        const checkForTrainPairsTime = Date.now() - startTime;

        startTime = Date.now();
        await updateTrackedTrains(activeTrainEntities, invisibleTrainIds);
        currentLedMap100 = await generateLedMap(currentLedMap100, trackedTrains);
        currentLedMap110 = await generateLedMap(currentLedMap110, trackedTrains);
        const ledMapUpdateTime = Date.now() - startTime;

        lastSuccessfulFetchTimestamp = Date.now();

        log(LOG_LABELS.FETCH, 'GTFS Realtime Data', {
            vehiclesTracked: activeVehicleEntities.length,
            trainsTracked: activeTrainEntities.length,
            encoding: responseEncoding,
            memoryMiB: (process.memoryUsage().rss / (1024 ** 2)).toFixed(0),
        });
        log(LOG_LABELS.FETCH, `Processing Times (ms)`, {
            request: requestTime,
            preprocessing: preprocessingTime,
            checkForTrainPairs: checkForTrainPairsTime,
            ledMapUpdate: ledMapUpdateTime,
        });

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
    const trainPairs = await loadTrainPairsFromCache();
    if (trainPairs) log(LOG_LABELS.CACHE, `Loaded ${trainPairs} train pairs from cache.`);

    try {
        const trackBlocks = await loadTrackBlocks(TRACK_BLOCKS_CONFIG.file);
        if (trackBlocks.size > 0) {
            log(LOG_LABELS.BLOCK, `${trackBlocks.size} track blocks loaded from ${TRACK_BLOCKS_CONFIG.file}`);
        } else {
            log(LOG_LABELS.BLOCK, `No track blocks found or loaded from ${TRACK_BLOCKS_CONFIG.file}. LED map functionality might be limited.`);
        }
    } catch (error) {
        log(LOG_LABELS.ERROR, `Failed to load track blocks from ${TRACK_BLOCKS_CONFIG.file}`, { errorMessage: getErrorMessage(error) });
    }

    log(LOG_LABELS.SYSTEM, 'Performing initial data fetch...');
    await refreshRealtimeData();

    if (activeVehicleEntities.length) {
        await saveGtfsCache();
    } else {
        log(LOG_LABELS.CACHE, 'Skipping initial cache save due to failed initial data fetch.');
    }

    log(LOG_LABELS.SYSTEM, `Setting fetch interval to ${SERVER_CONFIG.fetchIntervalMs / 1000}s.`);
    setInterval(refreshRealtimeData, SERVER_CONFIG.fetchIntervalMs);

    log(LOG_LABELS.SYSTEM, `Setting cache save interval to ${CACHE_CONFIG.saveIntervalMs / 1000}s.`);
    setInterval(saveGtfsCache, CACHE_CONFIG.saveIntervalMs);

    const isDataReady = (res: express.Response): boolean => {
        if (!activeVehicleEntities.length || !lastSuccessfulFetchTimestamp) {
            res.status(503).json({
                error: 'Service Unavailable: Data is initializing or first fetch failed.',
                lastAttemptIso: lastSuccessfulFetchTimestamp ? new Date(lastSuccessfulFetchTimestamp).toISOString() : null,
            });
            return false;
        }
        return true;
    };

    app.get('/akl-ltm/100.json', (_req, res) => {
        if (!isDataReady(res)) return;
        res.json(currentLedMap100);
    });

    app.get('/akl-ltm/110.json', (_req, res) => {
        if (!isDataReady(res)) return;
        res.json(currentLedMap110);
    });

    app.get('/trackedtrains', (_req, res) => {
        if (!isDataReady(res)) return;
        res.json(trackedTrains);
    });

    app.get('/api/data', (_req, res) => {
        if (!isDataReady(res)) return;
        res.json({
            status: 'OK',
            response: {
                header: {}, // Optionally fill with latest header if available
                entity: activeVehicleEntities,
            },
        });
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
            status: activeVehicleEntities.length && lastSuccessfulFetchTimestamp ? 'OK' : 'INITIALIZING_OR_ERROR',
            serverTimeIso: new Date(now).toISOString(),
            processUptimeSec: process.uptime().toFixed(1),
            refreshIntervalSec: SERVER_CONFIG.fetchIntervalMs / 1000,
            lastSuccessfulUpdateIso: lastSuccessfulFetchTimestamp ? new Date(lastSuccessfulFetchTimestamp).toISOString() : 'N/A',
            trackedVehiclesTotal: activeVehicleEntities.length,
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