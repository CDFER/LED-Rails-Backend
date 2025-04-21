import express from 'express';
import compressionMiddleware from 'compression'; // Renamed to avoid conflict
import { config as loadEnv } from 'dotenv';
import rateLimit from 'express-rate-limit';
import { promises as fs } from 'fs';
import path from 'path';

import type { GTFSRealtime, Entity } from 'gtfs-types';

// --- Configuration Loading ---
loadEnv(); // Load environment variables from .env file

// Helper for safely parsing environment variables
function safeParseInt(value: string | undefined, defaultValue: number): number {
    if (value === undefined) return defaultValue;
    const parsed = parseInt(value, 10);
    // Return default if parsing fails (NaN) or if value is negative where not expected
    return isNaN(parsed) || parsed < 0 ? defaultValue : parsed;
}

// --- Application Constants & Config ---
const LOG_LABELS = {
    SYSTEM: 'SYSTEM',
    SERVER: 'SERVER',
    CACHE: 'CACHE',
    FETCH: 'FETCH',
    ERROR: 'ERROR',
};

const GZIP_OPTIONS = {
    level: 9,      // Max compression
    memLevel: 9,   // Max memory for better compression
    strategy: 2,   // Z_RLE strategy suitable for repetitive data
    windowBits: 31 // Use gzip format with max window size
};

const apiConfig = {
    url: process.env.GTFS_REALTIME_API_URL || 'https://api.at.govt.nz/realtime/legacy',
    key: process.env.API_KEY,
};

const cacheConfig = {
    dir: path.join(__dirname, 'cache'),
    file: path.join(__dirname, 'cache', 'realtime_cache.json.gz'), // Simplified path join
    saveIntervalMs: safeParseInt(process.env.SAVE_INTERVAL_S, 180) * 1000,
};

const serverConfig = {
    port: safeParseInt(process.env.PORT, 3000),
    fetchIntervalMs: safeParseInt(process.env.FETCH_INTERVAL_S, 20) * 1000,
};

const rateLimitConfig = {
    windowMs: safeParseInt(process.env.RATE_LIMIT_WINDOW_MS, 60000),
    maxRequests: safeParseInt(process.env.RATE_LIMIT_MAX, 20),
};

// --- Critical Config Check ---
if (!apiConfig.key) {
    throw new Error('API_KEY environment variable is required');
}

// --- Express App Setup ---
const app = express();

// --- Utility Functions ---
function getPrecisionTimestamp(): string {
    const d = new Date();
    return [
        d.getHours().toString().padStart(2, '0'),
        d.getMinutes().toString().padStart(2, '0'),
        d.getSeconds().toString().padStart(3, '0') + '.' + // Seconds with milliseconds
        d.getMilliseconds().toString().padStart(3, '0')
    ].join(':');
}

function log(label: string, message: string, extra?: Record<string, unknown>) {
    const parts = [
        `[${getPrecisionTimestamp()}]`,
        `[${label}]`.padEnd(8), // Ensure consistent label padding
        message,
        // Safely format extra properties
        ...Object.entries(extra || {}).map(([k, v]) => `${k}=${v instanceof Date ? v.toISOString() : String(v)}`)
    ];
    console.log(parts.join(' | '));
}

// --- State Management ---
let cachedRealtimeData: GTFSRealtime | undefined;
let lastSuccessfulFetchTimestamp: number | undefined;
let isFetchInProgress = false;
// Stores the most recent non-deleted vehicle position entity for each vehicle ID
let activeVehiclePositions = new Map<string, Entity>();

// --- Middleware Setup ---
const rateLimiter = rateLimit({
    windowMs: rateLimitConfig.windowMs,
    max: rateLimitConfig.maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        status: 429,
        error: 'Too many requests - please try again later'
    }
});
app.use(rateLimiter);

app.use(compressionMiddleware({
    threshold: 1024, // Only compress responses larger than 1KB
    level: GZIP_OPTIONS.level, // Use consistent compression level
}));

app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*'); // Basic CORS headers
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// --- Cache Operations ---
async function initCacheDir() {
    try {
        await fs.mkdir(cacheConfig.dir, { recursive: true });
        log(LOG_LABELS.CACHE, `Cache directory ensured at ${cacheConfig.dir}`);
    } catch (error) {
        log(LOG_LABELS.ERROR, `Could not create cache directory: ${cacheConfig.dir}`, { error });
        // Decide if this is fatal. For now, we continue, but saving might fail.
    }
}

