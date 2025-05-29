import { promises as fs } from 'fs';
import { DOMParser } from '@xmldom/xmldom';
import type { Entity } from 'gtfs-types';

// --- Interfaces ---
export interface LEDUpdate {
    b: number[]; // [Pre, Post] update track block number (e.g., 302)
    c: number; // Color ID
    t: number; // Offset time from timestamp in seconds
}

export interface LEDMapUpdate {
    version: string;                    // Intended Version of the Board (e.g. V1.0.0)
    timestamp: number;                  // Epoch Seconds timestamp of this update
    update: number;                     // Offset time from timestamp for next update
    colors: Record<number, number[]>;   // Map color Id to [R,G,B]
    updates: LEDUpdate[];               // Map block number to LEDUpdate
}

interface TrackBlock {
    blockNumber: number;                // Track block number (ref from pcb) (e.g., D302 is 302)
    name: string;                       // Name of the KML Placemark (e.g. "302 - Parnell")
    priority: boolean;                  // Indicates if this block is a high priority block (e.g. stations)
    polygon: Array<[number, number]>;   // Array of [latitude, longitude] tuples
}

interface TrainInfo {
    trainId: string; // Vehicle ID from GTFS e.g. "59185" for AMP185
    position: { latitude: number; longitude: number; timestamp: number }; // GTFS Position update of the train
    currentBlock?: number | undefined; // Track block number (e.g., 301)
    previousBlock?: number | undefined; // Previous block number (e.g., 300)
    colorId: number; // Converted using ROUTE_TO_COLOR_ID_MAP
}

// --- Configuration ---

// Defines mapping from GTFS route_id to a numeric color identifier for the LED map
const ROUTE_TO_COLOR_ID_MAP: Record<string, number> = {
    'WEST-201': 2,
    'EAST-201': 3,
    'ONE-201': 4,
    'STH-201': 5,
};
const OUT_OF_SERVICE_COLOR_ID = 1; // Default color for out of service trains

const DISPLAY_THRESHOLD = 180; // 3 minutes in seconds
const UPDATE_INTERVAL = 20; // Update interval in seconds

// Module-level state for currently occupied blocks by trains
const trackBlocks = new Map<number, TrackBlock>(); // Map<blockNumber, TrackBlock>
const trackedTrains: TrainInfo[] = [];

// --- KML Parsing ---
export async function loadTrackBlocks(filePath: string) {
    const kmlContent = await fs.readFile(filePath, 'utf-8');
    const doc = new DOMParser().parseFromString(kmlContent, 'text/xml');
    const loadedBlocks: TrackBlock[] = [];
    const placemarks = doc.getElementsByTagName('Placemark');

    for (const placemark of Array.from(placemarks)) {
        const nameElement = placemark.getElementsByTagName('name')[0];
        const id = nameElement?.textContent;

        // Skip placemarks without a name
        if (!id) {
            console.warn('Placemark without a name found, skipping.');
            continue;
        }

        const blockNumber = parseInt(id, 10);
        if (isNaN(blockNumber)) {
            console.warn(`Invalid block number in ID: ${id}`);
            continue;
        }

        const priority = /[a-zA-Z]/.test(id);
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
                    priority,
                    polygon: points
                });
            } else {
                console.warn(`Placemark '${id}' had no valid coordinates`);
            }
        } else {
            console.warn(`Placemark '${id}' missing coordinates`);
        }
    }

    // Clear existing map and add sorted blocks
    trackBlocks.clear();
    loadedBlocks
        .sort((a, b) => Number(b.priority) - Number(a.priority)) // Priority first
        .forEach(block => {
            trackBlocks.set(block.blockNumber, block);
        });
    return trackBlocks;
}

/**
 * Checks if a point is inside a polygon using the Ray Casting algorithm.
 * @param pointLat Latitude of the point to check.
 * @param pointLng Longitude of the point to check.
 * @param polygon Array of [lat, lng] tuples defining the polygon vertices.
 * @returns True if the point is inside the polygon, false otherwise.
 */
function isPointInPolygon(pointLat: number, pointLng: number, polygon: Array<[number, number]>): boolean {
    if (!polygon || polygon.length < 3) {
        // A polygon needs at least 3 vertices
        return false;
    }

    let isInside = false;

    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const lat_i = polygon[i][0];
        const lng_i = polygon[i][1];
        const lat_j = polygon[j][0];
        const lng_j = polygon[j][1];

        // Check if the point's latitude is between the latitudes of the edge's endpoints
        const isLatBetweenEdgePoints = (lat_i > pointLat) !== (lat_j > pointLat);
        // Calculate the longitude of the intersection of the ray with the edge
        const intersectionLng = (lng_j - lng_i) * (pointLat - lat_i) / (lat_j - lat_i) + lng_i;

        // If the point's latitude is between edge points and its longitude is to the left of intersection
        if (isLatBetweenEdgePoints && pointLng < intersectionLng) {
            isInside = !isInside;
        }
    }
    return isInside;
}

