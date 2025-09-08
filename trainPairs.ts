import type { Entity } from 'gtfs-types';

// --- Configuration for Pair Detection ---
const PAIR_CRITERIA = {
    minSpeed: 3, // Minimum speed in m/s to consider a train for pairing
    maxSpeed: 35, // Maximum speed in m/s to consider
    trainLength: 72, // Train length in meters (used for distance calculations)
    maxSpeedDiff: 3, // Maximum speed difference in m/s to consider trains as a pair
    maxBearingDiff: 5, // Maximum bearing difference in degrees to consider trains as a pair
};

// --- Configuration for Breaking Pairs ---
const NOT_PAIR_CRITERIA = {
    maxDistance: 2000, // Maximum distance in meters to keep trains as a pair
};

export interface TrainPair {
    pairKey: string; // Unique key, e.g., "ID1-ID2" sorted
    vehicleIds: [string, string]; // IDs of the two trains in the pair
    detectedAt: string; // ISO timestamp when the pair was first detected

    // Stores the criteria values that were met when the pair was detected (only for reference/debugging)
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
 * Checks for train pairs, updates existing ones, and identifies new ones.
 *
 * This function:
 * - Updates and removes existing pairs if the distance criteria is breached
 * - Identifies new pairs from trains that are not part of an existing pair
 * - Collects vehicle IDs of trains that are part of a pair ("invisible" trains)
 *
 * @param rawTrains - Full list of currently active train entities from the feed
 * @param trainPairs - Existing list of train pairs to update
 * @returns An object containing:
 *   - invisibleTrainIds: List of vehicle IDs for trains that are part of a pair ("invisible" trains)
 *   - trainPairs: Updated list of train pairs
 */
export async function checkForTrainPairs(rawTrains: Entity[], trainPairs: TrainPair[]): Promise<{ invisibleTrainIds: string[], trainPairs: TrainPair[] }> {
    let invisibleTrainIds: string[] = [];

    // 1. Update and remove existing pairs if the distance criteria is breached
    trainPairs.forEach(trainPair => {
        const [idA, idB] = trainPair.vehicleIds;
        const trainA = rawTrains.find(train => train.vehicle?.vehicle?.id === idA)?.vehicle;
        const trainB = rawTrains.find(train => train.vehicle?.vehicle?.id === idB)?.vehicle;
        if (trainA?.position && trainB?.position && trainA.position?.latitude != 0 && trainB.position?.latitude != 0) {
            const distance = calculateDistance(trainA.position?.latitude, trainA.position?.longitude, trainB.position?.latitude, trainB.position?.longitude);

            if (distance > NOT_PAIR_CRITERIA.maxDistance) {
                // console.log(`Pair ${trainPair.pairKey} broken distance limit: ${distance.toFixed(0)}m @ ${[[trainA.position?.latitude.toFixed(5), trainA.position?.longitude.toFixed(5)], [trainB.position?.latitude.toFixed(5), trainB.position?.longitude.toFixed(5)]]}`);
                trainPairs = trainPairs.filter(pair => pair.pairKey !== trainPair.pairKey); // Remove pair if distance criteria is breached
            }
        }
        rawTrains = rawTrains.filter(train => train.vehicle?.vehicle?.id !== idA && train.vehicle?.vehicle?.id !== idB);
    });

    // 2. Identify new pairs from trains that are not part of an existing pair
    const timeNow = Date.now() / 1000; // Current time in seconds since epoch
    rawTrains = rawTrains.filter(train => train.vehicle?.position?.speed && train.vehicle?.position?.speed >= PAIR_CRITERIA.minSpeed); // Filter out trains below minimum speed
    rawTrains = rawTrains.filter(train => train.vehicle?.position?.latitude && train.vehicle?.position?.longitude); // Filter out trains without coordinates
    rawTrains = rawTrains.filter(train => train.vehicle?.timestamp && train.vehicle?.timestamp >= timeNow - 30); // Filter out trains older than 30 seconds

    for (let i = 0; i < rawTrains.length; i++) {
        const trainAEntity = rawTrains[i] as Entity;
        for (let j = i + 1; j < rawTrains.length; j++) {
            const trainBEntity = rawTrains[j] as Entity;

            const posA = trainAEntity.vehicle!.position!;
            const posB = trainBEntity.vehicle!.position!;

            if (!trainAEntity.vehicle?.timestamp || !trainBEntity.vehicle?.timestamp) continue; // Skip if timestamps are missing

            let distance = calculateDistance(posA.latitude!, posA.longitude!, posB.latitude!, posB.longitude!); // Calculate distance between the two trains
            distance = Math.max(distance - 2 * PAIR_CRITERIA.trainLength, 0); // Adjust distance by train length to account for the GPS being in one end of the train (AMP car)
            if (distance > (2 * PAIR_CRITERIA.trainLength)) continue;

            const timeDiff = Math.abs(trainAEntity.vehicle.timestamp - trainBEntity.vehicle.timestamp);
            const speed = distance / timeDiff;
            if (speed > PAIR_CRITERIA.maxSpeed) continue;

            const speedDiff = Math.abs(posA.speed! - posB.speed!); // Calculate speed difference in m/s
            if (speedDiff > PAIR_CRITERIA.maxSpeedDiff) continue;

            const bearingDiff = calculateBearingDifference(posA.bearing!, posB.bearing!); // Calculate bearing difference in degrees
            if (bearingDiff > PAIR_CRITERIA.maxBearingDiff) continue;

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
            // console.log(`New pair ${newPair.pairKey} detected`);
        }
    }

    // 3. Collect vehicle IDs of trains that are part of a pair (invisible trains)
    trainPairs.forEach(pair => {
        const [idA, idB] = pair.vehicleIds;
        const routeA = rawTrains.find(train => train.vehicle?.vehicle?.id === idA)?.vehicle?.trip?.route_id;
        if (routeA == "") { invisibleTrainIds.push(idA) }
        else { invisibleTrainIds.push(idB) };
    });

    // Remove duplicates
    invisibleTrainIds = Array.from(new Set(invisibleTrainIds));
    return { invisibleTrainIds, trainPairs };
}