// Processes entities from a raw GTFS-RT feed, separating vehicle updates
// and calculating basic statistics. Updates the activeVehiclePositions map.
function processIncomingEntities(
    entities: Entity[] | undefined,
    currentActiveVehicles: Map<string, Entity>
): {
    transient: Entity[],
    updatedVehicles: Map<string, Entity>,
    stats: { tripUpdates: number, vehiclePositions: number, alerts: number, deletedVehicles: number }
} {
    if (!entities) {
        return { transient: [], updatedVehicles: currentActiveVehicles, stats: { tripUpdates: 0, vehiclePositions: 0, alerts: 0, deletedVehicles: 0 } };
    }

    const transientEntities: Entity[] = [];
    // Clone the map to avoid modifying the original during processing, return the new one
    const updatedVehicles = new Map<string, Entity>(currentActiveVehicles);
    const stats = { tripUpdates: 0, vehiclePositions: 0, alerts: 0, deletedVehicles: 0 };

    entities.forEach(entity => {
        if (entity.vehicle) {
            stats.vehiclePositions++;
            if (entity.is_deleted) {
                stats.deletedVehicles++;
                updatedVehicles.delete(entity.id); // Remove deleted vehicle
            } else {
                updatedVehicles.set(entity.id, entity); // Add or update active vehicle
            }
        } else {
            // Assume non-vehicle entities are transient (trip updates, alerts)
            transientEntities.push(entity);
            if (entity.trip_update) stats.tripUpdates++;
            if (entity.alert) stats.alerts++;
        }
    });
    return { transient: transientEntities, updatedVehicles, stats };
}


async function saveCache() {
    if (!cachedRealtimeData) {
        log(LOG_LABELS.CACHE, 'Skipping save, no data in memory.');
        return;
    }

    const startTime = Date.now();
    try {
        // Directly use the cached data, no need for intermediate copy
        const jsonPayload = JSON.stringify(cachedRealtimeData);
        const jsonSize = Buffer.byteLength(jsonPayload);

        const compressedData = Bun.gzipSync(Buffer.from(jsonPayload), GZIP_OPTIONS); // Pass Buffer for clarity

        await fs.writeFile(cacheConfig.file, compressedData);

        const msPerDay = 86400000; // 1000 * 60 * 60 * 24
        const estimatedDailyWrite = (compressedData.byteLength * (msPerDay / cacheConfig.saveIntervalMs)) / (1024 ** 2); // MiB

        log(LOG_LABELS.CACHE, `Saved ${path.basename(cacheConfig.file)}`, {
            activeVehicles: activeVehiclePositions.size, // Log current active count
            size: `${(compressedData.byteLength / 1024).toFixed(1)} KiB`,
            ratio: `${((compressedData.byteLength / jsonSize) * 100).toFixed(1)}%`,
            estDailyWrite: `${estimatedDailyWrite.toFixed(1)} MiB/Day`,
            in: `${Date.now() - startTime}ms`
        });
    } catch (error) {
        log(LOG_LABELS.ERROR, `Failed to save cache to ${cacheConfig.file}`, { error });
    }
}

