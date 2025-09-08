import { LOG_LABELS, log } from './customUtils';
import * as fs from 'fs';
import path from 'path';

const BUN_GZIP_OPTIONS = {
    level: 9, // Compression level (0-9, 9 for max compression)
    memLevel: 9, // Maximum memory usage for compression (9 is max memory)
    strategy: 2, // Z_RLE: Limit match distances to one (run-length encoding)
    windowBits: 31, // 25..31 (16+9..15): The output will have a gzip header and footer (gzip)
};

const CACHE_CONFIG = {
    folder: path.join(__dirname, 'cache'),
};

/**
 * Creates a folder if it does not exist
 * @param folderPath Absolute path to the folder
 */
function createFolderIfNotExists(folderPath: string) {
    try {
        fs.accessSync(folderPath, fs.constants.F_OK);
    } catch {
        fs.mkdirSync(folderPath, { recursive: true });
    }
}

/**
 * Saves data to the cache as a compressed gzipped JSON file
 * @param networkID Network identifier (e.g., 'AKL', 'WLG')
 * @param name Name of the cache file (without extension)
 * @param inputData Data to be cached (will be JSON stringified)
 */
export async function saveToCache<T>(networkID: string, name: string, inputData: T) {
    try {
        const jsonPayload = JSON.stringify(inputData);
        const compressedData = Bun.gzipSync(Buffer.from(jsonPayload), BUN_GZIP_OPTIONS);
        createFolderIfNotExists(path.join(CACHE_CONFIG.folder, networkID));
        const filePath = path.join(CACHE_CONFIG.folder, networkID, `${name}.json.gz`);
        fs.writeFileSync(filePath, compressedData);
    } catch (error) {
        log(LOG_LABELS.CACHE, `Failed to save cache ${networkID}/${name}.json.gz`, { error: error });
    }
}

/**
 * Reads and decompresses cached data from a gzipped JSON file
 * @param networkID Network identifier (e.g., 'AKL', 'WLG')
 * @param name Name of the cache file (without extension)
 * @returns Parsed data from cache, or undefined if not found or error
 */
export function readFromCache<T>(networkID: string, name: string): T | undefined {
    try {
        const filePath = path.join(CACHE_CONFIG.folder, networkID, `${name}.json.gz`);
        const decompressed = Bun.gunzipSync(fs.readFileSync(filePath));
        return JSON.parse(Buffer.from(decompressed).toString('utf8')) as T;
    } catch {
        log(LOG_LABELS.CACHE, `Cache file not found ${networkID}/${name}.json.gz`);
        return undefined;
    }
}