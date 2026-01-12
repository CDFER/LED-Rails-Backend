import * as fs from 'fs';
import { DOMParser } from '@xmldom/xmldom';
import type { Entity, StopTimeUpdate } from 'gtfs-types';
import { LOG_LABELS, log } from './customUtils';
import { calculateDistance } from './trainPairs';

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
    version: string;                    // Intended Hardware Version of the Board (e.g. "100" for V1.0.0)
    timestamp: number;                  // Epoch Seconds timestamp of this update
    update: number;                     // Offset time from timestamp for next update
    colors: Record<number, number[]>;   // Map color Id to [R,G,B] (0-255)
    updates: LEDUpdate[];               // Map block number to LEDUpdate
}

interface LEDUpdate {
    b: number[]; // [Pre, Post] update track block number (e.g., LED D102 is Block number 102)
    c: number; // Color ID
    t: number; // Offset time from timestamp in seconds (When it should change from Pre to Post Block)
}

interface Platform {
    blockNumber: number; // Track block number (ref from pcb) (e.g., D302 is 302)
    stop_ids: string[] | undefined;    // GTFS stop_ids associated with this platform
    isDefault: boolean | undefined; // Indicates if this is the default platform for the block (for express trains that don't stop at this station)
    bearing: number | undefined; // Default bearing (Used if there are multiple default platforms)
    routes: string[] | undefined;       // Allowed routes for this block, parsed from [ROUTE1,ROUTE2]
}

interface TrackBlock {
    blockNumber: number;                // Track block number (ref from pcb) (e.g., D302 is 302)
    platforms: Platform[] | undefined;  // Array of platforms associated with this block
    altBlock: number | undefined;       // Alternative block number (can be used if multiple trains are same block)
    name: string;                       // Name of the KML Placemark (e.g. "302 - Parnell")
    priority: boolean;                  // Indicates if trains should be put in this block first when blocks overlap
    polygon: Array<[number, number]>;   // Array of [latitude, longitude] tuples
    routes: string[] | undefined;       // Allowed routes for this block, parsed from [ROUTE1,ROUTE2]
}

export type TrackBlockMap = Map<number, TrackBlock>;

export interface TrainInfo {
    trainId: string; // Vehicle ID from GTFS e.g. "59185" for AMP185
    position: { latitude: number; longitude: number; timestamp: number; speed: number | undefined, bearing: number | undefined }; // GTFS Position update of the train
    currentBlock: number | undefined; // Track block number (e.g., 301)
    previousBlock: number | undefined; // Previous block number (e.g., 300)
    route: string; // Route ID from GTFS e.g. "EAST-201"
    tripId: string | undefined; // Trip ID from GTFS
    stops: { stopId: string; departureTime: number }[] | undefined;     // Array of upcoming stop IDs and departure times for this train
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

