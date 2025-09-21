import * as fs from 'fs';
import { DOMParser } from '@xmldom/xmldom';
import type { Entity } from 'gtfs-types';
import { LOG_LABELS, log } from './customUtils';

export interface LEDRailsAPI {
    routeToColorId: Record<string, number>; // Map of route names to color IDs
    url: string; // URL of the LED Rails API endpoint e.g. "/akl-ltm/100.json"
    blockRemap: Array<{
        start: number; // Start block number for remapping (inclusive)
        end: number;  // End block number for remapping (inclusive)
        offset: number; // Offset to apply for remapping e.g. 302 with offset -1 becomes 301
    }> | undefined; // Optional remapping of block numbers for this board revision
    displayThreshold: number; // Time in seconds to display trains after their last update
    randomizeTimeOffset: boolean; // Whether to randomize time offsets for LED updates
    updateInterval: number; // Interval in seconds between updates
    output: LEDRailsAPIOutput; // The prepared output to send to the LED Rails API
}

interface LEDRailsAPIOutput {
    version: string;                    // Intended Version of the Board (e.g. "100" for V1.0.0)
    timestamp: number;                  // Epoch Seconds timestamp of this update
    update: number;                     // Offset time from timestamp for next update
    colors: Record<number, number[]>;   // Map color Id to [R,G,B]
    updates: LEDUpdate[];               // Map block number to LEDUpdate
}

interface LEDUpdate {
    b: number[]; // [Pre, Post] update track block number (e.g., 302)
    c: number; // Color ID
    t: number; // Offset time from timestamp in seconds
}

interface TrackBlock {
    blockNumber: number;                // Track block number (ref from pcb) (e.g., D302 is 302)
    altBlock: number | undefined;       // Alternative block number if applicable (for platforms 3/4)
    name: string;                       // Name of the KML Placemark (e.g. "302 - Parnell")
    priority: boolean;                  // Indicates if trains should be put in this block first when blocks overlap
    polygon: Array<[number, number]>;   // Array of [latitude, longitude] tuples
    routes: string[] | undefined;       // Allowed routes for this block, parsed from [ROUTE1,ROUTE2]
}

export type TrackBlockMap = Map<number, TrackBlock>;

export interface TrainInfo {
    trainId: string; // Vehicle ID from GTFS e.g. "59185" for AMP185
    position: { latitude: number; longitude: number; timestamp: number; speed: number | undefined }; // GTFS Position update of the train
    currentBlock: number | undefined; // Track block number (e.g., 301)
    previousBlock: number | undefined; // Previous block number (e.g., 300)
    route: string; // Route ID from GTFS e.g. "EAST-201"
    tripId: string | undefined; // Trip ID from GTFS
}

/**
 * Loads track blocks from a KML file and parses them into a TrackBlockMap.
 *
 * @param cityID City identifier (e.g., 'AKL', 'WLG')
 * @param filePath Path to the KML file
 * @returns Map of block numbers to TrackBlock objects
 */
