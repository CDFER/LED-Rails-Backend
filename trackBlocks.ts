import { promises as fs } from 'fs';
import { DOMParser } from '@xmldom/xmldom';
import type { Entity } from 'gtfs-types';

// --- Interfaces ---
export interface TrackBlock {
    id: string; // Name of the KML Placemark
    priority: boolean; // Indicates if this block is a high priority block
    polygon: Array<[number, number]>; // [latitude, longitude] tuples
}

export interface LedBusConfig {
    busId: string; // Corresponds to keys in BLOCK_RANGES_BY_BUS_ID
    leds: Record<string, { // Key is LED index (string)
        colorId: number;   // Color identifier
        timestamp: number; // Last update time (Epoch Seconds timestamp)
    }>;
}


export interface LedMap {
    version: string;
    lineColors: Record<string, string>; // colorId (string) to hex color string
    busses: LedBusConfig[];
}

// Represents a train found to be occupying a specific track block
interface OccupiedBlockInfo {
    trackBlockId: string; // ID of the TrackBlock (KML Placemark name, e.g., "301")
    vehicleId: string; // Vehicle ID from GTFS e.g. "59185"
    timestamp: number; // Epoch (seconds) Timestamp of the vehicle's position
    occupied: boolean; // Whether the block is occupied
    routeId: string | undefined; // Route ID from GTFS e.g. "WEST-201"
}

// --- Configuration ---
const BLOCK_RANGES_BY_BUS_ID: Record<string, { min: number; max: number }> = {
    STRAND_MNK: { min: 300, max: 343 },
    NAL_NIMT: { min: 100, max: 207 },
};

// Defines mapping from GTFS route_id to a numeric color identifier for the LED map
const ROUTE_TO_COLOR_ID_MAP: Record<string, number> = {
    'WEST-201': 2,
    'EAST-201': 3,
    'ONE-201': 4,
    'STH-201': 5,
};
const DEFAULT_OCCUPIED_COLOR_ID = 1; // Default color for out of service trains
const BLACK_COLOR_ID = 0; // Default color for unoccupied LEDs

// Module-level state for currently occupied blocks by trains
let currentOccupiedBlocks: OccupiedBlockInfo[] = [];

// --- KML Parsing ---
export async function loadTrackBlocks(filePath: string): Promise<TrackBlock[]> {
    const kmlContent = await fs.readFile(filePath, 'utf-8');
    const doc = new DOMParser().parseFromString(kmlContent, 'text/xml');
    const loadedBlocks: TrackBlock[] = [];
    const placemarks = doc.getElementsByTagName('Placemark');

    for (const placemark of Array.from(placemarks)) {
        const nameElement = placemark.getElementsByTagName('name')[0];
        // Use unique ID based on current count if name is missing
        const id = nameElement?.textContent;
        // skip placemarks without a name
        if (!id) {
            console.warn('Placemark without a name found, skipping.');
            continue;
        }

        const priority = /[a-zA-Z]/.test(id ?? '');
        const coordinatesElement = placemark.getElementsByTagName('coordinates')[0];
        const coordsString = coordinatesElement?.textContent?.trim();

        if (coordsString) {
            const points = coordsString
                .split(/\s+/) // Split by one or more spaces
                .map((coordPairStr) => {
                    const [lon, lat] = coordPairStr.split(',').map(Number);
                    return [lat, lon] as [number, number]; // KML is lon,lat - we use lat,lon
                })
                .filter(point => !isNaN(point[0]) && !isNaN(point[1])); // Ensure valid numbers

            if (id && points.length > 0) { // Only add if there are valid points
                loadedBlocks.push({ id, priority, polygon: points });
            } else {
                console.warn(`Placemark '${id}' had no valid coordinate points after parsing.`);
            }
        } else {
            console.warn(`Placemark '${id}' is missing coordinates.`);
        }
    }

    // Sort blocks with priority first
    const sortedBlocks = [...loadedBlocks].sort((a, b) =>
        Number(b.priority) - Number(a.priority));
    return sortedBlocks;
}

// --- Geometric Calculation ---
/**
 * Checks if a point is inside a polygon using the Ray Casting algorithm.
 * @param pointLat Latitude of the point to check.
 * @param pointLng Longitude of the point to check.
 * @param polygon Array of [lat, lng] tuples defining the polygon vertices.
 * @returns True if the point is inside the polygon, false otherwise.
 */
