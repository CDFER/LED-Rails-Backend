import type { FeedMessage, GTFSRealtime, Entity } from 'gtfs-types';
import * as fs from 'fs';
import * as path from 'path';
import * as protobuf from 'protobufjs';


// Import LED board API, track block loader, train tracking, and LED map generator
import {
    LEDRailsAPI,
    loadTrackBlocks,
    TrackBlockMap,
    updateTrackedTrains,
    TrainInfo,
    generateLedMap,
} from './trackBlocks';

import loadStopsMap from './platforms';

// Import cache helpers, train pairing logic, and logging
import { saveToCache, readFromCache } from './cache';
import { TrainPair, checkForTrainPairs } from './trainPairs';
import { log } from './customUtils';

/**
 * Configuration for a rail network, loaded from config.json
 */
interface RailNetworkConfig {
    GTFSRealtimeAPI: {
        url: Array<string>; // Endpoint for GTFS Realtime positions feed
        tripsUrl: Array<string> | undefined; // Endpoint for GTFS Realtime trips feed
        keyHeader: string; // HTTP header name for API key
        key: string | undefined; // API key (should be loaded from .env, not config.json)
        fetchIntervalSeconds: number; // How often to fetch updates
        format: string; // Structure of the response (e.g. "FeedMessage" or "GTFSRealtime")
        protocol: string; // Protocol of the response (e.g. "protobuf" or )
    };
    trainFilter: {
        entityID?: {
            start: number; // Start of numeric ID range
            end: number; // End of numeric ID range
        };
        trip_ID?: {
            includes?: Array<string>; // List of substrings to filter in trip_id
            excludes?: Array<string>; // List of substrings to exclude in trip_id
        };
    };
    processingOptions: {
        pairTrains?: boolean; // Whether to pair trains (for when 2 train vehicles run together as one train)
        cacheGTFS?: boolean; // Whether to cache GTFS entities
        cacheIntervalSeconds?: number; // How often to save cache
        displayThreshold: number; // Time in seconds to display trains after last update
        removeStaleVehiclesHours?: number; // How often to flush stale vehicles from tracked list
    };
    stops: { // Mapping of stop_id to stop_name and platform_id
        fileName: string; // Name of the stops.txt file (default: "stops.txt")
    };
    trackBlocks: {
        fileName: string; // Name of the KML file containing track block polygons (default: "trackBlocks.kml")
    };
    LEDRailsAPI: {
        APIVersions: Array<{
            version: string; // Supported PCB board revision
            blockRemap?: Array<{
                start: number; // Start block number for remapping
                end: number; // End block number for remapping
                offset: number; // Offset to apply for remapping
            }>;
        }>;
        randomizeTimeOffset?: boolean; // Whether to randomize time offset for display (used for WLG where all trains are updated simultaneously)
        colors: {
            [key: string]: [number, number, number]; // Mapping of route names to [R,G,B] color values
        };
    };
}

export class RailNetwork {
    id: string;
    config: RailNetworkConfig;
    trackBlocks: TrackBlockMap | undefined;
    stopsMap: Record<string, { stop_name: string; platform_code: string | undefined }> | undefined;
    entities: Entity[] = [];
    ledRailsAPIs: LEDRailsAPI[] = [];

    trainPairs: TrainPair[] = [];
    invisibleTrains: string[] = [];
    trackedTrains: TrainInfo[] = [];
    trainEntities: Entity[] = [];