    for (const folder of Array.from(doc.getElementsByTagName('Folder'))) {
        for (const placemark of Array.from(folder.getElementsByTagName('Placemark'))) {
            // const nameElement = placemark.getElementsByTagName('name')[0];
            const id = placemark.getElementsByTagName('name')[0]?.textContent;
            const description = placemark.getElementsByTagName('description')[0]?.textContent;

            // Skip placemarks without a name
            if (!id) {
                log(cityID, 'trackblock.kml Placemark without a name found, skipping.');
                continue;
            }

            const platforms: Platform[] = [];

            if (description) {
                // Split description into lines and then by ',' to extract platforms
                const platformLines = description.split('\n').map(line => line.trim()).filter(line => line.length > 0);
                for (const line of platformLines) {
                    // Expected format: 102,"12260";"12261";,Default,-72deg,[aus:vic:vic-02-LIL:,aus:vic:vic-02-ALM:],

                    // Trim the line to remove any leading/trailing whitespace
                    const trimmedLine = line.trim();
                    if (!trimmedLine) continue; // Skip empty lines

                    // Split by comma if the comma is not between square brackets
                    const parts = trimmedLine.split(/,(?![^\[]*\])/);

                    // Initialize variables with defaults
                    let blockNumber: number = 0;
                    let stop_ids: string[] = [];
                    let isDefault: boolean = false;
                    let bearing: number | undefined = undefined;
                    let routes: string[] | undefined = [];

                    // Parse block number from first part (should be digits only)
                    if (parts.length > 0 && parts[0]) {
                        const blockMatch = parts[0].match(/^(\d+)$/);
                        if (blockMatch) {
                            blockNumber = parseInt(blockMatch[1], 10);
                        }
                    }

                    // Parse stop IDs from second part (index 1)
                    if (parts.length > 1 && parts[1]) {
                        const stopIdsPart = parts[1];
                        // Extract all quoted values like "12260", "12261", etc
                        const stopIdMatches = stopIdsPart.matchAll(/"([^"]+)"/g);
                        for (const match of stopIdMatches) {
                            if (match[1]) {
                                stop_ids.push(match[1].trim());
                            }
                        }

                        // If no quoted values found but the part contains values, try splitting by semicolon
                        if (stop_ids.length === 0 && stopIdsPart.length > 0) {
                            stop_ids = stopIdsPart.split(';')
                                .map(s => s.replace(/"/g, '').trim())
                                .filter(s => s.length > 0);
                        }
                    }

                    // Parse isDefault by checking if "Default" appears in any part
                    isDefault = parts.some(part => part === 'Default');

                    // Parse bearing by checking for pattern "XXXdeg" in any part
                    for (const part of parts) {
                        if (part.includes('deg')) {
                            const bearingMatch = part.match(/^(-?\d+)deg$/);
                            if (bearingMatch && bearingMatch[1]) {
                                bearing = parseInt(bearingMatch[1], 10);
                                if (bearing < 0) bearing += 360; // Convert negative to positive bearing
                                bearing %= 360; // Normalize to 0-359
                                break; // Found bearing, no need to check other parts
                            }
                        }
                    }

                    // Parse routes by checking for pattern "[...]" in any part
                    for (const part of parts) {
                        if (part.startsWith('[') && part.endsWith(']')) {
                            const routesPart = part.slice(1, -1); // Remove brackets
                            routes = routesPart.split(',')
                                .map(s => s.trim())
                                .filter(s => s.length > 0);
                            break; // Found routes, no need to check other parts
                        }
                    }

                    if (routes.length === 0) {
                        routes = undefined;
                    }

                    platforms.push({
                        blockNumber,
                        stop_ids,
                        isDefault,
                        bearing,
                        routes,
                    });
                }
            }


            // Extracts the first sequence of digits from the ID to use as the block number.
            let priority = false;
            let blockNumber: number;
            let altBlock: number | undefined;
            let routes: string[] | undefined;

            const blockNumberMatch = id.match(/(\d+)/);
            if (blockNumberMatch && blockNumberMatch[1]) {
                blockNumber = parseInt(blockNumberMatch[1], 10);
                if (platforms.length > 0 && !platforms.map(p => p.blockNumber).includes(blockNumber)) {
                    log(cityID, `trackblock.kml Placemark '${id}' block number ${blockNumber} not found in any platform definitions`);
                }
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
                        platforms: platforms.length > 0 ? platforms : undefined,
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
    }

    // Check that bearings are 180 degrees apart for platforms within the same block
    for (const block of loadedBlocks) {
        let bearing = undefined;
        for (const platform of block.platforms ?? []) {
            if (platform.bearing) {
                if (bearing == undefined) {
                    bearing = platform.bearing;
                } else {
                    if (bearing != (platform.bearing + 180) % 360 && bearing != platform.bearing) {
                        log(cityID, `Inconsistent bearings found in block ${block.blockNumber} platforms (${bearing} vs ${platform.bearing})`);
                    }
                }
            }
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
 * Calculates speed in meters per second between two geographic points over a time interval.
 * @param lat1 Latitude of the first point
 * @param lon1 Longitude of the first point
 * @param lat2 Latitude of the second point
 * @param lon2 Longitude of the second point
 * @param time1 Timestamp of the first point in seconds since epoch
 * @param time2 Timestamp of the second point in seconds since epoch
 * @returns Speed in meters per second
 */
function calculatedSpeed(lat1: number, lon1: number, lat2: number, lon2: number, time1: number, time2: number): number {
    const distanceMeters = calculateDistance(lat1, lon1, lat2, lon2);
    const timeDeltaSeconds = time2 - time1;
    if (timeDeltaSeconds > 0) {
        return distanceMeters / timeDeltaSeconds;
    } else {
        return 0;
    }
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
        if (block.routes && !block.routes.some(r => train.route.includes(r))) {
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
    trackBlocks: TrackBlockMap | undefined,
    trackedTrains: TrainInfo[],
    gtfsTrains: Entity[],
    displayThreshold: number,
    invisibleTrainIds: string[],
    cityID: string,
): TrainInfo[] {

    // Synchronize GTFS train data with our tracked trains
    syncTrainData(trackedTrains, gtfsTrains);

    // Update track block assignments for all trains with valid positions
    if (trackBlocks) {
        assignBlocksToTrains(trackBlocks, trackedTrains, displayThreshold, invisibleTrainIds, cityID);
    }

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

function addNewStopsFromTripUpdate(stops: { stopId: string; departureTime: number }[], tripUpdate: StopTimeUpdate[] | undefined): { stopId: string; departureTime: number }[] | undefined {
    if (tripUpdate) {
        for (const stu of tripUpdate) {
            const stopId = stu.stopId ?? '';
            const newDepartureTime = stu.departure?.time
                ? Number(stu.departure.time)
                : Number(stu.arrival?.time);

            const existingStop = stops.find(s => s.stopId === stopId);

            if (existingStop) {
                if (existingStop.departureTime !== newDepartureTime) {
                    existingStop.departureTime = newDepartureTime;
                }
            } else {
                stops.push({ stopId, departureTime: newDepartureTime });
            }
        }

        // Remove stops with a departure time that are more than 10 mins in the past while keeping those with unknown departure times (0)
        const now = Math.ceil(Date.now() / 1000);
        stops = stops.filter(s => s.departureTime == 0 || s.departureTime >= now - 60 * 10);
    }

    return stops.length > 0 ? stops : undefined;
}

/**
 * Updates position data for an existing tracked train.
 *
 * @param trackedTrain Tracked train to update
 * @param gtfsTrain GTFS train entity with new position data
 */
function updateExistingTrainPosition(trackedTrain: TrainInfo, gtfsTrain: Entity): void {
    const newPosition = gtfsTrain.vehicle?.position;

    if (newPosition?.latitude != trackedTrain.position.latitude ||
        newPosition?.longitude != trackedTrain.position.longitude) {
        // Position has changed

        let newSpeed = newPosition?.speed;

        if (newSpeed) {
            if (newSpeed === 0 && trackedTrain.position.speed === 0) {
                const SMOOTHING_FACTOR = 0.95;
                trackedTrain.position.latitude = (
                    trackedTrain.position.latitude * SMOOTHING_FACTOR +
                    (newPosition?.latitude ?? 0) * (1 - SMOOTHING_FACTOR)
                );
                trackedTrain.position.longitude = (
                    trackedTrain.position.longitude * SMOOTHING_FACTOR +
                    (newPosition?.longitude ?? 0) * (1 - SMOOTHING_FACTOR)
                );
            }
        } else {
            newSpeed = calculatedSpeed(trackedTrain.position.latitude, trackedTrain.position.longitude, newPosition?.latitude ?? 0, newPosition?.longitude ?? 0, trackedTrain.position.timestamp, gtfsTrain.vehicle?.timestamp ?? 0);
            // log('WARN', `Calculated speed for train ${trackedTrain.trainId} as ${newSpeed.toFixed(2)} m/s`);
            trackedTrain.position.latitude = newPosition?.latitude ?? 0;
            trackedTrain.position.longitude = newPosition?.longitude ?? 0;
        }

        if (newSpeed > 4 && newSpeed < 55) { // 4 m/s = ~15 km/h and 55 m/s = ~198 km/h
            // Only update bearing if speed is reasonable (to avoid erratic bearing changes when stationary)
            trackedTrain.position.bearing = newPosition?.bearing;
        }

        // Update other position properties
        trackedTrain.position.speed = newSpeed;
        trackedTrain.position.timestamp = gtfsTrain.vehicle?.timestamp ?? 0;

        trackedTrain.route = String(gtfsTrain.vehicle?.trip?.route_id ?? gtfsTrain.vehicle?.trip?.routeId ?? 'OUT-OF-SERVICE');
        trackedTrain.tripId = gtfsTrain.vehicle?.trip?.trip_id;
        trackedTrain.stops = addNewStopsFromTripUpdate(trackedTrain.stops ?? [], gtfsTrain.tripUpdate?.stopTimeUpdate);
    }
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
            bearing: position?.bearing, // Can be undefined
        },
        route: String(vehicle?.trip?.route_id ?? vehicle?.trip?.routeId ?? 'OUT-OF-SERVICE'),
        currentBlock: undefined,
        previousBlock: undefined,
        tripId: vehicle?.trip?.trip_id,
        stops: addNewStopsFromTripUpdate([], gtfsTrain.tripUpdate?.stopTimeUpdate),
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

function setTrainBlock(train: TrainInfo, blockNumber: number): void {
    if (train.previousBlock === undefined) {
        // console.log(`Setting previousBlock for train ${train.trainId} to 0 (prevBlock was ${train.previousBlock} and currentBlock to ${blockNumber})`);
        train.previousBlock = 0; // Set previousBlock if not already set
    } else {
        train.previousBlock = train.currentBlock;
        // console.log(`Setting previousBlock for train ${train.trainId} to ${train.previousBlock} (currentBlock to ${blockNumber})`);
    }
    train.currentBlock = blockNumber;
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

            if (block.platforms) {
                // 1: Platforms with matching stop_ids
                for (const platform of block.platforms) {
                    if (platform.routes && !platform.routes.some(r => train.route.includes(r))) {
                        continue; // Skip this platform if the train's route is not allowed
                    }

                    // If the platform has stop_ids, check if the train is scheduled to stop there
                    if (platform.stop_ids && train.stops) {
                        const stopsIntersection = platform.stop_ids.filter(stopId => train.stops!.some(s => s.stopId === stopId));
                        if (stopsIntersection.length > 0) {
                            setTrainBlock(train, platform.blockNumber);
                            return;
                        }
                    }
                }

                // 2: Default platforms with matching bearing
                for (const platform of block.platforms) {
                    if (platform.routes && !platform.routes.some(r => train.route.includes(r))) {
                        continue; // Skip this platform if the train's route is not allowed
                    }

                    if (platform.isDefault) {
                        if (platform.bearing) {
                            if (train.position.bearing) {
                                // If the platform has a bearing, check if the train's heading is within +/-90 degrees
                                train.position.bearing = train.position.bearing % 360;
                                const bearingDiff = Math.abs(platform.bearing - train.position.bearing);
                                const normalizedBearingDiff = bearingDiff > 180 ? 360 - bearingDiff : bearingDiff;
                                if (normalizedBearingDiff <= 90) {
                                    setTrainBlock(train, platform.blockNumber);
                                    return;
                                }
                            }
                        }
                    }
                }

                // 3: Any default platform for this block
                for (const platform of block.platforms) {
                    if (platform.routes && !platform.routes.some(r => train.route.includes(r))) {
                        continue; // Skip this platform if the train's route is not allowed
                    }
                    if (platform.isDefault && !platform.bearing) {
                        setTrainBlock(train, platform.blockNumber);
                        return;
                    }
                }

            } else {
                setTrainBlock(train, block.blockNumber);
                return;
            }
        }
    }

    // Train is not in any known block
    train.currentBlock = undefined;
    train.previousBlock = undefined;
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
        // .filter(train => train.position.timestamp > Math.ceil(Date.now() / 1000) - 300); // Only consider trains with recent updates
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