function isPointInPolygon(pointLat: number, pointLng: number, polygon: Array<[number, number]> | undefined): boolean {
    if (!polygon || polygon.length < 3) { // A polygon needs at least 3 vertices
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

// --- LED Map Logic ---
/**
 * Updates LED map state based on train positions within track block polygons
 * 
 * @param trackBlocks Array of track block definitions with geofencing polygons (priority blocks first)
 * @param trains Array of train entities with position data
 * @param ledMap LED map object to be updated
 * @returns Promise resolving to updated LED map
 * 
 * @sideeffects
 * - Clears and repopulates `currentOccupiedBlocks` Set
 * - Mutates the provided `ledMap` object
 */
export async function updateLedMapWithOccupancy(
    trackBlocks: TrackBlock[],
    trains: Entity[],
    ledMap: LedMap
): Promise<LedMap> {
    // currentOccupiedBlocks.clear();
    // currentOccupiedBlocks = []; // Reset the occupied blocks for each update

    const processBlock = (train: Entity, block: TrackBlock): boolean => {
        const { latitude, longitude } = train.vehicle?.position ?? {};
        if (!latitude || !longitude) return false;

        if (isPointInPolygon(latitude, longitude, block.polygon)) {
            return true;
        }
        return false;
    };

    // Filter out blocks that are not occupied
    currentOccupiedBlocks = currentOccupiedBlocks.filter(block => block.occupied);

    const recentCutoff = (Date.now() / 1000) - 180; // 3 minutes ago
    trains
        .filter(t => (t.vehicle?.timestamp ?? 0) > recentCutoff)
        .forEach(train => {
            if (!train.vehicle?.position) return;

            let foundBlockId: string | undefined = undefined;

            for (const block of trackBlocks) {
                if (processBlock(train, block)) {
                    foundBlockId = block.id;
                    break;
                }
            }

            if (foundBlockId) {
                const entry: OccupiedBlockInfo = {
                    trackBlockId: foundBlockId,
                    vehicleId: train.id,
                    timestamp: train.vehicle!.timestamp,
                    occupied: true,
                    routeId: train.vehicle?.trip?.route_id,
                };

                // Find and update existing entry or add new one
                const existingIndex = currentOccupiedBlocks.findIndex(e => e.vehicleId === train.id);
                if (existingIndex > -1 && currentOccupiedBlocks[existingIndex]) {
                    currentOccupiedBlocks[existingIndex].occupied = false; // Mark as not occupied
                    currentOccupiedBlocks[existingIndex].timestamp = train.vehicle!.timestamp; // Update timestamp
                }
                currentOccupiedBlocks.push(entry);
            }
        });

    await fs.writeFile('cache/blocks.json', JSON.stringify(currentOccupiedBlocks, null, 2));
    return generateLedMapFromOccupancy(ledMap);
}


/**
 * Generates the LED status for each bus in the LED map based on `currentOccupiedBlocks`.
 * This function mutates the input `ledMap`.
 * @param ledMap The LEDMap object to update.
 * @returns The mutated LEDMap object with updated LED statuses.
 */
function generateLedMapFromOccupancy(ledMap: LedMap): LedMap {
    for (const busConfig of ledMap.busses) {
        busConfig.leds = {}; // Clear previous LEDs for this bus

        const blockRange = BLOCK_RANGES_BY_BUS_ID[busConfig.busId];
        if (!blockRange) {
            console.warn(`No block range definition found for bus_id: ${busConfig.busId}`);
            continue;
        }

        for (const occupiedInfo of currentOccupiedBlocks) {
            const trackBlockNum = parseInt(occupiedInfo.trackBlockId, 10);

            if (isNaN(trackBlockNum)) {
                console.warn(`Track block ID '${occupiedInfo.trackBlockId}' is not a valid number. Skipping for LED map.`);
                continue;
            }

            if (trackBlockNum >= blockRange.min && trackBlockNum <= blockRange.max) {
                const ledIndex = trackBlockNum - blockRange.min;
                const ledIndexStr = ledIndex.toString();

                // Determine color: specific route color or default occupied color
                let colorId = BLACK_COLOR_ID; // Default color for unoccupied LEDs
                if (occupiedInfo.occupied) {
                    colorId = ROUTE_TO_COLOR_ID_MAP[occupiedInfo.routeId ?? ''] ?? DEFAULT_OCCUPIED_COLOR_ID;
                }

                // Set LED color. Prioritize specific high index colors.
                const existingColor = busConfig.leds[ledIndexStr]?.colorId;
                if (existingColor == undefined || existingColor < colorId) {
                    busConfig.leds[ledIndexStr] = { colorId, timestamp: occupiedInfo.timestamp + 20 };
                }
            }
        }
    }
    return ledMap;
}