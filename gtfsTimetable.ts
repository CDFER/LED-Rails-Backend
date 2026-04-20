import fs from 'fs';
import path from 'path';
import { parseGTFSFileSync, parseStopTimesForTripsSync } from './staticGTFS';
import { Shapes } from 'gtfs-types';
import { TrackBlockMap, TrainInfo, findAndSetTrainBlock, trainInBlock } from './trackBlocks';
import { calculateDistance } from './trainPairs';

// Simple typed interfaces for the GTFS data we are processing
export interface GTFSCalendarRecord {
    service_id: string;
    monday: string;
    tuesday: string;
    wednesday: string;
    thursday: string;
    friday: string;
    saturday: string;
    sunday: string;
    start_date: string;
    end_date: string;
}

export interface GTFSTripRecord {
    route_id: string;
    service_id: string;
    trip_id: string;
    shape_id: string;
    trip_headsign: string;
    direction_id: string;
    block_id: string;
    wheelchair_accessible: string;
    bikes_allowed: string;
    stop_times?: GTFSStopTimeRecord[]; // Optional property to hold stop times for this trip
}

export interface GTFSStopTimeRecord {
    trip_id: string;
    arrival_time: string;
    departure_time: string;
    stop_id: string;
    stop_sequence: string;
    stop_headsign: string;
    pickup_type: string;
    drop_off_type: string;
    shape_dist_traveled: string;
}

export interface GTFSShapeRecord {
    shape_id: string;
    points: Shapes[];
}

export interface GTFSStopRecord {
    stop_id: string;
    stop_code?: string;
    stop_name: string;
    stop_desc?: string;
    stop_lat: string;
    stop_lon: string;
    zone_id?: string;
    stop_url?: string;
    location_type?: string;
    parent_station?: string;
    stop_timezone?: string;
    wheelchair_boarding?: string;
    level_id?: string;
    platform_code?: string;
}

