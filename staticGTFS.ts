import fs from 'fs';
import path from 'path';
import { log } from './customUtils';
import AdmZip from 'adm-zip';
import { RailNetwork } from './railNetwork';
import { TripSimulator, staticGTFSQuery, BlockSequence, generateTripTimeMap } from './gtfsTimetable';
import { calculateDistance } from './trainPairs';
import { HeaderGenerator } from './headerGenerator';

/**
 * A highly optimized synchronous CSV parser designed for loading entire GTFS files into memory.
 * Uses native string splitting for massive speed gains over comprehensive stream parsers.
 * 
 * @param filePath The path to the CSV file to parse
 * @returns An array of parsed objects
 */
export function parseGTFSFileSync<T = Record<string, string>>(filePath: string): T[] {
    if (!fs.existsSync(filePath)) {
        throw new Error(`GTFS file not found: ${filePath}`);
    }

    const allText = fs.readFileSync(filePath, 'utf8');
    const lines = allText.split(/\r?\n/);
    if (lines.length === 0 || !lines[0]) return [];

    // Parse headers, strip BOM and quotes
    const headers = lines[0].replace(/^"|"$/g, '').replace(/^\uFEFF/, '').split(',');
    const results: T[] = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.trim() === '') continue;

        const values = line.split(',');
        const record: Record<string, string> = {};

        for (let j = 0; j < headers.length; j++) {
            const header = headers[j];
            if (header !== undefined) {
                record[header] = values[j]?.replace(/^"|"$/g, '') || '';
            }
        }

        results.push(record as unknown as T);
    }

    return results;
}

/**
 * A highly optimized synchronous parser specifically for mapping stop_times to a predefined set of trips.
 * Uses early-break optimizations and substring matching for maximum performance.
 * 
 * @param filePath The path to the stop_times.txt file
 * @param tripMap A Map of trip_id to an object containing a stop_times array
 */
export function parseStopTimesForTripsSync<T>(
    filePath: string,
    tripMap: Map<string, { stop_times?: T[] }>
): void {
    // console.time(`RAM String ingestion`);
    const allText = fs.readFileSync(filePath, 'utf8');
    const lines = allText.split(/\r?\n/);
    if (lines.length === 0 || !lines[0]) return;
    const headers = lines[0].replace(/^"|"$/g, '').replace(/^\uFEFF/, '').split(',');
    // console.timeEnd(`RAM String ingestion`);

    let activeTripsLeft = tripMap.size;

    // console.time(`String matching parsed lines`);
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const firstComma = line.indexOf(',');
        if (firstComma === -1) continue;

        // Extract just the trip_id using substring (very fast!)
        let tripId = line.substring(0, firstComma);
        if (tripId.startsWith('"')) tripId = tripId.slice(1, -1);

        const trip = tripMap.get(tripId);
        if (trip) {
            if (trip.stop_times!.length === 0) activeTripsLeft--;

            // Extremely cheap array mapping compared to full csv-parse!
            const values = line.split(',');
            const record: Record<string, string> = {};
            for (let j = 0; j < headers.length; j++) {
                const header = headers[j];
                if (header !== undefined) {
                    const value = values[j]?.replace(/^"|"$/g, '');
                    if (value !== undefined) {
                        record[header] = value;
                    }
                }
            }
            trip.stop_times!.push(record as unknown as T);
        } else if (!tripMap.has(tripId) && activeTripsLeft === 0) {
            break; // We've moved past all our needed sequentially grouped trips!
        }
    }
    // console.timeEnd(`String matching parsed lines`);
}

/**
 * Extracts a zip archive to a destination path.
 * 
 * @param zipPath Path to the zip file
 * @param unzipPath Directory where contents will be extracted
 * @param clearDestination Whether to delete the destination folder before unzipping
 * @param deleteZip Whether to delete the original zip file after successful extraction
 */