async function restoreCache() {
    const startTime = Date.now();
    try {
        const compressedData = await fs.readFile(cacheConfig.file);
        const decompressed = Bun.gunzipSync(compressedData);

        // Using 'as' assumes the stored data structure matches GTFSRealtime.
        // Validation could be added here for robustness if schema drift is a concern.
        const parsed = JSON.parse(Buffer.from(decompressed).toString('utf8')) as GTFSRealtime;

        // Restore main data
        cachedRealtimeData = parsed;

        // Rebuild the active vehicle map from the restored data.
        // This assumes the saved cache file correctly contains all needed vehicle entities.
        const { updatedVehicles } = processIncomingEntities(
            parsed.response?.entity,
            new Map<string, Entity>() // Start with an empty map
        );
        activeVehiclePositions = updatedVehicles; // Assign the rebuilt map

        const msPerDay = 86400000;
        const estimatedDailyWrite = (compressedData.byteLength * (msPerDay / cacheConfig.saveIntervalMs)) / (1024 ** 2); // MiB

        log(LOG_LABELS.CACHE, `Restored ${path.basename(cacheConfig.file)}`, {
            vehicles: activeVehiclePositions.size,
            size: `${(compressedData.byteLength / 1024).toFixed(1)} KiB`,
            estDailyWrite: `${estimatedDailyWrite.toFixed(1)} MiB/Day`,
            in: `${Date.now() - startTime}ms`
        });

    } catch (error) {
        // Log different messages based on error type (file not found vs other errors)
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            log(LOG_LABELS.CACHE, `No previous cache file found at ${cacheConfig.file}. Starting fresh.`);
        } else {
            log(LOG_LABELS.ERROR, `Failed to restore cache from ${cacheConfig.file}`, { message: error instanceof Error ? error.message : String(error) });
        }
        // Ensure state is clean if restore fails
        cachedRealtimeData = undefined;
        activeVehiclePositions.clear();
    }
}


