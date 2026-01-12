import { readFileSync } from 'fs';

export default function loadStopsMap(stopsFilePath: string): Record<string, { stop_name: string; platform_code: string | undefined }> {
    const stops: Record<string, { stop_name: string; platform_code: string | undefined }> = {};
    const fileContent = readFileSync(stopsFilePath, 'utf-8');
    const lines = fileContent.split('\n');

    if (!lines[0]) {
        return stops; // Return empty object if file is empty
    }

    const header = lines[0].split(',').map(h => h.trim());

    const stopIdIndex = header.indexOf('stop_id');
    const stopNameIndex = header.indexOf('stop_name');
    const platformCodeIndex = header.indexOf('platform_code');

    if (stopIdIndex === -1 || stopNameIndex === -1 || platformCodeIndex === -1) {
        throw new Error('Could not find required columns in stops file');
    }

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;

        const values = line.split(',').map(v => v.trim().replace(/"/g, ''));
        const stopIdValue = values[stopIdIndex];
        const stopName = values[stopNameIndex];
        const platformId = values[platformCodeIndex];

        if (stopIdValue && stopName) {
            stops[stopIdValue] = {
                stop_name: stopName,
                platform_code: platformId ? platformId : undefined,
            };
        }
    }

    return stops;
}
// // Usage example:
// const stops = loadStopsMap('./railNetworks/MEL/stops.txt');
// console.log(stops);

// // Get the stop_name and platform_id for a specific stop_id
// const stopIdToLookup = 11210;
// const stopInfo = stops[stopIdToLookup];
// if (stopInfo) {
//     console.log(`Stop ID: ${stopIdToLookup}, Name: ${stopInfo.stop_name}, Platform: ${stopInfo.platform_code}`);
// }