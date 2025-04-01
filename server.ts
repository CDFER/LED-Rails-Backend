import express from 'express';
import compression from 'compression';
import { config } from 'dotenv';
import rateLimit from 'express-rate-limit';

import type { GTFSRealtime, Entity } from 'gtfs-types';

config(); // Load environment variables from .env file

const app = express();
const port = process.env.PORT || 3000;
const subscriptionKey = process.env.API_KEY; // Matches API header name
const realtimeApiUrl = 'https://api.at.govt.nz/realtime/legacy';
const rateLimiterWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const rateLimiterMaxRequests = parseInt(process.env.RATE_LIMIT_MAX || '20', 10);
const fetchIntervalMs = parseInt(process.env.FETCH_INTERVAL_MS || '20000', 10);

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

// Caching state
let cachedRealtimeData: GTFSRealtime | undefined = undefined;
let lastSuccessfulFetchTimestamp: Date | undefined = undefined;
let isFetchInProgress = false;

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
    let tripUpdateCount = 0;
    let vehiclePositionCount = 0;
    let alertCount = 0;

    entities.forEach(entity => {
        if (entity.trip_update) tripUpdateCount++;
        if (entity.vehicle) vehiclePositionCount++;
        if (entity.alert) alertCount++;
    });

    console.log(`Realtime Data Statistics:
    - Trip Updates: ${tripUpdateCount}
    - Vehicle Positions: ${vehiclePositionCount}
    - Alerts: ${alertCount}`);
}

async function fetchData() {
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

        const data = (await response.json()) as GTFSRealtime;
        cachedRealtimeData = data;

        if (data.response.entity) {
            logEntityStatistics(data.response.entity);
        }

        lastSuccessfulFetchTimestamp = new Date();
        console.log(`Data fetched at ${lastSuccessfulFetchTimestamp.toISOString()}`);
    } catch (error) {
        console.error(`Error fetching data: ${error}`);
    } finally {
        isFetchInProgress = false;
    }
}

fetchData();
setInterval(fetchData, fetchIntervalMs);

app.get('/api/data', (_req, res) => {
    if (!cachedRealtimeData) {
        res.status(503).json({
            error: 'Data not yet available',
            lastSuccessfulFetchTimestamp
        });
        return;
    }
    res.json(cachedRealtimeData);
});

app.get('/status', (_req, res) => {
    res.json({
        status: cachedRealtimeData ? 'OK' : 'INITIALIZING',
        uptime: process.uptime(),
        fetchIntervalMs,
        lastSuccessfulFetchTimestamp,
        nextFetchInSeconds: lastSuccessfulFetchTimestamp ?
            Math.round(fetchIntervalMs / 1000 -
                (Date.now() - lastSuccessfulFetchTimestamp.getTime()) / 1000)
            : 'N/A'
    });
});

app.get('/', (_req, res) => {
    res.send('GTFS-Realtime-Cache-Server is running');
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