    /**
     * Constructs a RailNetwork instance from a config folder.
     *
     * Loads configuration, track blocks, cached train data, and initializes LED API objects.
     *
     * @param configFolderPath - Path to the folder containing config.json and .env
     */
    constructor(configFolderPath: string) {
        // Set the id of the rail network based on the name of the config folder
        this.id = path.basename(configFolderPath);

        // Synchronously read and parse the config JSON file (you can't use async in a constructor)
        const configFilePath = path.resolve(configFolderPath, 'config.json');
        this.config = JSON.parse(fs.readFileSync(configFilePath, 'utf-8'));

        if (this.config.trackBlocks && this.config.trackBlocks.fileName) {
            const trackBlocksPath = path.resolve(configFolderPath, this.config.trackBlocks.fileName);
            this.trackBlocks = loadTrackBlocks(this.id, trackBlocksPath);
        } else {
            this.trackBlocks = undefined;
        }
        // Configuration for a rail network, loaded from config.json

        if (this.config.processingOptions.pairTrains) {
            this.trainPairs = readFromCache(this.id, 'trainPairs') || [];
        }

        if (this.config.processingOptions.cacheGTFS) {
            this.entities = readFromCache(this.id, 'entities') || [];
        }

        if (this.config.processingOptions.displayThreshold === undefined) {
            log(this.id, `displayThreshold not set in config, defaulting to 300 seconds`);
            this.config.processingOptions.displayThreshold = 300;
        }

        if (this.config.stops && this.config.stops.fileName) {
            const stopsPath = path.resolve(configFolderPath, this.config.stops.fileName);
            this.stopsMap = loadStopsMap(stopsPath);
        } else {
            this.stopsMap = undefined;
        }

        if (this.config.LEDRailsAPI) {
            for (const { version, blockRemap } of this.config.LEDRailsAPI.APIVersions) {
                // Create color mapping for the LED display
                const IdToColor: Record<number, number[]> = {}; // Map color IDs to [R,G,B] values
                const routeToColorId: Record<string, number> = {}; // Maps route IDs to color IDs
                let colorId = 0; // Color IDs must be assigned from 0 sequentially (a limitation of the firmware)
                for (const [routeId, rgb] of Object.entries(this.config.LEDRailsAPI.colors)) {
                    IdToColor[colorId] = rgb;
                    routeToColorId[routeId] = colorId;
                    colorId++;
                }

                this.ledRailsAPIs.push({
                    routeToColorId,
                    url: `/${this.id.toLowerCase()}-ltm/${version}.json`,
                    blockRemap: blockRemap,
                    displayThreshold: this.config.processingOptions.displayThreshold,
                    randomizeTimeOffset: this.config.LEDRailsAPI.randomizeTimeOffset || false,
                    updateInterval: this.config.GTFSRealtimeAPI.fetchIntervalSeconds,
                    output: {
                        version,
                        timestamp: 0,
                        update: this.config.GTFSRealtimeAPI.fetchIntervalSeconds,
                        colors: IdToColor,
                        updates: [],
                    },
                });
            }
        }

        if (this.config.processingOptions.cacheIntervalSeconds) {
            setInterval(() => { this.saveCache(); }, this.config.processingOptions.cacheIntervalSeconds * 1000);
        }

        if (this.config.processingOptions.removeStaleVehiclesHours) {
            this.removeStaleVehicles(); // Initial cleanup on startup
            setInterval(() => { this.removeStaleVehicles(); }, this.config.processingOptions.removeStaleVehiclesHours * 3600 * 1000);
        }
    }

    /**
     * Updates GTFS data and LED board state for this network.
     *
     * Fetches new GTFS data, updates tracked trains, and refreshes LED API state.
     */
    async update() {
        await this.getGTFSRealtimeData();
        if (this.ledRailsAPIs.length > 0) {
            this.updateLEDRailsAPIs();
        }
    }

