import express from 'express';
import http from 'http';
import fs from 'fs';
import { DOMParser } from '@xmldom/xmldom';

import type { GTFSRealtime, Entity } from 'gtfs-types';

interface TrackBlock {
    id: string;
    polygon: Array<[number, number]>; // [lat, lng] tuples
}

interface LedMap {
    version: string;
    line_colors: Record<string, string>;
    busses: {
        bus_id: string;
        leds: Record<string, number>;
    }[];
}

// Configuration
const PORT = 4000;
const BLOCK_RANGES = {
    STRAND_MNK: { min: 300, max: 343 },
    NAL_NIMT: { min: 100, max: 207 }
};
const UPDATE_INTERVAL = 10000;

const app = express();
let occupiedBlocks = new Set<string>();
let blockRoutes = new Set<string>();

let ledMap: LedMap = {
    version: "1.0.0",
    line_colors: {
        "1": "#400000",
        "2": "#002000",
        "3": "#101000",
        "4": "#001010",
        "5": "#100010"
    },
    busses: [
        { bus_id: "STRAND_MNK", leds: {} },
        { bus_id: "NAL_NIMT", leds: {} }
    ]
};

// KML Parser
async function loadTrackBlocks(filePath: string): Promise<TrackBlock[]> {
    const kmlContent = await fs.promises.readFile(filePath, 'utf-8');
    console.log('KML content loaded');
    const doc = new DOMParser().parseFromString(kmlContent, 'text/xml');
    // console.log('KML content parsed', doc);
    const blocks: TrackBlock[] = [];


    const placemarks = doc.getElementsByTagName('Placemark');
    console.log(`Found ${placemarks.length} placemarks`);
    for (let i = 0; i < placemarks.length; i++) {
        const placemark = placemarks[i];
        const name = placemark.getElementsByTagName('name')[0]?.textContent || `block-${i}`;
        const coords = placemark.getElementsByTagName('coordinates')[0]?.textContent?.trim();
        // console.log(`Processing placemark: ${name} with coords: ${coords}`);

        if (coords) {
            const points = coords.split(' ')
                .map(coord => {
                    const [lon, lat] = coord.split(',').map(Number);
                    return [lat, lon] as [number, number];
                });

            blocks.push({
                id: name,
                polygon: points
            });
        }
    }

    return blocks;
}

// Point-in-polygon check
function isInPolygon(lat: number, lng: number, polygon: Array<[number, number]>): boolean {
    // console.log(`Checking if point (${lat}, ${lng}) is in polygon ${JSON.stringify(polygon)}`);
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [yi, xi] = polygon[i]; // yi = lat, xi = lng
        const [yj, xj] = polygon[j];

        const intersect = ((yi > lat) !== (yj > lat)) &&
            (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);

        if (intersect) inside = !inside;
    }
    return inside;
}

// HTTP client
async function fetchTrainPositions() {
    return new Promise((resolve, reject) => {
        http.get('http://localhost:3000/api/vehicles/trains', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Failed to parse JSON'));
                    console.error('Error parsing JSON:', e);
                }
            });
        }).on('error', reject);
    });
}

// Update occupied blocks
async function updateOccupiedBlocks(blocks: TrackBlock[]) {
    try {
        const trains = await fetchTrainPositions();
        // console.log('Train positions fetched:', trains);
        occupiedBlocks.clear();

        trains.forEach(train => {
            console.log('Processing train:', train.vehicle.position.latitude, train.vehicle.position.longitude);
            blocks.forEach(block => {
                if (isInPolygon(train.vehicle.position.latitude, train.vehicle.position.longitude, block.polygon)) {
                    // console.log(`Train ${train.id} is in block ${block.id}`);
                    occupiedBlocks.add(block.id);
                    blockRoutes.add(train.vehicle?.trip?.route_id);
                }
            });
        });

        updateLedMap();
        console.log('Occupied blocks updated:', Array.from(occupiedBlocks));
        console.log('Block routes updated:', Array.from(blockRoutes));
    } catch (error) {
        console.error('Error updating blocks:', error);
    }
}

// Generate LED map format
function updateLedMap() {
    ledMap.busses.forEach(bus => {
        bus.leds = {};
        const range = BLOCK_RANGES[bus.bus_id as keyof typeof BLOCK_RANGES];

        occupiedBlocks.forEach(blockId => {
            const blockNum = parseInt(blockId);
            if (blockNum >= range.min && blockNum <= range.max) {
                const ledIndex = blockNum - range.min;
                bus.leds[ledIndex.toString()] = 1; // Using color 1 for occupied
            }
        });
    });
}

// Initialize server
async function initialize() {
    const trackBlocks = await loadTrackBlocks('track-blocks.kml');
    console.log('Track blocks loaded:', trackBlocks);
    await updateOccupiedBlocks(trackBlocks);

    setInterval(() => updateOccupiedBlocks(trackBlocks), UPDATE_INTERVAL);

    app.get('/ledmap100.json', (req, res) => {
        res.json(ledMap);
    });

    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}

initialize();
