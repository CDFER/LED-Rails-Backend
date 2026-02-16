import { config as loadEnv } from 'dotenv';
import { promises as fs } from 'fs';
import path from 'path';

import { LOG_LABELS, log } from './customUtils';

import { RailNetwork } from './railNetwork';

const PORT = 3000;

// --- Configuration Loading ---

loadEnv({ quiet: true }); // Load environment variables from .env file

// --- Type Definitions ---
type RouteHandler = (req: Request) => Response | Promise<Response>;

async function initializeServer() {
    const routes = new Map<string, RouteHandler>();
    const addRoute = (method: string, url: string, handler: RouteHandler) => {
        if (method === 'GET') routes.set(url, handler);
    };

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
            log(network.id, 'API Key Missing from .env file, skipping setup.');
            // throw new Error(`${network.id} API key not found in .env file`);
        } else {

            try {
                await network.update();

                // Setup server endpoints for each board revision api
                network.ledRailsAPIs.forEach(api => {
                    addRoute('GET', api.url, () => Response.json(api.output));
                });

                const prefix = `/${network.id.toLowerCase()}-ltm`;

                // Status endpoint for monitoring
                addRoute('GET', `${prefix}/status`, () => {
                    const now = Date.now();
                    return Response.json({
                        status: network.trackedTrains.length ? 'OK' : 'ERROR',
                        epoch: Math.floor(now / 1000),
                        uptime: Number(process.uptime().toFixed(0)),
                        refreshInterval: network.config.GTFSRealtimeAPI.fetchIntervalSeconds,
                        trackBlocks: network.trackBlocks?.size ?? 0,
                        entities: network.entities.length,
                        trackedTrains: network.trackedTrains.length,
                    });
                });

                // Raw data endpoint for all vehicles
                addRoute('GET', `${prefix}/api/vehicles`, () => Response.json(network.entities));

                // Raw data endpoint for trains only
                addRoute('GET', `${prefix}/api/vehicles/trains`, () => Response.json(network.trainEntities));

                addRoute('GET', `${prefix}/api/trackedtrains`, () => Response.json(network.trackedTrains));

                // stopsMap (To make it easier to map stop IDs to names/platforms)
                if (network.stopsMap){
                    addRoute('GET', `${prefix}/api/stops`, () => Response.json(network.stopsMap));
                }

                // Simple HTML map view for debugging (serves map.html, currently http only)
                const mapPath = path.resolve(__dirname, 'map.html');
                addRoute('GET', `${prefix}/api/map`, () => new Response(Bun.file(mapPath), {
                    headers: { "Content-Type": "text/html" }
                }));

                // Simple HTML viewer for the PCB
                const viewerPath = path.resolve(__dirname, 'viewer.html');
                addRoute('GET', `${prefix}/api/viewer`, () => new Response(Bun.file(viewerPath), {
                    headers: { "Content-Type": "text/html" }
                }));

                // Position csv File for LEDs 
                const posPath = path.resolve(__dirname, 'railNetworks', network.id, 'positions.csv');
                addRoute('GET', `${prefix}/api/positions.csv`, () => new Response(Bun.file(posPath), {
                    headers: { "Content-Type": "text/csv" }
                }));

                // PCB silkscreen svg File
                const svgPath = path.resolve(__dirname, 'railNetworks', network.id, 'pcb.svg');
                addRoute('GET', `${prefix}/api/pcb.svg`, () => new Response(Bun.file(svgPath), {
                    headers: { "Content-Type": "image/svg+xml" }
                }));

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
                    blocks: network.trackBlocks?.size ?? 0,
                    APIs: network.ledRailsAPIs.length,
                });

            } catch (error) {
                log(network.id, 'Error During Setup', {
                    errorMessage: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined
                });
            }
        }
    }

    // Basic root endpoint
    addRoute('GET', '/', () => new Response('LED-Rails Backend Server is operational.', {
        headers: { 'Content-Type': 'text/plain' }
    }));

    const faviconPath = path.resolve(__dirname, 'favicon.png');
    addRoute('GET', '/favicon.ico', () => new Response(Bun.file(faviconPath)));

    Bun.serve({
        port: PORT,
        development: process.env.NODE_ENV !== "production",
        async fetch(req) {
            const url = new URL(req.url);
            const handler = routes.get(url.pathname);

            let response: Response;
            if (handler && req.method === 'GET') {
                response = await handler(req);
            } else {
                response = new Response("Not Found", { status: 404 });
            }

            // Simple Compression Middleware
            // Order of preference: zstd > brotli > gzip > deflate
            const acceptEncoding = req.headers.get("Accept-Encoding") ?? "";

            // Note: TypeScript might complain about "zstd" or "brotli" if using standard DOM types, but Bun supports them at runtime.
            let compressionFormat: CompressionFormat | "zstd" | "brotli" | null = null;
            if (acceptEncoding.includes("zstd")) {
                compressionFormat = "zstd";
            } else if (acceptEncoding.includes("br")) {
                compressionFormat = "brotli";
            } else if (acceptEncoding.includes("gzip")) {
                compressionFormat = "gzip";
            } else if (acceptEncoding.includes("deflate")) {
                compressionFormat = "deflate";
            }

            if (compressionFormat && response.body) {
                const headers = new Headers(response.headers);
                headers.set("Content-Encoding", compressionFormat === "brotli" ? "br" : compressionFormat);
                headers.delete("Content-Length");

                return new Response(response.body.pipeThrough(new CompressionStream(compressionFormat as CompressionFormat)), {
                    status: response.status,
                    statusText: response.statusText,
                    headers,
                });
            }

            return response;
        },
    });

    log(LOG_LABELS.SERVER, 'Started', {
        port: PORT,
        startup: (process.uptime() * 1000).toFixed(0) + 'ms',
    });
}

initializeServer().catch(error => {
    log(LOG_LABELS.ERROR, 'Server failed catastrophically.', {
        errorMessage: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
    });
    process.exit(1);
});