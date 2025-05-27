import { promises as fs } from 'fs';
import path from 'path';
import type { Entity } from 'gtfs-types';

// --- Configuration for Pair Detection ---
const PAIR_CONFIG = {
    minSpeed: 3, // Minimum speed in m/s to consider a train for pairing
    maxDistance: 1050, // Maximum distance in meters to consider trains as a pair (30s at 35 m/s)
    maxSpeed: 35, // Maximum speed in m/s to consider
    trainLength: 72, // Train length in meters (used for distance calculations)
    maxSpeedDiff: 3, // Maximum speed difference in m/s to consider trains as a pair
    maxBearingDiff: 30, // Maximum bearing difference in degrees to consider trains as a pair
    cacheFolder: path.join(__dirname, 'cache'),
};

const TRAIN_PAIRS_CACHE_FILE = path.join(PAIR_CONFIG.cacheFolder, 'train-pairs-cache.json');

interface TrainPair {
    pairKey: string; // Unique key, e.g., "ID1-ID2" sorted
    vehicleIds: [string, string]; // IDs of the two trains in the pair
    detectedAt: string; // ISO timestamp when the pair was first detected
    // Stores the criteria values that were met when the pair was detected
    metCriteria: {
        distanceMeters: number;
        speed: number; // Speed in m/s to get between the two train locations
        speedDifferenceMPS: number;
        bearingDifferenceDegrees: number;
        updatedAt: [number, number]; // Timestamp of the last update in seconds since epoch
        speeds: [number, number]; // Speeds of the two trains in m/s
        routeIds: [string, string]; // Route IDs of the two trains, can be empty if undefined
        location: [number, number][]; // The coordinates of the two trains as [latitude, longitude] tuples
    };
}

// Memory store for train pairs
let previousTrainPairs: TrainPair[] = [];
let trainPairs: TrainPair[] = [];

/**
 * Calculates the distance in meters between two geographic coordinates using the Haversine formula.
 */
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371e3; // Earth's radius in meters
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const deltaPhi = (lat2 - lat1) * Math.PI / 180;
    const deltaLambda = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
        Math.cos(phi1) * Math.cos(phi2) *
        Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Calculates the min angle between two bearings (0-360 degrees).
 */
function calculateBearingDifference(bearing1: number, bearing2: number): number {
    const diff = Math.abs(bearing1 - bearing2);
    return Math.min(diff, 360 - diff);
}

/**
 * Loads train pairs from the cache file into trainPairs
 * Should be called once at server startup.
 */
export async function loadTrainPairsFromCache(): Promise<number> {
    try {
        await fs.mkdir(PAIR_CONFIG.cacheFolder, { recursive: true }); // Ensure directory exists
        const fileContent = await fs.readFile(TRAIN_PAIRS_CACHE_FILE, 'utf-8');
        trainPairs = JSON.parse(fileContent) as TrainPair[];
        return trainPairs.length;
    } catch (error) {
        console.warn(`Failed to load train pairs from cache: ${getErrorMessage(error)}`);
        return 0; // Return 0 if loading fails
    }
}

/**
 * Saves trainPairs to the cache file.
 */