    async fetchFromAPI(network: this, URL: string): Promise<FeedMessage | GTFSRealtime | undefined> {
        let response: Response;
        try {
            response = await fetch(URL, {
                headers: new Headers({
                    [network.config.GTFSRealtimeAPI.keyHeader]: network.config.GTFSRealtimeAPI.key ?? '',
                    'Accept': network.config.GTFSRealtimeAPI.protocol === 'protobuf' ? 'application/x-protobuf' : 'application/json,application',
                    'Accept-Encoding': 'gzip, deflate, br',
                }),
                redirect: 'follow',
            });
        } catch (error) {
            log(this.id, `Error fetching GTFS: ${(error as Error).message}`);
            return;
        }

        if (!response.ok) {
            log(this.id, `Failed to fetch GTFS: ${response.status} ${response.statusText}`);
            return;
        }

        let jsonData;

        if (this.config.GTFSRealtimeAPI.protocol === 'protobuf') {
            // Protobuf GTFS Realtime
            const buffer = Buffer.from(await response.arrayBuffer());

            // Load proto definition (assumes gtfs-realtime.proto is in project root)
            const protoPath = path.resolve(__dirname, 'gtfs-realtime.proto');
            let root;
            try {
                root = await protobuf.load(protoPath);
            } catch (err) {
                log(this.id, `Failed to load gtfs-realtime.proto: ${(err as Error).message}`);
                return;
            }
            const FeedMessageType = root.lookupType('transit_realtime.FeedMessage');
            try {
                jsonData = FeedMessageType.decode(buffer).toJSON();
            } catch (err) {
                log(this.id, `Failed to decode protobuf GTFS: ${(err as Error).message}`);
                return;
            }

            // Convert all timestamps from strings to numbers (Not sure why protobufjs decodes them as strings)
            if (jsonData?.entity) {
                for (const entity of jsonData.entity) {
                    if (entity.vehicle) {
                        if (entity.vehicle.timestamp) {
                            entity.vehicle.timestamp = Number(entity.vehicle.timestamp);
                        }
                    }
                }
            }

        } else {
            // JSON GTFS Realtime
            jsonData = response.json();
        }

        let freshData;
        if (this.config.GTFSRealtimeAPI.format === "FeedMessage") {
            freshData = jsonData as FeedMessage;
        } else {
            freshData = jsonData as GTFSRealtime;
        }
        return freshData;
    }

    /**
     * Fetches GTFS Realtime data, updates train entities, and tracks trains.
     *
     * Combines new entities with cached ones, removes duplicates, filters train entities,
     * handles train pairing and the resulting invisible trains, and updates tracked train positions and block assignments.
     *
     * @returns Promise<void>
     */
    async getGTFSRealtimeData() {
        // console.time(`[${this.id}] Fetched GTFS data...`);
        const positionPromises = this.config.GTFSRealtimeAPI.url.map(url => this.fetchFromAPI(this, url));

        const tripPromises = this.config.GTFSRealtimeAPI.tripsUrl
            ? this.config.GTFSRealtimeAPI.tripsUrl.map(url => this.fetchFromAPI(this, url))
            : [];

        const [positionResponses, tripResponses] = await Promise.all([
            Promise.all(positionPromises),
            Promise.all(tripPromises)
        ]);

        const allPositionEntities: Entity[] = [];
        for (const response of positionResponses) {
            // Save to file
            // if (response) {
            //     const timestamp = Date.now();
            //     const outputPath = path.resolve(__dirname, 'gtfs_dumps', `${this.id}_${timestamp}.json`);
            //     fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            //     fs.writeFileSync(outputPath, JSON.stringify(response, null, 2), 'utf-8');
            // }

            if (response?.response?.entity) {
                allPositionEntities.push(...response.response.entity);
            } else if (response?.entity) {
                allPositionEntities.push(...response.entity);
            }
        }

        if (this.config.GTFSRealtimeAPI.tripsUrl && tripResponses.length > 0) {
            const allTripEntities: Entity[] = [];
            for (const response of tripResponses) {
                if (response?.entity) {
                    allTripEntities.push(...response.entity);
                }
            }

            // Combine "stopTimeUpdate" from trips into positions based on ID
            if (allPositionEntities.length > 0 && allTripEntities.length > 0) {
                allPositionEntities.forEach(positionEntity => {
                    const tripEntity = allTripEntities.find(t => t.id === positionEntity.id);
                    if (tripEntity?.tripUpdate?.stopTimeUpdate) {
                        positionEntity.tripUpdate = tripEntity.tripUpdate;
                    }
                });
            }
        }

        // Combine new entities with existing ones, removing duplicates by id
        if (allPositionEntities.length > 0) {
            this.entities = Array.from(
                new Map(
                    [...this.entities, ...allPositionEntities].map(e => [e.vehicle?.vehicle?.id, e])
                ).values()
            );
        }

        // Filter out train entities
        if (this.config.trainFilter) {
            if (this.config.trainFilter.entityID) {
                this.trainEntities = this.entities.filter(entity => {
                    if (!entity?.id || !this.config.trainFilter.entityID) return false;
                    const idNum = Number(entity.id);
                    return idNum >= this.config.trainFilter.entityID.start && idNum <= this.config.trainFilter.entityID.end;
                });

            } else if (this.config.trainFilter.trip_ID) {
                const { includes, excludes } = this.config.trainFilter.trip_ID;
                this.trainEntities = this.entities.filter(entity => {
                    const tripDescriptor = entity.vehicle?.trip as any;
                    const tripId = tripDescriptor?.trip_id || tripDescriptor?.tripId; // Handle trip_id or tripId

                    if (!tripId) return false;

                    if (excludes && excludes.some(exclude => tripId.includes(exclude))) {
                        return false;
                    }

                    if (includes && includes.length > 0) {
                        return includes.some(include => tripId.includes(include));
                    }

                    return true;
                });
            }
        } else {
            this.trainEntities = this.entities;
        }

        if (this.config.processingOptions.pairTrains) {
            const { invisibleTrainIds, trainPairs } = await checkForTrainPairs(this.trainEntities, this.trainPairs);
            this.invisibleTrains = invisibleTrainIds;
            this.trainPairs = trainPairs;
        } else {
            this.invisibleTrains = [];
        }

        this.trackedTrains = updateTrackedTrains(this.trackBlocks, this.trackedTrains, this.trainEntities, this.config.processingOptions.displayThreshold, this.invisibleTrains, this.id);
        // console.timeEnd(`[${this.id}] Fetched GTFS data...`);
    }