export function loadTrackBlocks(cityID: string, filePath: string) {
    const kmlContent = fs.readFileSync(filePath, 'utf-8');
    const doc = new DOMParser().parseFromString(kmlContent, 'text/xml');
    const loadedBlocks: TrackBlock[] = [];
    const placemarks = doc.getElementsByTagName('Placemark');

    for (const placemark of Array.from(placemarks)) {
        const nameElement = placemark.getElementsByTagName('name')[0];
        const id = nameElement?.textContent;

        // Skip placemarks without a name
        if (!id) {
            log(cityID, 'trackblock.kml Placemark without a name found, skipping.');
            continue;
        }

        // Extracts the first sequence of digits from the ID to use as the block number.
        let priority = false;
        let blockNumber: number;
        let altBlock: number | undefined;
        let routes: string[] | undefined;

        const blockNumberMatch = id.match(/(\d+)/);
        if (blockNumberMatch && blockNumberMatch[1]) {
            blockNumber = parseInt(blockNumberMatch[1], 10);
        } else {
            log(cityID, `trackblock.kml polygon does not contain a block number: ${id}`);
            continue;
        }

        // Parse altBlock from +N in the id string (e.g., "+402" means altBlock is 402)
        const altBlockMatch = id.match(/\+(\d+)/);
        if (altBlockMatch && altBlockMatch[1]) {
            altBlock = parseInt(altBlockMatch[1], 10);
        }

        // Parse routes from "[ROUTE1,ROUTE2]" at the end of the id string
        const routesMatch = id.match(/\[([^\]]+)\]/);
        if (routesMatch && routesMatch[1]) {
            routes = routesMatch[1].split(',').map(s => s.trim()).filter(Boolean);
        }

        // Parse priority from presence of a group of letters (>=3) anywhere in the ID
        const nameMatch = id.match(/[a-zA-Z]{3,}/);
        if (nameMatch) {
            priority = true;
        }

        const coordinatesElement = placemark.getElementsByTagName('coordinates')[0];
        const coordsString = coordinatesElement?.textContent?.trim();

        if (coordsString) {
            const points = coordsString
                .split(/\s+/)
                .map((coordPairStr) => {
                    const [lon, lat] = coordPairStr.split(',').map(Number);
                    return [lat, lon] as [number, number];
                })
                .filter(point => !isNaN(point[0]) && !isNaN(point[1]));

            if (points.length > 0) {
                loadedBlocks.push({
                    name: id,
                    blockNumber,
                    altBlock,
                    priority,
                    polygon: points,
                    routes,
                });
            } else {
                log(cityID, `trackblock.kml Placemark '${id}' had no valid coordinates`);
            }
        } else {
            log(cityID, `trackblock.kml Placemark '${id}' missing coordinates`);
        }
    }

    // Clear existing map and add sorted blocks
    const trackBlocks: TrackBlockMap = new Map<number, TrackBlock>(); // Map<blockNumber, TrackBlock>
    loadedBlocks
        // Blocks with routes first, then priority, then the rest
        .sort((a, b) => {
            // Routes first
            if (a.routes && !b.routes) return -1;
            if (!a.routes && b.routes) return 1;
            // Priority next
            if (a.priority && !b.priority) return -1;
            if (!a.priority && b.priority) return 1;
            // Otherwise, keep original order
            return 0;
        })
        .forEach(block => {
            trackBlocks.set(block.blockNumber, block);
        });

    return trackBlocks;
}

/**
 * Checks if a point is inside a polygon using the Ray Casting algorithm.
 *
 * @param pointLat Latitude of the point to check
 * @param pointLng Longitude of the point to check
 * @param polygon Array of [lat, lng] tuples defining the polygon vertices
 * @returns True if the point is inside the polygon, false otherwise
 */
function isPointInPolygon(pointLat: number, pointLng: number, polygon: Array<[number, number]>): boolean {
    if (!polygon || polygon.length < 3) {
        // A polygon needs at least 3 vertices
        return false;
    }

    let isInside = false;

    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const pi = polygon[i];
        const pj = polygon[j];
        if (!pi || !pj) continue;
        const lat_i = pi[0];
        const lng_i = pi[1];
        const lat_j = pj[0];
        const lng_j = pj[1];

        // Check if the point's latitude is between the latitudes of the edge's endpoints
        const isLatBetweenEdgePoints = (lat_i > pointLat) !== (lat_j > pointLat);
        // Guard against division by zero
        if (lat_j !== lat_i) {
            // Calculate the longitude of the intersection of the ray with the edge
            const intersectionLng = (lng_j - lng_i) * (pointLat - lat_i) / (lat_j - lat_i) + lng_i;
            // If the point's latitude is between edge points and its longitude is to the left of intersection
            if (isLatBetweenEdgePoints && pointLng < intersectionLng) {
                isInside = !isInside;
            }
        }
    }
    return isInside;
}