/**
 * Processes a train entity to check if it occupies a specific track block polygon.
 * @param train Train with position data
 * @param blockNumber Track block number to check against
 * @returns True if the train is within the block's polygon, false otherwise
 */
const trainInBlock = (train: TrainInfo, blockNumber: number): boolean => {
    const block = trackBlocks.get(blockNumber);
    if (block) {
        return isPointInPolygon(train.position.latitude, train.position.longitude, block.polygon);
    }
    return false;
};

/**
 * Updates LED map state based on train positions within track block polygons
 * @param gtfsTrains Array of train entities with position data
 * @param ledMap LED map object to be updated
 * @returns Promise resolving to updated LED map
 */
export async function updateLEDMap(
    gtfsTrains: Entity[],
    ledMap: LEDMapUpdate
): Promise<LEDMapUpdate> {
    // Mirror gtfsTrains to trackedTrains
    gtfsTrains.forEach(train => {
        const existing = trackedTrains.find(t => t.trainId === train.id);
        if (existing) {
            // Update existing train position
            existing.position.latitude = train.vehicle?.position?.latitude ?? 0;
            existing.position.longitude = train.vehicle?.position?.longitude ?? 0;
            existing.position.timestamp = train.vehicle?.timestamp ?? 0;
            existing.colorId = ROUTE_TO_COLOR_ID_MAP[train.vehicle?.trip?.route_id ?? ''] ?? OUT_OF_SERVICE_COLOR_ID;
        } else {
            // Add new train
            trackedTrains.push({
                trainId: train.id,
                position: {
                    latitude: train.vehicle?.position?.latitude ?? 0,
                    longitude: train.vehicle?.position?.longitude ?? 0,
                    timestamp: train.vehicle?.timestamp ?? 0,
                },
                colorId: ROUTE_TO_COLOR_ID_MAP[train.vehicle?.trip?.route_id ?? ''] ?? OUT_OF_SERVICE_COLOR_ID,
                currentBlock: undefined,
                previousBlock: undefined,
            });
        }
    });

    trackedTrains.forEach(train => {
        if (train.currentBlock && trainInBlock(train, train.currentBlock)) {
            // Train is still in the same block, no need to update
            train.previousBlock = train.currentBlock;
        } else {
            // Current Block invalid, find the new block it occupies 
            // TODO: Optimize this search by checking nearby blocks first
            for (const block of trackBlocks.values()) {
                if (trainInBlock(train, block.blockNumber)) {
                    if (train.currentBlock) { train.previousBlock = train.currentBlock } else { train.previousBlock = block.blockNumber; }
                    train.currentBlock = block.blockNumber;
                    break; // Found the block, no need to check further
                }
            }

            if (!train.currentBlock) {
                console.warn(`Train ${train.trainId} is not in any block (${train.position.latitude}, ${train.position.longitude})`);
            }
        }
    });

    // await fs.writeFile('cache/trackedTrains.json', JSON.stringify(trackedTrains, null, 2));
    return generateLedMap(ledMap, trackedTrains);
}

/**
 * Generates the LED status for each bus in the LED map based on `currentOccupiedBlocks`.
 * This function mutates the input `ledMap`.
 * @param ledMapUpdate The LEDMap object to update.
 * @returns The mutated LEDMap object with updated LED statuses.
 */
function generateLedMap(ledMapUpdate: LEDMapUpdate, trackedTrains: TrainInfo[]): LEDMapUpdate {
    ledMapUpdate.updates = [];

    const now = Math.floor(Date.now() / 1000);
    const displayCutoff = now - DISPLAY_THRESHOLD;
    const updateTime = now - UPDATE_INTERVAL;

    trackedTrains
        .filter(train => train.position.timestamp >= displayCutoff)
        .forEach(train => {
            if (train.currentBlock && train.previousBlock) {
                ledMapUpdate.updates.push({
                    b: [train.previousBlock, train.currentBlock],
                    c: train.colorId,
                    t: Math.max(train.position.timestamp - updateTime, 0),
                });
                // if (train.currentBlock !== train.previousBlock) {
                //     console.log(`Train ${train.trainId} moved from block ${train.previousBlock} to ${train.currentBlock}`);
                // }
            }
        });

    ledMapUpdate.timestamp = updateTime + UPDATE_INTERVAL;
    return ledMapUpdate;
}