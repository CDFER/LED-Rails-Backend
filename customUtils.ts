export const LOG_LABELS = {
    SYSTEM: 'SYSTEM',
    SERVER: 'SERVER',
    CACHE: 'CACHE',
    FETCH: 'FETCH',
    ERROR: 'ERROR',
};

// ANSI color codes for log labels
const LABEL_COLORS: Record<string, string> = {
    SYSTEM: '\x1b[36m',   // Cyan
    SERVER: '\x1b[32m',   // Green
    CACHE: '\x1b[31m',   // Red
    FETCH: '\x1b[34m',   // Blue
    ERROR: '\x1b[31m',   // Red
};

// Deterministic color generator for unknown labels e.g. (network IDs)
function getDeterministicColor(label: string): string {
    // Use a hash of the label to pick a color from a palette
    const COLORS = [
        '\x1b[33m', // Yellow
        '\x1b[36m', // Cyan
        '\x1b[32m', // Green
        '\x1b[35m', // Magenta
        '\x1b[34m', // Blue
        '\x1b[31m', // Red
    ];
    // Generate a seed from the label
    let seed = 0;
    for (let i = 0; i < label.length; i++) {
        seed = ((seed << 5) - seed) + label.charCodeAt(i);
        seed |= 0;
    }

    // Seeded random (Mulberry32 one-step)
    let t = (seed + 0x6D2B79F5) | 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const random = ((t ^ (t >>> 14)) >>> 0) / 4294967296;

    const idx = Math.floor(random * COLORS.length);
    return COLORS[idx] || '\x1b[0m';
}

/**
 * Logs a message to the console with timestamp, colored label, and optional extra data
 *
 * @param label - Log label from LOG_LABELS or network.id (e.g., 'SYSTEM', 'AKL', etc.)
 * @param message - Main log message
 * @param extra - Optional object with extra key-value pairs to display
 */
export function log(label: string, message: string, extra?: Record<string, unknown>) {
    const timestamp = `[${getPrecisionTimestamp()}]`;
    const labelStr = `[${label}]`.padEnd(8);
    const extraStr = extra ? Object.entries(extra)
        .map(([k, v]) => `${k}=${v instanceof Date ? v.toISOString() : String(v)}`)
        .join(' | ') : '';

    // Pick color for label
    const color = LABEL_COLORS[label] || getDeterministicColor(label);
    const reset = '\x1b[0m';

    console.log(`${timestamp} ${color}${labelStr}${reset} ${message}${extraStr ? ' | ' + extraStr : ''}`);
}

/**
 * Returns a timestamp string with hour, minute, second, and millisecond precision
 *
 * @returns Timestamp in format HH:MM:SS.mmm
 */
function getPrecisionTimestamp(): string {
    const d = new Date();
    const hours = d.getHours().toString().padStart(2, '0');
    const minutes = d.getMinutes().toString().padStart(2, '0');
    const seconds = d.getSeconds().toString().padStart(2, '0');
    const milliseconds = d.getMilliseconds().toString().padStart(3, '0');
    return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

/**
 * Safely parses a string to an integer.
 *
 * @param value - The string value to parse
 * @param defaultValue - The value to return if parsing fails or input is invalid
 * @returns The parsed integer, or the default value if input is invalid
 */
export function safeParseInt(value: string | undefined, defaultValue: number): number {
    if (value === undefined) return defaultValue;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) || parsed < 0 ? defaultValue : parsed;
}