async function saveTrainPairsToCache() {
    try {
        await fs.mkdir(PAIR_CONFIG.cacheFolder, { recursive: true }); // Ensure directory exists
        await fs.writeFile(TRAIN_PAIRS_CACHE_FILE, JSON.stringify(trainPairs, null, 2));
    } catch (error) {
        console.error(`Failed to save train pairs to cache: ${getErrorMessage(error)}`);
    }
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Checks for train pairs, updates existing ones, and identifies new ones.
 * @param rawTrains Full list of currently active train entities from the feed.
 * @param log Custom logging function.
 */
export async function checkForTrainPairs(rawTrains: Entity[]): Promise<Entity[]> {
    previousTrainPairs = [...trainPairs]; // Store previous pairs for comparison
    let returnedTrains = rawTrains; // Copy of rawTrains to return at the end

    // 1. Update and remove existing pairs if the distance criteria is breached
    trainPairs.forEach(trainPair => {
        const [idA, idB] = trainPair.vehicleIds;
        const trainA = rawTrains.find(train => train.vehicle?.vehicle?.id === idA)?.vehicle;
        const trainB = rawTrains.find(train => train.vehicle?.vehicle?.id === idB)?.vehicle;
        if (trainA?.position && trainB?.position) {
            const distance = calculateDistance(trainA.position?.latitude, trainA.position?.longitude, trainB.position?.latitude, trainB.position?.longitude);

            if (distance > PAIR_CONFIG.maxDistance) {
                console.log(`Pair ${trainPair.pairKey} broken distance limit: ${distance.toFixed(1)} meters`);
                console.log(trainPair);
                trainPairs = trainPairs.filter(pair => pair.pairKey !== trainPair.pairKey); // Remove pair if distance criteria is breached
            }
        }
        rawTrains = rawTrains.filter(train => train.vehicle?.vehicle?.id !== idA && train.vehicle?.vehicle?.id !== idB);
    });

    // 2. Identify new pairs from trains that are not part of an existing pair
    const timeNow = Date.now() / 1000; // Current time in seconds since epoch
    rawTrains = rawTrains.filter(train => train.vehicle?.position?.speed && train.vehicle?.position?.speed >= PAIR_CONFIG.minSpeed); // Filter out trains below minimum speed
    rawTrains = rawTrains.filter(train => train.vehicle?.position?.latitude && train.vehicle?.position?.longitude); // Filter out trains without coordinates
    rawTrains = rawTrains.filter(train => train.vehicle?.timestamp && train.vehicle?.timestamp >= timeNow - 30); // Filter out trains older than 30 seconds

    for (let i = 0; i < rawTrains.length; i++) {
        const trainAEntity = rawTrains[i] as Entity;
        for (let j = i + 1; j < rawTrains.length; j++) {
            const trainBEntity = rawTrains[j] as Entity;

            const posA = trainAEntity.vehicle!.position!;
            const posB = trainBEntity.vehicle!.position!;

            // if (!posA.latitude || !posA.longitude || !posB.latitude || !posB.longitude) continue; // Skip if coordinates are missing
            if (!trainAEntity.vehicle?.timestamp || !trainBEntity.vehicle?.timestamp) continue; // Skip if timestamps are missing

            let distance = calculateDistance(posA.latitude!, posA.longitude!, posB.latitude!, posB.longitude!); // Calculate distance between the two trains
            distance = Math.max(distance - 2 * PAIR_CONFIG.trainLength, 0); // Adjust distance by train length to account for the GPS being in one end of the train (AMP car)
            if (distance > (2 * PAIR_CONFIG.trainLength)) continue;

            const timeDiff = Math.abs(trainAEntity.vehicle.timestamp - trainBEntity.vehicle.timestamp);
            const speed = distance / timeDiff;
            if (speed > PAIR_CONFIG.maxSpeed) continue;

            const speedDiff = Math.abs(posA.speed! - posB.speed!); // Calculate speed difference in m/s
            if (speedDiff > PAIR_CONFIG.maxSpeedDiff) continue;

            const bearingDiff = calculateBearingDifference(posA.bearing!, posB.bearing!); // Calculate bearing difference in degrees
            if (bearingDiff > PAIR_CONFIG.maxBearingDiff) continue;

            const routeA = trainAEntity.vehicle?.trip?.route_id;
            const routeB = trainBEntity.vehicle?.trip?.route_id;
            if (routeA && routeB && routeA !== routeB) continue; // Skip if trains are on different routes (undefined and route is allowed)

            // All criteria met for a new pair
            const newPair: TrainPair = {
                pairKey: [trainAEntity?.id, trainBEntity?.id].sort().join('-'),
                vehicleIds: [trainAEntity?.id, trainBEntity?.id].sort() as [string, string],
                detectedAt: new Date().toISOString(),
                metCriteria: {
                    distanceMeters: distance,
                    speed: speed, // Speed in m/s to get between the two train locations
                    speedDifferenceMPS: speedDiff,
                    bearingDifferenceDegrees: bearingDiff,
                    updatedAt: [trainAEntity.vehicle.timestamp, trainBEntity.vehicle.timestamp], // Current timestamp in seconds since epoch
                    speeds: [posA.speed!, posB.speed!], // Store speeds in m/s
                    routeIds: [routeA || '', routeB || ''], // Store route IDs, can be empty if undefined
                    location: [[posA.latitude!, posA.longitude!], [posB.latitude!, posB.longitude!]] // Store coordinates as [latitude, longitude] tuples
                }
            };

            rawTrains = rawTrains.filter(train => train.vehicle?.vehicle?.id !== newPair.vehicleIds[0] && train.vehicle?.vehicle?.id !== newPair.vehicleIds[1]); // Remove trains that are now paired
            trainPairs.push(newPair);
            console.log(`New pair ${newPair.pairKey} detected:`);
            console.log(newPair);
        }
    }



    // 3. Save the updated train pairs to cache
    if (trainPairs.length != previousTrainPairs.length) {
        const added = trainPairs.filter(np => !previousTrainPairs.some(op => op.pairKey === np.pairKey)).length;
        const removed = previousTrainPairs.filter(op => !trainPairs.some(np => np.pairKey === op.pairKey)).length;
        console.log(`Train pairs updated: ${trainPairs.length} total. Added: ${added}, Removed: ${removed}.`);
        await saveTrainPairsToCache();
    }

    trainPairs.forEach(pair => {
        const [idA, idB] = pair.vehicleIds;
        const routeA = returnedTrains.find(train => train.vehicle?.vehicle?.id === idA)?.vehicle?.trip?.route_id;
        if (routeA) { returnedTrains = returnedTrains.filter(train => train.vehicle?.vehicle?.id !== idB) }
        else { returnedTrains = returnedTrains.filter(train => train.vehicle?.vehicle?.id !== idA) };
    });
    return returnedTrains;
}