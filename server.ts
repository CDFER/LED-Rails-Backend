import express from 'express';
import compression from 'compression';
import { config as loadEnv } from 'dotenv';
import rateLimit from 'express-rate-limit';
import { promises as fs } from 'fs';
import path from 'path';

import { LOG_LABELS, log, safeParseInt } from './customUtils';

import { RailNetwork } from './railNetwork';

const PORT = 3000;

// --- Configuration Loading ---

loadEnv({ quiet: true }); // Load environment variables from .env file
const DOWNSTREAM_RATE_LIMIT_CONFIG = {
    windowMs: safeParseInt(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000), // 1 minute
    maxRequests: safeParseInt(process.env.RATE_LIMIT_MAX, 20), // Limit each IP to 20 requests per `window`
};

// --- Express Setup ---
const app = express();

const rateLimiter = rateLimit({
    windowMs: DOWNSTREAM_RATE_LIMIT_CONFIG.windowMs,
    limit: DOWNSTREAM_RATE_LIMIT_CONFIG.maxRequests,
    standardHeaders: false,
    legacyHeaders: false,
    ipv6Subnet: 64, // Rate limit per individual IPv6 address (otherwise /56 would share a limit which is too broad for NZ)
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
    res.removeHeader('X-Powered-By');
    next();
});

async function initializeServer() {
    log(LOG_LABELS.SYSTEM, 'Starting', {
        env: process.env.NODE_ENV || 'development',
        bunVersion: Bun.version,
        platform: `${process.platform}/${process.arch}`,
        mem: (process.memoryUsage().rss / (1024 ** 2)).toFixed(0) + "MiB",
    });

    // Dynamically load all rail networks from the railNetworks directory
    const railNetworksDir = path.resolve(__dirname, 'railNetworks');
    const railNetworks: RailNetwork[] = [];

    for (const entry of await fs.readdir(railNetworksDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            railNetworks.push(new RailNetwork(path.join(railNetworksDir, entry.name)));
        }
    }

    for (const network of railNetworks) {
        // Set the API key from .env file (AKL=xxxx, WLG=yyyy, etc)
        network.config.GTFSRealtimeAPI.key = process.env[network.id];

        if (!network.config.GTFSRealtimeAPI.key) {
            throw new Error(`${network.id} API key not found in .env file`);
        }

        try {
            await network.update();

            // Setup server endpoints for each board revision api
            network.ledRailsAPIs.forEach(api => {
                app.get(api.url, (_req, res) => {
                    res.json(api.output);
                });
            });

            // Status endpoint for monitoring
            app.get(`/${network.id.toLowerCase()}-ltm/status`, (_req, res) => {
                const now = Date.now();
                res.json({
                    status: network.trackedTrains.length ? 'OK' : 'ERROR',
                    epoch: Math.floor(now / 1000),
                    uptime: Number(process.uptime().toFixed(0)),
                    refreshInterval: network.config.GTFSRealtimeAPI.fetchIntervalSeconds,
                    trackBlocks: network.trackBlocks.size,
                    entities: network.entities.length,
                    trackedTrains: network.trackedTrains.length,
                });
            });

            // Raw data endpoint for all vehicles
            app.get(`/${network.id.toLowerCase()}-ltm/api/vehicles`, (_req, res) => {
                res.json(network.entities);
            });

            // Raw data endpoint for trains only
            app.get(`/${network.id.toLowerCase()}-ltm/api/vehicles/trains`, (_req, res) => {
                res.json(network.trainEntities);
            });

            app.get(`/${network.id.toLowerCase()}-ltm/api/trackedtrains`, (_req, res) => {
                res.json(network.trackedTrains);
            });

            // Simple HTML map view for debugging (serves map.html, currently http only)
            const mapPath = path.resolve(__dirname, 'map.html');
            app.get(`/${network.id.toLowerCase()}-ltm/api/map`, (_req, res) => {
                res.sendFile(mapPath);
            });

            // Periodic update loop
            setInterval(() => {
                try {
                    network.update();
                } catch (error) {
                    log(network.id, 'Error Updating', {
                        errorMessage: error instanceof Error ? error.message : String(error),
                        stack: error instanceof Error ? error.stack : undefined
                    });
                }
            }, network.config.GTFSRealtimeAPI.fetchIntervalSeconds * 1000);

            // Log some info about the rail network after setup
            log(network.id, 'Setup', {
                trains: network.trackedTrains.length,
                blocks: network.trackBlocks.size,
                APIs: network.ledRailsAPIs.length,
            });

        } catch (error) {
            log(network.id, 'Error During Setup', {
                errorMessage: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
        }
    }

    // Basic root endpoint
    app.get('/', (_req, res) => {
        res.type('text/plain').send('LED-Rails Backend Server is operational.');
    });

    app.listen(PORT, () => {
        log(LOG_LABELS.SERVER, 'Started', {
            port: PORT,
            startup: (process.uptime() * 1000).toFixed(0) + 'ms',
        });
    });
}

initializeServer().catch(error => {
    log(LOG_LABELS.ERROR, 'Server failed catastrophically.', {
        errorMessage: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
    });
    process.exit(1);
});