// --- Core Data Refresh Logic ---
async function refreshRealtimeData() {
    if (isFetchInProgress) {
        log(LOG_LABELS.FETCH, 'Skipping fetch, previous one still in progress.');
        return;
    }
    isFetchInProgress = true;
    const startTime = Date.now();

    try {
        log(LOG_LABELS.FETCH, `Requesting data from ${apiConfig.url}`);
        const response = await fetch(apiConfig.url, {
            headers: {
                'Ocp-Apim-Subscription-Key': apiConfig.key as string, // Assertion safe due to startup check
                'Accept': 'application/json', // Prefer JSON if available
                'Accept-Encoding': 'gzip, deflate, br' // Accept compressed responses
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status} ${response.statusText}`);
        }

        // Using 'as' assumes API response matches GTFSRealtime. Validation could be added.
        const freshData = await response.json() as GTFSRealtime;
        const responseEncoding = response.headers.get('Content-Encoding') || 'identity';

        // Process the received entities
        const { transient, updatedVehicles, stats } = processIncomingEntities(
            freshData.response?.entity,
            activeVehiclePositions // Pass the current map
        );

        // Update the global state
        activeVehiclePositions = updatedVehicles; // Assign the newly processed map

        // Reconstruct the cached data object with transient entities + current active vehicles
        cachedRealtimeData = {
            header: freshData.header, // Keep original header
            response: {
                ...(freshData.response || {}), // Keep other potential response fields
                entity: [
                    ...transient,
                    ...Array.from(activeVehiclePositions.values()) // Combine
                ]
            }
        };

        lastSuccessfulFetchTimestamp = Date.now(); // Update timestamp *after* successful processing

        log(LOG_LABELS.FETCH, `Realtime data processed`, {
            trips: stats.tripUpdates,
            vehiclesInFeed: stats.vehiclePositions, // Vehicles in this specific feed
            activeVehicles: activeVehiclePositions.size, // Total tracked vehicles
            deletedVehicles: stats.deletedVehicles,
            alerts: stats.alerts,
            encoding: responseEncoding,
            mem: `${(process.memoryUsage().rss / (1024 ** 2)).toFixed(0)} MiB`,
            in: `${Date.now() - startTime}ms`
        });

    } catch (error) {
        log(LOG_LABELS.ERROR, 'Data refresh failed', { message: error instanceof Error ? error.message : String(error) });
        // Optionally: Implement retry logic or backoff here
    } finally {
        isFetchInProgress = false;
    }
}

// --- Server Initialization and Routes ---
async function initializeServer() {
    log(LOG_LABELS.SYSTEM, `Initializing Server`, {
        env: process.env.NODE_ENV || 'development',
        bunVersion: Bun.version,
        bunRevision: Bun.revision.slice(0, 7),
        pid: process.pid,
        platform: `${process.platform}/${process.arch}`,
        initialMem: `${(process.memoryUsage().rss / (1024 ** 2)).toFixed(0)} MiB`,
    });

    await initCacheDir();
    await restoreCache(); // Attempt to load previous state

    log(LOG_LABELS.SYSTEM, 'Performing initial data fetch...');
    await refreshRealtimeData(); // Fetch initial data before starting server

    // Initial save only if data was successfully fetched
    if (cachedRealtimeData) {
        await saveCache();
    } else {
        log(LOG_LABELS.CACHE, 'Skipping initial save due to failed initial fetch.');
    }

    // Setup periodic tasks
    log(LOG_LABELS.SYSTEM, `Setting fetch interval to ${serverConfig.fetchIntervalMs}ms`);
    setInterval(refreshRealtimeData, serverConfig.fetchIntervalMs);

    log(LOG_LABELS.SYSTEM, `Setting cache save interval to ${cacheConfig.saveIntervalMs}ms`);
    setInterval(saveCache, cacheConfig.saveIntervalMs);

    // --- Helper Function for Data Readiness Check ---
    const checkDataReady = (res: express.Response): boolean => {
        if (!cachedRealtimeData || !lastSuccessfulFetchTimestamp) {
            res.status(503).json({
                error: 'Service Unavailable: Data is initializing or first fetch failed.',
                lastAttempt: lastSuccessfulFetchTimestamp ? new Date(lastSuccessfulFetchTimestamp).toISOString() : null,
            });
            return false;
        }
        return true;
    }

    // --- API Endpoints ---

    // Get all cached data (trip updates, alerts, all vehicle positions)
    app.get('/api/data', (_req, res) => {
        if (!checkDataReady(res)) return;
        // Send the latest successfully processed data
        res.json(cachedRealtimeData);
    });

    // Get only the latest position for *all* tracked vehicles
    app.get('/api/vehicles', (_req, res) => {
        if (!checkDataReady(res)) return;
        // activeVehiclePositions stores exactly this data
        const allVehicles = Array.from(activeVehiclePositions.values());
        res.json(allVehicles);
    });

    // Get only the latest position for *train* vehicles (ID starts with '59')
    app.get('/api/vehicles/trains', (_req, res) => {
        if (!checkDataReady(res)) return;
        const trainEntities = Array.from(activeVehiclePositions.values()).filter(entity =>
            // Check if vehicle.id exists and starts with '59'
            entity.vehicle?.vehicle?.id?.startsWith('59') ?? false
        );
        res.json(trainEntities);
    });

    // Get server status
    app.get('/status', (_req, res) => {
        const now = Date.now();
        let nextRefreshInSeconds: number | null = null;
        if (lastSuccessfulFetchTimestamp) {
            const elapsedSinceLastFetch = now - lastSuccessfulFetchTimestamp;
            const remainingTime = serverConfig.fetchIntervalMs - elapsedSinceLastFetch;
            nextRefreshInSeconds = Math.max(0, Math.round(remainingTime / 1000));
        }

        // Include counts for different vehicle types in status
        const trainCount = Array.from(activeVehiclePositions.values()).filter(e => e.vehicle?.vehicle?.id?.startsWith('59') ?? false).length;

        res.json({
            status: cachedRealtimeData ? 'OK' : 'INITIALIZING',
            serverTime: new Date(now).toISOString(),
            processUptime: process.uptime().toFixed(1) + 's',
            refreshInterval: `${serverConfig.fetchIntervalMs / 1000}s`,
            lastUpdateTimestamp: lastSuccessfulFetchTimestamp,
            lastUpdateHuman: lastSuccessfulFetchTimestamp ? new Date(lastSuccessfulFetchTimestamp).toISOString() : 'N/A',
            trackedVehiclesTotal: activeVehiclePositions.size,
            trackedVehiclesTrains: trainCount,
            fetchInProgress: isFetchInProgress,
            nextRefreshIn: nextRefreshInSeconds !== null ? `${nextRefreshInSeconds}s` : (isFetchInProgress ? 'pending' : 'N/A'),
        });
    });

    // Root path
    app.get('/', (_req, res) => {
        res.type('text/plain').send('GTFS-Realtime Cache Server is running');
    });

    // Start listening
    app.listen(serverConfig.port, () => {
        log(LOG_LABELS.SERVER, `Listening on port ${serverConfig.port}`, {
            startupTime: `${process.uptime().toFixed(1)}s`
        });
    });
}

// --- Start the server ---
initializeServer().catch(error => {
    log(LOG_LABELS.ERROR, 'Server initialization failed catastrophically', { error });
    process.exit(1); // Exit if initialization fails critically
});