/**
 * Checks if a train is within a specific track block polygon.
 *
 * @param trackBlocks Map of track blocks
 * @param train Train information
 * @param blockNumber Track block number to check
 * @returns True if the train is within the block's polygon, false otherwise
 */
const trainInBlock = (trackBlocks: TrackBlockMap, train: TrainInfo, blockNumber: number): boolean => {
    const block = trackBlocks.get(blockNumber);
    if (block) {
        // If block routes are defined, check if the train's route is allowed in this block
        if (block.routes && !block.routes.includes(train.route)) {
            return false;
        } else {
            return isPointInPolygon(train.position.latitude, train.position.longitude, block.polygon);
        }
    }
    return false;
};

/**
 * Updates tracked train information based on current GTFS train positions.
 *
 * Synchronizes train data between GTFS feeds and internal tracking,
 * updates train positions, and determines which track block each train occupies.
 *
 * @param trackBlocks Map of track blocks with polygon boundary data
 * @param trackedTrains Current array of tracked train information
 * @param gtfsTrains Array of train entities from GTFS real-time feed
 * @param displayThreshold Time in seconds to display trains after their last update
 * @param invisibleTrainIds List of train IDs that should be hidden
 * @returns Updated array of tracked trains with current positions and block assignments
 */
export function updateTrackedTrains(
    trackBlocks: TrackBlockMap,
    trackedTrains: TrainInfo[],
    gtfsTrains: Entity[],
    displayThreshold: number,
    invisibleTrainIds: string[],
    cityID: string
): TrainInfo[] {

    // Synchronize GTFS train data with our tracked trains
    syncTrainData(trackedTrains, gtfsTrains);

    // Update track block assignments for all trains with valid positions
    assignBlocksToTrains(trackBlocks, trackedTrains, displayThreshold, invisibleTrainIds, cityID);

    return trackedTrains;
}

/**
 * Synchronizes train data between GTFS feed and internal tracking.
 *
 * @param trackedTrains Array of tracked train information
 * @param gtfsTrains Array of train entities from GTFS real-time feed
 */
function syncTrainData(trackedTrains: TrainInfo[], gtfsTrains: Entity[]): void {
    gtfsTrains.forEach(gtfsTrain => {
        const trainId = gtfsTrain.vehicle?.vehicle?.id ?? 'UNKNOWN';
        const existingTrain = trackedTrains.find(t => t.trainId === trainId);

        if (existingTrain) {
            updateExistingTrainPosition(existingTrain, gtfsTrain);
        } else {
            addNewTrain(trackedTrains, gtfsTrain);
        }
    });
}

/**
 * Updates position data for an existing tracked train.
 *
 * @param trackedTrain Tracked train to update
 * @param gtfsTrain GTFS train entity with new position data
 */
function updateExistingTrainPosition(trackedTrain: TrainInfo, gtfsTrain: Entity): void {
    const newPosition = gtfsTrain.vehicle?.position;
    const newSpeed = newPosition?.speed;

    if (newSpeed && newSpeed === 0 && trackedTrain.position.speed === 0) {
        const SMOOTHING_FACTOR = 0.95;
        trackedTrain.position.latitude = (
            trackedTrain.position.latitude * SMOOTHING_FACTOR +
            (newPosition?.latitude ?? 0) * (1 - SMOOTHING_FACTOR)
        );
        trackedTrain.position.longitude = (
            trackedTrain.position.longitude * SMOOTHING_FACTOR +
            (newPosition?.longitude ?? 0) * (1 - SMOOTHING_FACTOR)
        );
    } else {
        trackedTrain.position.latitude = newPosition?.latitude ?? 0;
        trackedTrain.position.longitude = newPosition?.longitude ?? 0;
    }

    // Update other position properties
    trackedTrain.position.speed = newSpeed;
    trackedTrain.position.timestamp = gtfsTrain.vehicle?.timestamp ?? 0;
    trackedTrain.route = String(gtfsTrain.vehicle?.trip?.route_id ?? 'OUT-OF-SERVICE');
    trackedTrain.tripId = gtfsTrain.vehicle?.trip?.trip_id;
}