    /**
     * Updates the LED Rails API objects with the latest train block data.
     *
     * Iterates through all LED API objects and updates their state based on tracked trains and invisible trains.
     *
     * @returns Promise<void>
     */
    async updateLEDRailsAPIs() {
        for (let index = 0; index < this.ledRailsAPIs.length; index++) {
            const api = this.ledRailsAPIs[index];
            if (api) {
                this.ledRailsAPIs[index] = generateLedMap(api, this.trackedTrains, this.invisibleTrains);
            }
        }
    }

    /**
     * Saves GTFS entities and train pairs to cache if enabled in config.
     *
     * Persists the current GTFS entities and train pairs to cache files for later use.
     *
     * @returns Promise<void>
     */
    async saveCache() {
        if (this.config.processingOptions.cacheGTFS) {
            saveToCache(this.id, 'entities', this.entities);
        }
        if (this.config.processingOptions.pairTrains) {
            saveToCache(this.id, 'trainPairs', this.trainPairs);
        }
    }

    /**
     * Removes stale vehicles from the entities list.
     *
     * Vehicles that have not been updated are removed from tracking.
     */
    async removeStaleVehicles() {
        const now = Date.now();
        let removedCount = 0;
        let activeCount = 0;
        this.entities = this.entities.filter(entity => {
            const vehicleTimestamp = entity.vehicle?.timestamp ? entity.vehicle.timestamp * 1000 : 0;
            const ageMs = now - vehicleTimestamp;
            const isFresh = ageMs <= this.config.processingOptions.removeStaleVehiclesHours * 3600 * 1000;
            if (!isFresh) removedCount++;
            else if (ageMs < (this.config.processingOptions.displayThreshold * 1000)) activeCount++;
            return isFresh;
        });
        // log(this.id, `Removed ${removedCount} stale vehicles, ${activeCount} active vehicles`);
    }
}