export type DayOfWeek = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export class staticGTFSQuery {
    private gtfsFolderPath: string;

    constructor(gtfsFolderPath: string) {
        this.gtfsFolderPath = gtfsFolderPath;
    }

    /**
     * Determines the day of the week from a YYYYMMDD date string.
     */
    private getDayOfWeekFromDateStr(dateStr: string): DayOfWeek {
        const year = parseInt(dateStr.substring(0, 4));
        const month = parseInt(dateStr.substring(4, 6)) - 1; // 0-indexed
        const day = parseInt(dateStr.substring(6, 8));

        const date = new Date(year, month, day);
        const days: DayOfWeek[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        return days[date.getDay()] as DayOfWeek;
    }

    /**
     * Finds the next date for a specific day of the week starting from today.
     * If today is the target day, it returns today.
     */
    public getNextDateForDayOfWeek(targetDay: DayOfWeek): string {
        const targetDate = new Date();

        const dayMapping: Record<DayOfWeek, number> = {
            'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 'friday': 5, 'saturday': 6
        };

        const targetDayNum = dayMapping[targetDay];
        while (targetDate.getDay() !== targetDayNum) {
            targetDate.setDate(targetDate.getDate() + 1);
        }

        const y = targetDate.getFullYear();
        const m = String(targetDate.getMonth() + 1).padStart(2, '0');
        const d = String(targetDate.getDate()).padStart(2, '0');

        return `${y}${m}${d}`;
    }

    /**
     * Gets all service_ids that run on a specific date string (YYYYMMDD format).
     * It checks whether the date falls within start_date/end_date and active on the day of the week.
     */
    public getServicesByDate(targetDateYYYYMMDD: string): Set<string> {
        const calendarFile = path.resolve(this.gtfsFolderPath, 'calendar.txt');
        const activeServices = new Set<string>();
        const targetDayOfWeek = this.getDayOfWeekFromDateStr(targetDateYYYYMMDD);

        const targetDateNum = parseInt(targetDateYYYYMMDD);

        if (!fs.existsSync(calendarFile)) return activeServices;

        // Stream calendar.txt looking for a "1" on the requested day
        const records = parseGTFSFileSync<GTFSCalendarRecord>(calendarFile);
        for (const record of records) {
            const startNum = parseInt(record.start_date);
            const endNum = parseInt(record.end_date);

            // Check if the target date is within the range, AND runs on that day of week natively
            if (targetDateNum >= startNum && targetDateNum <= endNum && record[targetDayOfWeek] === '1') {
                activeServices.add(record.service_id);
            }
        }

        return activeServices;
    }

    /**
     * Finds all trip_ids that run on the requested GTFS date (YYYYMMDD).
     */
    public getTripsByDate(targetDateYYYYMMDD: string): GTFSTripRecord[] {
        // First get the active service IDs for the date
        const activeServices = this.getServicesByDate(targetDateYYYYMMDD);

        const tripsFile = path.resolve(this.gtfsFolderPath, 'trips.txt');
        const activeTrips: GTFSTripRecord[] = [];

        if (!fs.existsSync(tripsFile) || activeServices.size === 0) return activeTrips;

        // Now stream trips.txt and extract any trip matching those active service_ids
        const trips = parseGTFSFileSync<GTFSTripRecord>(tripsFile);
        for (const trip of trips) {
            if (activeServices.has(trip.service_id)) {
                activeTrips.push(trip);
            }
        }

        return activeTrips;
    }

    /**
     * Finds all stop_times for a specific trip_id, sorted by stop_sequence.
     * Uses early-break optimization since GTFS stop_times are practically always grouped by trip_id.
     */
    public getStopTimesForTrip(tripId: string): GTFSStopTimeRecord[] {
        const stopTimesFile = path.resolve(this.gtfsFolderPath, 'stop_times.txt');
        const stopTimes: GTFSStopTimeRecord[] = [];
        let foundTrip = false;

        if (!fs.existsSync(stopTimesFile)) return stopTimes;

        const records = parseGTFSFileSync<GTFSStopTimeRecord>(stopTimesFile);
        for (const record of records) {
            if (record.trip_id === tripId) {
                stopTimes.push(record);
                foundTrip = true;
            } else if (foundTrip) {
                // We've moved past our target trip block; break the stream early to save time!
                break;
            }
        }

        // Sort by stop_sequence to ensure they are in chronological order
        return stopTimes.sort((a, b) => parseInt(a.stop_sequence) - parseInt(b.stop_sequence));
    }

    /**
     * SUPER FAST BATCH FETCH: Gets stop_times for MULTIPLE trips in a single run
     * and populates the stop_times property on the provided trip records.
     */
    public getStopTimesForMultipleTrips(trips: GTFSTripRecord[]): void {
        const stopTimesFile = path.resolve(this.gtfsFolderPath, 'stop_times.txt');

        if (!fs.existsSync(stopTimesFile) || trips.length === 0) return;

        const tripMap = new Map<string, GTFSTripRecord>();
        for (const trip of trips) {
            trip.stop_times = [];
            tripMap.set(trip.trip_id, trip);
        }

        // Delegate the high-performance file reading and mapping to staticGTFS
        parseStopTimesForTripsSync<GTFSStopTimeRecord>(stopTimesFile, tripMap);

        for (const trip of trips) {
            if (trip.stop_times) {
                trip.stop_times.sort((a, b) => parseInt(a.stop_sequence) - parseInt(b.stop_sequence));
            }
        }
    }

    /**
     * Loads and groups all shapes from shapes.txt, sorting the points by sequence.
     */
    public getAllShapes(): Map<string, GTFSShapeRecord> {
        const shapesFile = path.resolve(this.gtfsFolderPath, 'shapes.txt');
        const shapesMap = new Map<string, GTFSShapeRecord>();

        if (!fs.existsSync(shapesFile)) {
            return shapesMap; // Some GTFS feeds don't have shapes.txt
        }

        // console.time('Parsing shapes.txt');
        const rawRecords = parseGTFSFileSync<Record<string, string>>(shapesFile);

        for (const raw of rawRecords) {
            // Safety guard for empty lines avoiding NaN crashes
            if (!raw.shape_id || !raw.shape_pt_lat || !raw.shape_pt_lon || !raw.shape_pt_sequence) continue;

            const record: Shapes = {
                shape_id: raw.shape_id,
                shape_pt_lat: parseFloat(raw.shape_pt_lat),
                shape_pt_lon: parseFloat(raw.shape_pt_lon),
                shape_pt_sequence: parseInt(raw.shape_pt_sequence)
            };

            if (raw.shape_dist_traveled) {
                record.shape_dist_traveled = parseFloat(raw.shape_dist_traveled);
            }

            let shape = shapesMap.get(record.shape_id);
            if (!shape) {
                shape = {
                    shape_id: record.shape_id,
                    points: []
                };
                shapesMap.set(record.shape_id, shape);
            }
            shape.points.push(record);
        }
        // console.timeEnd('Parsing shapes.txt');

        // console.time('Sorting shaped points');
        // Sort points by sequence for each shape
        for (const shape of shapesMap.values()) {
            shape.points.sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence);
        }
        // console.timeEnd('Sorting shaped points');

        return shapesMap;
    }

    /**
     * Loads all stops from stops.txt into a Map keyed by stop_id.
     */
    public getAllStops(): Map<string, GTFSStopRecord> {
        const stopsFile = path.resolve(this.gtfsFolderPath, 'stops.txt');
        const stopsMap = new Map<string, GTFSStopRecord>();

        if (!fs.existsSync(stopsFile)) {
            console.warn(`stops.txt not found at ${stopsFile}`);
            return stopsMap;
        }

        // console.time('Parsing stops.txt');
        const records = parseGTFSFileSync<GTFSStopRecord>(stopsFile);
        for (const record of records) {
            stopsMap.set(record.stop_id, record);
        }
        // console.timeEnd('Parsing stops.txt');

        return stopsMap;
    }
}