/**
 * Adds a new train to the tracked trains array.
 *
 * @param trackedTrains Array of tracked train information
 * @param gtfsTrain GTFS train entity to add
 */
function addNewTrain(trackedTrains: TrainInfo[], gtfsTrain: Entity): void {
    const vehicle = gtfsTrain.vehicle;
    const position = vehicle?.position;

    trackedTrains.push({
        trainId: vehicle?.vehicle?.id ?? 'UNKNOWN',
        position: {
            latitude: position?.latitude ?? 0,
            longitude: position?.longitude ?? 0,
            timestamp: vehicle?.timestamp ?? 0,
            speed: position?.speed, // Can be undefined (e.g. WLG does not provide speed)
        },
        route: String(vehicle?.trip?.route_id ?? 'OUT-OF-SERVICE'),
        currentBlock: undefined,
        previousBlock: undefined,
    });
}

/**
 * Assigns track blocks to all trains based on their current positions.
 *
 * @param trackBlocks Map of track blocks
 * @param trackedTrains Array of tracked train information
 * @param displayThreshold Time in seconds to display trains after their last update
 * @param invisibleTrainIds List of train IDs that should be hidden
 */
function assignBlocksToTrains(trackBlocks: TrackBlockMap, trackedTrains: TrainInfo[], displayThreshold: number, invisibleTrainIds: string[], cityID: string): void {
    const now = Math.ceil(Date.now() / 1000);
    const displayCutoff = now - displayThreshold;

    // Filter out trains with outdated timestamps or invalid positions
    const validTrains: TrainInfo[] = [];
    trackedTrains.forEach(train => {
        if (
            train.position.latitude == 0 &&
            train.position.longitude == 0 ||
            train.position.timestamp < displayCutoff
        ) {
            train.currentBlock = undefined;
            train.previousBlock = undefined;
        } else {
            validTrains.push(train);
        }
    });

    validTrains.forEach(train => {
        // Skip if train is still in the same block
        if (train.currentBlock && trainInBlock(trackBlocks, train, train.currentBlock)) {
            train.previousBlock = train.currentBlock;
            return;
        }

        // Find and set the block the train occupies
        findAndSetTrainBlock(trackBlocks, train, cityID);
    });

    updateAltBlocks(trackBlocks, trackedTrains, invisibleTrainIds, cityID);
}

/**
 * Finds and sets the track block for a single train based on its position.
 *
 * @param trackBlocks Map of track blocks
 * @param train Train information
 * @param cityID City identifier (for logging)
 */
function findAndSetTrainBlock(trackBlocks: TrackBlockMap, train: TrainInfo, cityID: string): void {

    // TODO: Optimize this search by checking nearby blocks first
    for (const block of trackBlocks.values()) {
        if (trainInBlock(trackBlocks, train, block.blockNumber)) {
            if (train.previousBlock) {
                train.previousBlock = train.currentBlock;
            } else {
                train.previousBlock = 0; // Set previousBlock if not already set
            }
            train.currentBlock = block.blockNumber;
            return;
        }
    }

    // Train is not in any known block
    train.currentBlock = undefined;
    train.previousBlock = undefined;

    // Only log if in the dev environment
    if (process.env.NODE_ENV === 'development') {
        if (train.trainId != "4396" && train.trainId != "4081" && train.trainId != "4398") { // Ignore known outliers (WLG Wairarapa Connection)
            log(cityID, `Train ${train.trainId} on ${train.route} is not in any block (${train.position.latitude}, ${train.position.longitude})`, LOG_LABELS.WARNING);
        }
    }
}

/**
 * Updates alternative block assignments for trains when multiple trains occupy the same block.
 *
 * @param trackBlocks Map of track blocks
 * @param trackedTrains Array of tracked train information
 * @param invisibleTrainIds List of train IDs that should be hidden
 * @param cityID City identifier (for logging)
 */