export function unzipArchive(zipPath: string, unzipPath: string, clearDestination: boolean = true, deleteZip: boolean = true): void {
    if (clearDestination) {
        if (fs.existsSync(unzipPath)) {
            // Delete existing unzipped files if they exist
            fs.rmSync(unzipPath, { recursive: true, force: true });
        }
    }

    // Ensure the unzip directory exists
    if (!fs.existsSync(unzipPath)) {
        fs.mkdirSync(unzipPath, { recursive: true });
    }

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(unzipPath, true); // Overwrite existing files if they exist

    if (deleteZip && fs.existsSync(zipPath)) {
        // Delete the zip file after unzipping to save space
        fs.unlinkSync(zipPath);
    }
}

/**
 * Recursively calculates the total size of a folder in bytes.
 */
export function getFolderSize(folderPath: string): number {
    let totalSize = 0;

    if (!fs.existsSync(folderPath)) {
        return 0;
    }

    const items = fs.readdirSync(folderPath);

    for (const item of items) {
        const itemPath = path.join(folderPath, item);
        const stats = fs.statSync(itemPath);

        if (stats.isDirectory()) {
            totalSize += getFolderSize(itemPath); // Recursively add subfolder size
        } else {
            totalSize += stats.size; // Add file size in bytes
        }
    }

    return totalSize;
}

/**
 * Downloads a static GTFS file and saves it to the given destination path.
 * 
 * @param id The the three letter city id (Used for logging)
 * @param url The URL of the static GTFS zip file to download
 * @param keyHeader (Optional) API key header name
 * @param key (Optional) API key
 * 
 * @returns A promise that resolves to true if the static GTFS data is present and up-to-date, or false if it failed
 */