export interface EstimatedShapePoint extends Shapes {
    estimated_time: string;
    estimated_time_seconds: number;
}

export interface BlockSequence {
    id: string;
    startTimes: number[]; // Seconds from midnight for the first block, used as a reference points for offsets
    color: number[]; // 3x8bit RGB color from the route 
    blocks: { blockNumber: number; offsetSeconds: number; }[];
}

export class TripSimulator {
    public shapesWithIssues: string[] = [];

    public timeToSeconds(timeStr: string): number {
        const parts = timeStr.split(':').map(Number);
        const hours = parts[0] || 0;
        const minutes = parts[1] || 0;
        const seconds = parts[2] || 0;
        return (hours * 3600) + (minutes * 60) + seconds;
    }

    public secondsToTime(seconds: number): string {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${pad(h)}:${pad(m)}:${pad(s)}`;
    }

    public derivePointTimings(trip: GTFSTripRecord, shape: GTFSShapeRecord, stopsMap: Map<string, GTFSStopRecord>): EstimatedShapePoint[] {
        const DWELL_TIME_SECONDS = 30; // Assume a default dwell time of 30 seconds at each stop

        if (!trip.stop_times || trip.stop_times.length === 0) {
            return [];
        }

        // 1. Calculate progressive valid distance for every point in the shape
        let currentShapeDist = 0;
        const mappedPoints = shape.points.map((pt, idx) => {
            if (idx > 0) {
                const prev = shape.points[idx - 1]!;
                currentShapeDist += calculateDistance(prev.shape_pt_lat, prev.shape_pt_lon, pt.shape_pt_lat, pt.shape_pt_lon);
            }
            return {
                ...pt,
                calc_dist: currentShapeDist
            };
        });

        // 2. Find closest point in shape for each stop
        let prevPointIndex = 0;
        const stops = trip.stop_times.map(st => {
            const arr = this.timeToSeconds(st.arrival_time);
            let dep = this.timeToSeconds(st.departure_time);

            // If the arrival and departure time is the same, change the departure time to be +DWELL_TIME_SECONDS.
            if (arr === dep) {
                dep += DWELL_TIME_SECONDS;
            }

            const stopRecord = stopsMap.get(st.stop_id);
            let closestDistToPoint = Infinity;
            let closestIndex = prevPointIndex;

            if (stopRecord) {
                const sLat = parseFloat(stopRecord.stop_lat);
                const sLon = parseFloat(stopRecord.stop_lon);

                // Start from the previously mapped point to ensure forward-moving sequence across stops
                for (let idx = prevPointIndex; idx < mappedPoints.length; idx++) {
                    const pt = mappedPoints[idx]!;
                    const d = calculateDistance(sLat, sLon, pt.shape_pt_lat, pt.shape_pt_lon);
                    if (d < closestDistToPoint) {
                        closestDistToPoint = d;
                        closestIndex = idx;
                    }
                }
            }

            prevPointIndex = closestIndex;
            return {
                ...st,
                arrSecs: arr,
                depSecs: dep,
                pointIndex: closestIndex,
                dist: mappedPoints[closestIndex]!.calc_dist
            };
        });

        const estimatedPoints: EstimatedShapePoint[] = [];

        for (let i = 0; i < mappedPoints.length; i++) {
            const point = mappedPoints[i]!;
            const pDist = point.calc_dist || 0;

            let estSecs = 0;
            const firstStop = stops[0]!;
            const lastStop = stops[stops.length - 1]!;

            if (i <= firstStop.pointIndex) {
                estSecs = firstStop.arrSecs;
            } else if (i >= lastStop.pointIndex) {
                // Determine whether this is the last point in the shape
                estSecs = lastStop.depSecs;
            } else {
                for (let j = 0; j < stops.length - 1; j++) {
                    const prevStop = stops[j]!;
                    const nextStop = stops[j + 1]!;

                    // Compare distance or index to determine bounding range
                    if (i >= prevStop.pointIndex && i <= nextStop.pointIndex) {
                        const distRange = nextStop.dist - prevStop.dist;
                        if (distRange === 0) {
                            estSecs = prevStop.depSecs;
                        } else {
                            const distFraction = (pDist - prevStop.dist) / distRange;
                            // Interpolate exactly between previous departure and next arrival
                            const timeRange = nextStop.arrSecs - prevStop.depSecs;
                            estSecs = prevStop.depSecs + (timeRange * distFraction);
                        }
                        break;
                    }
                }
            }

            // For the last point in the shape, output two points if it corresponds to the last stop
            if (i === mappedPoints.length - 1 && i >= lastStop.pointIndex) {
                estimatedPoints.push({
                    ...point,
                    estimated_time_seconds: Math.round(lastStop.arrSecs),
                    estimated_time: this.secondsToTime(Math.round(lastStop.arrSecs))
                });
            }

            estimatedPoints.push({
                ...point,
                estimated_time_seconds: Math.round(estSecs),
                estimated_time: this.secondsToTime(Math.round(estSecs))
            });
        }

        return estimatedPoints;
    }

    public mapPointsToBlocks(
        trip: GTFSTripRecord,
        points: EstimatedShapePoint[],
        trackBlocks: TrackBlockMap,
        cityID: string,
        color: number[]
    ): BlockSequence {
        const END_EXTRA_DWELL_SECONDS = 120-30; // Additional time to add at the end of the route
        const START_EXTRA_DWELL_SECONDS = 120; // Time to add at the start of the route to ensure it appears on the display before moving

        const blocks: { blockNumber: number; offsetSeconds: number; }[] = [];
        let lastBlockNumber: number | undefined = undefined;
        let startTime = 0;

        const stops = trip.stop_times ? trip.stop_times.map(st => ({
            stopId: st.stop_id,
            departureTime: this.timeToSeconds(st.departure_time)
        })) : [];

        let train: TrainInfo = {
            trainId: 'estimate',
            route: trip.route_id,
            position: {
                latitude: 0,
                longitude: 0,
                timestamp: 0,
                bearing: 0,
                speed: undefined
            },
            currentBlock: undefined,
            previousBlock: undefined,
            currentBlockDisplayThreshold: undefined,
            stops: stops,
            tripId: trip.trip_id
        };

        for (let i = 0; i < points.length; i++) {
            const point = points[i]!;

            if (i === 0) {
                startTime = point.estimated_time_seconds;
            }

            // Calculate bearing to the next point
            const nextPoint = points[i + 1];
            let bearing: number | undefined = undefined;
            if (nextPoint) {
                // Approximate bearing
                const dy = nextPoint.shape_pt_lon - point.shape_pt_lon;
                const dx = nextPoint.shape_pt_lat - point.shape_pt_lat;
                bearing = (Math.atan2(dy, dx) * 180) / Math.PI;
                if (bearing < 0) bearing += 360;
            }

            train.position.latitude = point.shape_pt_lat;
            train.position.longitude = point.shape_pt_lon;
            train.position.timestamp = point.estimated_time_seconds;
            train.position.bearing = bearing;

            if (train.currentBlock && trainInBlock(trackBlocks, train, train.currentBlock)) {
                continue; // Skip if still in the same block
            } else {
                findAndSetTrainBlock(trackBlocks, train, cityID);
            }

            if (train.currentBlock !== lastBlockNumber) {
                if (train.currentBlock === undefined) {
                    if (lastBlockNumber === 0) {
                        continue; // Skip as we haven't entered a new block yet
                    } else {
                        train.currentBlock = 0; // Use 0 to signify "not in a block"
                    }
                }
                blocks.push({
                    blockNumber: train.currentBlock,
                    offsetSeconds: point.estimated_time_seconds - startTime
                });
                lastBlockNumber = train.currentBlock;
            }
        }

        // Append a distinct exit block to signify the train completing the route
        if (points.length > 0 && lastBlockNumber !== 0) {
            const lastPoint = points[points.length - 1]!;
            blocks.push({
                blockNumber: 0,
                offsetSeconds: lastPoint.estimated_time_seconds - startTime + END_EXTRA_DWELL_SECONDS
            });
        }

        // Pull the first block back by START_EXTRA_DWELL_SECONDS to ensure the train appears on the display before it starts moving
        if (blocks.length > 0) {
            blocks[0]!.offsetSeconds = Math.max(0, blocks[0]!.offsetSeconds - START_EXTRA_DWELL_SECONDS);
        }

        return {
            id: trip.trip_id,
            color: color,
            startTimes: [startTime],
            blocks: blocks
        };

    }

    // /**
    //  * Removes "appendages" from a shape where the polyline doubles back on itself.
    //  * Detects when a later point is at an earlier point,
    //  * meaning the shape went on a spur and came back. Removes the spur points.
    //  */
    public removeShapeAppendages(points: Shapes[]): Shapes[] {

        // Remove simple appendages that go from A to B and back to A (using exact matches)
        const result: Shapes[] = [];
        const seenPoints = new Map<string, number>();

        let resultIndex = 0;
        for (let i = 0; i < points.length; i++) {
            let pt = { ...points[i]! }; // Clone the point so we can update it safely
            const key = `${pt.shape_pt_lat},${pt.shape_pt_lon}`;

            if (seenPoints.has(key)) {
                // Found a loop! Revert our index back to where this point was first seen
                resultIndex = seenPoints.get(key)!;

                // Clean up the map for all points we just effectively "deleted"
                for (let j = resultIndex + 1; j < result.length; j++) {
                    const deletedPt = result[j]!;
                    const deletedKey = `${deletedPt.shape_pt_lat},${deletedPt.shape_pt_lon}`;
                    seenPoints.delete(deletedKey);
                }

                // Re-slice the array to drop the appendage
                result.length = resultIndex + 1;

                // Advance resultIndex so the next point is added after the loop
                resultIndex++;
            } else {
                // If we've removed points previously, we need to correct the distance traveled
                // based on the actual physical distance from the previous point in our new simplified shape
                if (resultIndex > 0) {
                    const prev = result[resultIndex - 1]!;

                    // Inherit the base sequence number incremented by our correct positional index
                    pt.shape_pt_sequence = result[0]!.shape_pt_sequence + resultIndex;

                    if (pt.shape_dist_traveled !== undefined && prev.shape_dist_traveled !== undefined) {
                        const distMeters = calculateDistance(prev.shape_pt_lat, prev.shape_pt_lon, pt.shape_pt_lat, pt.shape_pt_lon);

                        pt.shape_dist_traveled = prev.shape_dist_traveled + distMeters;
                    }
                } else if (resultIndex === 0) {
                    // Ensure the first point retains its base distance if possible
                    pt.shape_pt_sequence = points[0]!.shape_pt_sequence;
                }

                // Not a loop. Keep the point and record its position in our result array
                result.push(pt);
                seenPoints.set(key, resultIndex);
                resultIndex++;
            }
        }

        return result;
    }

    public reduceShapes(shapes: Map<string, GTFSShapeRecord>): Map<string, GTFSShapeRecord> {
        const reducedShapes = new Map<string, GTFSShapeRecord>();

        const MIN_DISTANCE_BETWEEN_POINTS = 100; // Minimum distance in meters between points to keep them

        for (const [shapeId, shape] of shapes.entries()) {
            const reducedPoints: Shapes[] = [];
            let lastPt: Shapes | null = null;
            for (const pt of shape.points) {
                if (lastPt) {
                    const dist = calculateDistance(lastPt.shape_pt_lat, lastPt.shape_pt_lon, pt.shape_pt_lat, pt.shape_pt_lon);
                    if (dist >= MIN_DISTANCE_BETWEEN_POINTS) {
                        reducedPoints.push(pt);
                        lastPt = pt;
                    } else {
                        // If points are too close, we skip this point but keep the lastPt as reference for the next one
                        continue;
                    }
                } else {
                    reducedPoints.push(pt);
                    lastPt = pt;
                }
            }

            reducedShapes.set(shapeId, {
                shape_id: shapeId,
                points: reducedPoints
            });
        }
        return reducedShapes;
    }
}


function generateIssueShapesMap(
    shapesWithIssues: string[],
    allShapes: Map<string, GTFSShapeRecord>,
    fixedShapes: Map<string, GTFSShapeRecord>,
    outputDir: string
): void {
    if (shapesWithIssues.length === 0) return;

    const shapeLayers: string[] = [];
    const overlays: string[] = [];

    for (let idx = 0; idx < shapesWithIssues.length; idx++) {
        const shapeId = shapesWithIssues[idx];
        const shape = allShapes.get(shapeId);
        if (!shape) continue;

        const fixed = fixedShapes.get(shapeId);
        const origVar = `orig_${idx}`;
        const fixedVar = `fixed_${idx}`;
        const hue = Math.round((idx / shapesWithIssues.length) * 300);

        // Original shape layer
        shapeLayers.push(`
        var ${origVar} = L.layerGroup();
        (function() {
            var pts = ${JSON.stringify(shape.points.map(p => ({
            lat: p.shape_pt_lat,
            lon: p.shape_pt_lon,
            seq: p.shape_pt_sequence,
            dist: p.shape_dist_traveled
        })))};
            var latlngs = [];
            for (var i = 0; i < pts.length; i++) {
                var p = pts[i];
                var ll = [p.lat, p.lon];
                latlngs.push(ll);
                var icon = L.divIcon({
                    className: 'point-label',
                    html: '<span style="border-color:hsl(${hue},100%,40%)">' + p.seq + '</span>'
                });
                L.marker(ll, {icon: icon}).bindPopup('Seq: ' + p.seq + '<br>Dist: ' + (p.dist || 0).toFixed(1) + 'm').addTo(${origVar});
                if (i > 0) {
                    var prev = pts[i-1];
                    var frac = i / pts.length;
                    var segHue = Math.round(frac * 240);
                    L.polyline([[prev.lat, prev.lon], ll], {
                        color: 'hsl(' + segHue + ',100%,50%)',
                        weight: 4
                    }).addTo(${origVar});
                }
            }
        })();`);

        overlays.push(`"${shapeId} (original ${shape.points.length}pts)": ${origVar}`);

        // Fixed shape layer
        if (fixed) {
            shapeLayers.push(`
        var ${fixedVar} = L.layerGroup();
        (function() {
            var pts = ${JSON.stringify(fixed.points.map(p => ({
                lat: p.shape_pt_lat,
                lon: p.shape_pt_lon,
                seq: p.shape_pt_sequence,
                dist: p.shape_dist_traveled
            })))};
            var latlngs = [];
            for (var i = 0; i < pts.length; i++) {
                var p = pts[i];
                var ll = [p.lat, p.lon];
                latlngs.push(ll);
                var icon = L.divIcon({
                    className: 'point-label fixed',
                    html: '<span style="border-color:green">' + p.seq + '</span>'
                });
                L.marker(ll, {icon: icon}).bindPopup('Seq: ' + p.seq + '<br>Dist: ' + (p.dist || 0).toFixed(1) + 'm').addTo(${fixedVar});
                if (i > 0) {
                    var prev = pts[i-1];
                    L.polyline([[prev.lat, prev.lon], ll], {
                        color: 'limegreen',
                        weight: 5
                    }).addTo(${fixedVar});
                }
            }
        })();`);

            overlays.push(`"${shapeId} (fixed ${fixed.points.length}pts)": ${fixedVar}`);
        }
    }

    const html = `<!DOCTYPE html>
<html>
<head>
    <title>Shapes with Issues (${shapesWithIssues.length})</title>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <style>
        body { margin: 0; padding: 0; }
        #map { width: 100vw; height: 100vh; }
        .point-label span {
            display: inline-block;
            background: white;
            border: 2px solid #333;
            border-radius: 50%;
            padding: 1px 4px;
            font-size: 9px;
            text-align: center;
            font-weight: bold;
            white-space: nowrap;
        }
        .leaflet-control-layers {
            max-width: 400px !important;
            min-width: 320px !important;
        }
        .leaflet-control-layers-overlays label {
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div id="map"></div>
    <script>
        var map = L.map('map').setView([-37.81, 144.96], 11);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
        ${shapeLayers.join('\n')}
        var overlays = { ${overlays.join(', ')} };
        L.control.layers(null, overlays, { collapsed: false }).addTo(map);
    </script>
</body>
</html>`;

    const viewPath = path.resolve(outputDir, 'issue_shapes_map.html');
    fs.writeFileSync(viewPath, html, 'utf8');
    console.log(`Generated issue shapes map with ${shapesWithIssues.length} shapes: ${viewPath}`);
}

export function generateTripTimeMap(
    trip: GTFSTripRecord,
    shape: GTFSShapeRecord,
    estimatedPoints: EstimatedShapePoint[],
    outputDir: string
): void {
    if (estimatedPoints.length === 0) return;

    const estimator = new TripSimulator();
    const points = [...estimatedPoints].sort((a, b) => a.estimated_time_seconds - b.estimated_time_seconds);
    const minTime = points[0]!.estimated_time_seconds;
    const maxTime = points[points.length - 1]!.estimated_time_seconds;

    const html = `<!DOCTYPE html>
<html>
<head>
    <title>Trip Time Map - ${trip.trip_id}</title>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <style>
        body { margin: 0; padding: 0; font-family: Arial, sans-serif; }
        #map { width: 100vw; height: 100vh; }
        .controls {
            position: absolute;
            left: 12px;
            right: 12px;
            bottom: 12px;
            z-index: 1000;
            background: rgba(255, 255, 255, 0.96);
            border: 1px solid rgba(0, 0, 0, 0.18);
            border-radius: 10px;
            padding: 10px 12px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
        }
        .controls-row {
            display: flex;
            align-items: center;
            gap: 12px;
            flex-wrap: wrap;
        }
        #timeSlider { flex: 1 1 320px; }
        #timeLabel {
            min-width: 120px;
            font-weight: bold;
            font-size: 14px;
        }
        #metaLabel {
            font-size: 12px;
            color: #444;
        }
    </style>
</head>
<body>
    <div id="map"></div>
    <div class="controls">
        <div class="controls-row">
            <input id="timeSlider" type="range" min="${minTime}" max="${maxTime}" value="${minTime}" step="1" />
            <div id="timeLabel">${estimator.secondsToTime(minTime)}</div>
        </div>
        <div class="controls-row" style="margin-top: 6px; justify-content: space-between;">
            <div id="metaLabel">Trip ${trip.trip_id} | Shape ${shape.shape_id}</div>
            <div id="metaLabel">Blue = traveled, gray = remaining, red = current position</div>
        </div>
    </div>
    <script>
        const map = L.map('map');
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