function updateAltBlocks(trackBlocks: TrackBlockMap, trackedTrains: TrainInfo[], invisibleTrainIds: string[], cityID: string) {

    // Sort out multiple trains in the same block by sorting and moving to the altBlockNumber if available
    for (const block of trackBlocks.values()) {
        const trainsInBlock = trackedTrains
            .filter(train => train.currentBlock === block.blockNumber)
            .filter(train => !invisibleTrainIds.includes(train.trainId))
        if (trainsInBlock.length > 1) {
            // Sort trains by route and make sure "OUT-OF-SERVICE" is last
            trainsInBlock.sort((a, b) => {
                if (a.route === 'OUT-OF-SERVICE' && b.route !== 'OUT-OF-SERVICE') return 1;
                if (a.route !== 'OUT-OF-SERVICE' && b.route === 'OUT-OF-SERVICE') return -1;
                return a.route.localeCompare(b.route);
            });

            for (let i = 0; i < trainsInBlock.length; i++) {
                const train = trainsInBlock[i];
                if (!train) continue;
                if (i === 0) {
                    train.currentBlock = block.blockNumber; // First train stays in the main block
                } else if (block.altBlock && i === 1) {
                    train.currentBlock = block.altBlock;    // Second train moves to alt block if available
                } else {
                    if (train.trainId) {
                        invisibleTrainIds.push(train.trainId);  // Remaining trains are marked as invisible
                    }
                }
            }
        }
    }
}

/**
 * Generates an api output based on the current train block assignments.
 *
 * This function mutates the input LEDRailsAPI object.
 *
 * @param api LEDRailsAPI configuration and output object
 * @param trackedTrains Array of tracked train information
 * @param invisibleTrainIds List of train IDs that should be hidden
 * @returns The mutated LEDRailsAPI object with updated LED statuses
 */
export function generateLedMap(api: LEDRailsAPI, trackedTrains: TrainInfo[], invisibleTrainIds: string[]): LEDRailsAPI {
    // Reset updates for this output
    api.output.updates = [];

    // Calculate time thresholds for display and update
    const now = Math.ceil(Date.now() / 1000);
    const displayCutoff = now - api.displayThreshold;
    const updateTime = now - api.updateInterval;

    // Iterate over trains that should be displayed
    trackedTrains
        .filter(train => train.position.timestamp >= displayCutoff) // Only show trains with recent updates
        .filter(train => !invisibleTrainIds.includes(train.trainId)) // Exclude invisible trains (e.g. paired trains)
        .forEach(train => {
            // Only update if both current and previous block are known
            if (train.currentBlock !== undefined && train.previousBlock !== undefined) {
                const colorId = api.routeToColorId[train.route]; // Get color for this route
                if (colorId != undefined) {
                    let timeOffset = 0;
                    // Determine time offset for LED animation
                    if (api.randomizeTimeOffset) {
                        if (train.previousBlock === train.currentBlock) {
                            timeOffset = 0; // No movement, no offset
                        } else {
                            timeOffset = Math.floor(Math.random() * (api.updateInterval - 1)) + 1; // Random offset
                        }
                    } else {
                        timeOffset = Math.max(train.position.timestamp - updateTime, 0); // Use timestamp difference
                    }

                    // Add update for this train to the output
                    api.output.updates.push({
                        b: [train.previousBlock, train.currentBlock], // Block transition
                        c: colorId, // Color ID
                        t: timeOffset, // Time offset for animation
                    });
                } else {
                    log(LOG_LABELS.ERROR, `No color mapping for route ${train.route}`);
                }
            }
        });

    // Remap block numbers if required by board revision
    if (api.blockRemap != undefined) {
        api.output.updates = api.output.updates.map(update => {
            const newB = update.b.map(blockNum => {
                for (const rule of api.blockRemap!) {
                    if (blockNum >= rule.start && blockNum <= rule.end) {
                        return blockNum + rule.offset; // Apply remap offset
                    }
                }
                return blockNum;
            });
            return { ...update, b: newB };
        });
    }

    // Set the output timestamp to now
    api.output.timestamp = now;
    return api;
}