import type { FeedMessage, GTFSRealtime, Entity } from 'gtfs-types';
import * as fs from 'fs';
import * as path from 'path';

// Import LED board API, track block loader, train tracking, and LED map generator
import {
    LEDRailsAPI,
    loadTrackBlocks,
    TrackBlockMap,
    updateTrackedTrains,
    TrainInfo,
    generateLedMap,
} from './trackBlocks';

// Import cache helpers, train pairing logic, and logging
import { saveToCache, readFromCache } from './cache';
import { TrainPair, checkForTrainPairs } from './trainPairs';
import { log } from './customUtils';

/**
 * Configuration for a rail network, loaded from config.json
 */
interface RailNetworkConfig {
    GTFSRealtimeAPI: {
        url: string; // Endpoint for GTFS Realtime feed
        keyHeader: string; // HTTP header name for API key
        key: string | undefined; // API key (should be loaded from .env, not config.json)
        fetchIntervalSeconds: number; // How often to fetch updates
        format: string; // Structure of the response (e.g. "FeedMessage" or "GTFSRealtime")
    };
    trainFilter: {
        entityID?: {
            start: number; // Start of numeric ID range
            end: number; // End of numeric ID range
        };
        trip_ID?: {
            includes: string; // Substring to filter in trip_id
        };
    };
    processingOptions: {
        pairTrains?: boolean; // Whether to pair trains (for when 2 train vehicles run together as one train)
        cacheGTFS?: boolean; // Whether to cache GTFS entities
        cacheIntervalSeconds?: number; // How often to save cache
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
        displayThreshold: number; // Time in seconds to display trains after last update
        randomizeTimeOffset?: boolean; // Whether to randomize time offset for display (used for WLG where all trains are updated simultaneously)
        colors: {
            [key: string]: [number, number, number]; // Mapping of route names to [R,G,B] color values
        };
    };
}

export class RailNetwork {
    id: string;
    config: RailNetworkConfig;
    trackBlocks: TrackBlockMap;
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

        const trackBlocksPath = path.resolve(configFolderPath, this.config.trackBlocks.fileName);
        this.trackBlocks = loadTrackBlocks(this.id, trackBlocksPath);
        // Configuration for a rail network, loaded from config.json

        if (this.config.processingOptions.pairTrains) {
            this.trainPairs = readFromCache(this.id, 'trainPairs') || [];
        }

        if (this.config.processingOptions.cacheGTFS) {
            this.entities = readFromCache(this.id, 'entities') || [];
        }

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
                displayThreshold: this.config.LEDRailsAPI.displayThreshold,
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

        if (this.config.processingOptions.cacheIntervalSeconds) {
            setInterval(() => { this.saveCache(); }, this.config.processingOptions.cacheIntervalSeconds * 1000);
        }
    }

    /**
     * Updates GTFS data and LED board state for this network.
     *
     * Fetches new GTFS data, updates tracked trains, and refreshes LED API state.
     */
    async update() {
        await this.getGTFSRealtimeData();
        this.updateLEDRailsAPIs();
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
        const response = await fetch(this.config.GTFSRealtimeAPI.url, {
            headers: new Headers({
                [this.config.GTFSRealtimeAPI.keyHeader]: this.config.GTFSRealtimeAPI.key ?? '',
                'Accept': 'application/json,application',
                'Accept-Encoding': 'gzip, deflate, br',
            }),
            redirect: 'follow', // Handle redirects
        });

        if (!response.ok) {
            log(this.id, `Failed to fetch GTFS Realtime: ${response.status} ${response.statusText}`);
        }

        let freshData;
        if (this.config.GTFSRealtimeAPI.format === "FeedMessage") {
            freshData = await response.json() as FeedMessage;
        } else {
            freshData = await response.json() as GTFSRealtime;
            freshData = freshData.response;
        }

        // Combine new entities with existing ones, removing duplicates by id
        if (freshData?.entity) {
            this.entities = Array.from(
                new Map(
                    [...this.entities, ...freshData.entity].map(e => [e.vehicle?.vehicle?.id, e])
                ).values()
            );
        }

        // Filter out train entities
        if (this.config.trainFilter.entityID) {
            this.trainEntities = this.entities.filter(entity => {
                if (!entity?.id || !this.config.trainFilter.entityID) return false;
                const idNum = Number(entity.id);
                return idNum >= this.config.trainFilter.entityID.start && idNum <= this.config.trainFilter.entityID.end;
            });

        } else if (this.config.trainFilter.trip_ID) {
            this.trainEntities = this.entities.filter(entity => {
                const includesStr = this.config.trainFilter.trip_ID?.includes;
                return includesStr !== undefined && entity.vehicle?.trip?.trip_id?.includes(includesStr);
            });
        }

        if (this.config.processingOptions.pairTrains) {
            const { invisibleTrainIds, trainPairs } = await checkForTrainPairs(this.trainEntities, this.trainPairs);
            this.invisibleTrains = invisibleTrainIds;
            this.trainPairs = trainPairs;
        } else {
            this.invisibleTrains = [];
        }

        this.trackedTrains = updateTrackedTrains(this.trackBlocks, this.trackedTrains, this.trainEntities, this.config.LEDRailsAPI.displayThreshold, this.invisibleTrains, this.id);
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
}