        const points = ${JSON.stringify(points.map(point => ({
        lat: point.shape_pt_lat,
        lon: point.shape_pt_lon,
        seq: point.shape_pt_sequence,
        dist: point.shape_dist_traveled,
        time: point.estimated_time_seconds,
        label: point.estimated_time
    })))};
        const shapePath = ${JSON.stringify(shape.points.map(point => [point.shape_pt_lat, point.shape_pt_lon]))};

        const shapeLine = L.polyline(shapePath, { color: '#a1a1a1', weight: 4, opacity: 0.5 }).addTo(map);
        const traveledLine = L.polyline([], { color: '#2563eb', weight: 5, opacity: 0.95 }).addTo(map);
        const remainingLine = L.polyline([], { color: '#c7c7c7', weight: 3, opacity: 0.7, dashArray: '6 8' }).addTo(map);
        const currentMarker = L.circleMarker([points[0].lat, points[0].lon], {
            radius: 8,
            color: '#991b1b',
            weight: 3,
            fillColor: '#ef4444',
            fillOpacity: 1
        }).addTo(map);

        for (const point of points) {
            L.circleMarker([point.lat, point.lon], {
                radius: 4,
                color: '#1f2937',
                weight: 1,
                fillColor: '#ffffff',
                fillOpacity: 1
            }).bindPopup('Seq: ' + point.seq + '<br>Dist: ' + (point.dist || 0).toFixed(1) + 'm<br>Time: ' + point.label).addTo(map);
        }