export async function downloadStaticGTFS(id: string, url: string, fetchIntervalDays: number, keyHeader?: string, key?: string): Promise<boolean> {
    try {
        const zipPath = path.resolve(__dirname, 'cache', id, 'gtfsStatic.zip');
        const unzipPath = path.resolve(__dirname, 'cache', id, 'gtfsStatic');

        // Check if folder already exists and is recent enough based on fetchIntervalDays
        if (fs.existsSync(unzipPath)) {
            const folderStats = fs.statSync(unzipPath);
            const folderLastModifiedMs = Date.now() - folderStats.mtimeMs;
            const maxAgeMs = fetchIntervalDays * 24 * 60 * 60 * 1000;

            if (folderLastModifiedMs < maxAgeMs) {
                // log(id, `Static GTFS data is ${(fileAgeMs / (1000 * 60 * 60)).toFixed(0)} hours old (skipping download).`);
                return true; // File is recent enough, skip download
            }
        }

        const headers = new Headers();
        if (keyHeader && key) {
            headers.append(keyHeader, key);
        }

        const response = await fetch(url, { headers });

        if (!response.ok) {
            throw new Error(`Failed to download static GTFS: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Ensure the directory exists
        const dir = path.dirname(zipPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Delete existing file if it exists
        if (fs.existsSync(zipPath)) {
            fs.unlinkSync(zipPath);
        }

        fs.writeFileSync(zipPath, buffer);

        // Unzip the main downloaded GTFS file
        unzipArchive(zipPath, unzipPath, true, true);

        // Iterate through each extracted folder and unzip 'google_transit.zip' if present
        const extractedItems = fs.readdirSync(unzipPath);
        for (const item of extractedItems) {
            const innerFolderPath = path.join(unzipPath, item);
            if (fs.statSync(innerFolderPath).isDirectory()) {
                const innerZipPath = path.join(innerFolderPath, 'google_transit.zip');
                if (fs.existsSync(innerZipPath)) {
                    log(id, `Unzipping nested archive: ${item}/google_transit.zip...`);
                    // Extract in-place, do not clear the destination folder, delete the inner zip afterwards
                    unzipArchive(innerZipPath, innerFolderPath, false, true);
                }
            }
        }

        const gtfsSizeMB = (getFolderSize(unzipPath) / (1024 * 1024)).toFixed(0);
        log(id, `Successfully downloaded and unzipped GTFS static data (${gtfsSizeMB} MiB)`);
        return true;
    } catch (error) {
        log(id, `Error downloading or unzipping static GTFS data: ${(error as Error).message}`);
        return false;
    }
}

export async function generateTimetable(network: RailNetwork): Promise<void> {
    // Hardcoded for now, can be parameterized later
    const dayOfWeek = 'thursday';
    const gtfsFolders = ['1', '2'];

    console.time(`Generated Timetable for ${network.id} using folders ${gtfsFolders.join(', ')} on ${dayOfWeek}`);
    const gtfsStaticPath = path.resolve(__dirname, 'cache', network.id, 'gtfsStatic');

    const blockSequences: BlockSequence[] = [];


    for (const gtfsFolder of gtfsFolders) {
        const gtfsFolderPath = path.resolve(gtfsStaticPath, gtfsFolder);
        const gtfsQuery = new staticGTFSQuery(gtfsFolderPath);

        const selectedDate = gtfsQuery.getNextDateForDayOfWeek(dayOfWeek);

        try {
            const trips = gtfsQuery.getTripsByDate(selectedDate);
            const allStops = gtfsQuery.getAllStops();

            // Trim down trips to the first 1450
            // trips = trips.slice(0, 10);

            if (trips.length > 0) {
                // Get stop times for ALL of our trips concurrently in one fast parse
                gtfsQuery.getStopTimesForMultipleTrips(trips);

                let allShapes = gtfsQuery.getAllShapes();

                const simulator = new TripSimulator();

                // remove appendages from shapes
                for (const shape of allShapes.values()) {
                    shape.points = simulator.removeShapeAppendages(shape.points);
                }

                allShapes = simulator.reduceShapes(allShapes);

                for (const trip of trips) {
                    const route = trip?.route_id;
                    const tripColor = network.config.LEDRailsAPI.colors?.[route];
                    const shape = allShapes.get(trip.shape_id);                   


                    if (shape && network.trackBlocks && tripColor) {

                        const pointTimings = simulator.derivePointTimings(trip, shape, allStops);

                        // let speed = 0;
                        // // Check if at any point this trip goes unrealistically fast between shape points and log a warning if so (which may indicate an issue with the shape or stop mapping)
                        // for (let i = 1; i < pointTimings.length; i++) {
                        //     const prevPoint = pointTimings[i - 1];
                        //     const currPoint = pointTimings[i];
                        //     if (!prevPoint || !currPoint) continue;
                        //     const distance = calculateDistance(prevPoint?.shape_pt_lat, prevPoint?.shape_pt_lon, currPoint?.shape_pt_lat, currPoint?.shape_pt_lon); // Assuming haversineDistance is a function that calculates distance in meters
                        //     const time = currPoint.estimated_time_seconds - prevPoint.estimated_time_seconds;
                        //     const newSpeed = distance / 1000 / (time / 3600); // Convert meters to kilometers and calculate speed in km/h
                        //     if (time > 2 && distance > 100) {
                        //         speed = (speed * 0.9) + (newSpeed * 0.1); // Smooth speed calculation to avoid false positives from single bad points
                        //     }

                        //     if (speed > 180) {
                        //         console.warn(`⚠️  Trip ${trip.trip_id} exceeds 180km/h between points ${i - 1} and ${i} (${speed.toFixed(0)} km/h, Distance: ${distance.toFixed(0)} m, Time: ${time.toFixed(0)} s).`);
                        //     }
                        // }

                        // if (trip.trip_id == "01-BDE--9-T0-8460"){
                        //     console.log(trip);
                        //     console.log(shape);
                        //     generateTripTimeMap(trip, shape, pointTimings, gtfsFolderPath);
                        // }

                        const newBlockSequence = simulator.mapPointsToBlocks(trip, pointTimings, network.trackBlocks, network.id, tripColor);

                        // Skip if the newBlockSequence has no blocks
                        if (newBlockSequence.blocks.length === 0) {
                            // console.warn(`⚠️  Trip ${trip.trip_id} has no blocks mapped and will be skipped. ${newBlockSequence.blocks}`);
                            // simulator.shapesWithIssues.push(trip.shape_id);
                            continue;
                        }

                        // Check if an equivalent block map already exists (ignoring start times) and if so, merge the start times together instead of creating a duplicate entry
                        let foundMatch = false;
                        for (const existingMap of blockSequences) {
                            if (existingMap.blocks.length === newBlockSequence.blocks.length &&
                                existingMap.color.join(',') === newBlockSequence.color.join(',')) {

                                let blocksMatch = true;
                                for (let j = 0; j < existingMap.blocks.length; j++) {
                                    if (existingMap.blocks[j].blockNumber !== newBlockSequence.blocks[j].blockNumber ||
                                        existingMap.blocks[j].offsetSeconds !== newBlockSequence.blocks[j].offsetSeconds) {
                                        blocksMatch = false;
                                        break;
                                    }
                                }

                                if (blocksMatch) {
                                    existingMap.startTimes.push(...newBlockSequence.startTimes);
                                    existingMap.startTimes.sort((a, b) => a - b); // Keep times chronological
                                    foundMatch = true;
                                    break;
                                }
                            }
                        }

                        if (!foundMatch) {
                            blockSequences.push(newBlockSequence);

                            // let index = 0;
                            // for (const mapping of newBlockSequence.blocks) {
                            //     const nextOffset = newBlockSequence.blocks[index + 1]?.offsetSeconds;
                            //     const timeInBlock = nextOffset === undefined ? 0 : nextOffset - mapping.offsetSeconds;
                            //     if (timeInBlock < 4 && mapping.blockNumber !== -1) { // Warn if the train is estimated to be in this block for less than 4 seconds (excluding the exit block)
                            //         if (!simulator.shapesWithIssues.includes(trip.shape_id)) {
                            //             simulator.shapesWithIssues.push(trip.shape_id);
                            //             console.log(`⚠️  Shape ${trip.shape_id} from ${trip.trip_id} has a block (${mapping.blockNumber}) with very short estimated time (${timeInBlock}s).`);
                            //         }
                            //     }
                            //     index++;
                            // }

                            // // Check if the newTripMap has blocks numbers repeated more than once and log a warning
                            // const blockCountMap: Record<number, number> = {};
                            // for (const mapping of newBlockSequence.blocks) {
                            //     if (mapping.blockNumber !== -1) {
                            //         blockCountMap[mapping.blockNumber] = (blockCountMap[mapping.blockNumber] || 0) + 1;
                            //     }
                            // }
                            // for (const [blockNumber, count] of Object.entries(blockCountMap)) {
                            //     if (count > 1) {
                            //         if (!simulator.shapesWithIssues.includes(trip.shape_id)) {
                            //             simulator.shapesWithIssues.push(trip.shape_id);
                            //             console.log(`⚠️  Shape ${trip.shape_id} from ${trip.trip_id} has block ${blockNumber} repeated ${count} times`);
                            //         }
                            //     }
                            // }
                        }
                    }
                }

                // Generate a map of all shapes with issues for visual debugging
                // generateIssueShapesMap(estimator.shapesWithIssues, originalShapes, allShapes, gtfsFolderPath);

            } else {
                console.log("No trips found for this date. Bypassing extraction logic.");
            }
        } catch (err) {
            console.error(`Failed to parse GTFS calendar/trips for ${network.id}:`, err);
            throw err;
        }
    }

    // Save blockSequences to a JSON file for debugging
    // const outputPath = path.resolve(gtfsStaticPath, 'blockSequences.json');
    // fs.writeFileSync(outputPath, JSON.stringify({ blockSequences: blockSequences }, null, 2), 'utf8');

    const generator = new HeaderGenerator(path.join(gtfsStaticPath, `${network.id}_V1_0_0_Timetable.h`));
    generator.generate(blockSequences);

    // Log time taken and bun memory usage after generating the timetable
    console.timeEnd(`Generated Timetable for ${network.id} using folders ${gtfsFolders.join(', ')} on ${dayOfWeek}`);
    console.log(`Total Memory allocated: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB`);

    return;
}