        function formatTime(seconds) {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = Math.floor(seconds % 60);
            return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
        }

        function interpolatePosition(timeSeconds) {
            if (timeSeconds <= points[0].time) {
                return { lat: points[0].lat, lon: points[0].lon };
            }

            if (timeSeconds >= points[points.length - 1].time) {
                const last = points[points.length - 1];
                return { lat: last.lat, lon: last.lon };
            }

            for (let index = 0; index < points.length - 1; index++) {
                const current = points[index];
                const next = points[index + 1];
                if (timeSeconds >= current.time && timeSeconds <= next.time) {
                    const span = Math.max(1, next.time - current.time);
                    const fraction = (timeSeconds - current.time) / span;
                    return {
                        lat: current.lat + ((next.lat - current.lat) * fraction),
                        lon: current.lon + ((next.lon - current.lon) * fraction)
                    };
                }
            }

            const last = points[points.length - 1];
            return { lat: last.lat, lon: last.lon };
        }

        function updateMap(timeSeconds) {
            let activeIndex = 0;
            for (let index = 0; index < points.length; index++) {
                if (points[index].time <= timeSeconds) {
                    activeIndex = index;
                } else {
                    break;
                }
            }

            const current = interpolatePosition(timeSeconds);
            traveledLine.setLatLngs(points.slice(0, activeIndex + 1).map(point => [point.lat, point.lon]));
            remainingLine.setLatLngs(points.slice(activeIndex).map(point => [point.lat, point.lon]));
            currentMarker.setLatLng([current.lat, current.lon]);
            document.getElementById('timeLabel').textContent = formatTime(timeSeconds);
        }

        const slider = document.getElementById('timeSlider');
        slider.addEventListener('input', event => updateMap(parseInt(event.target.value, 10)));

        updateMap(parseInt(slider.value, 10));
        map.fitBounds(shapeLine.getBounds(), { padding: [30, 30] });
    </script>
</body>
</html>`;

    const viewPath = path.resolve(outputDir, `trip_time_map_${trip.trip_id}.html`);
    fs.writeFileSync(viewPath, html, 'utf8');
    console.log(`Generated trip time map for ${trip.trip_id}: ${viewPath}`);
}
