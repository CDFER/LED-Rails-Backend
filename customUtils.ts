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
    // Improved hash: sum char codes and multiply by length for more spread
    let hash = 0;
    for (let i = 0; i < label.length; i++) {
        hash += label.charCodeAt(i) * (i + 1);
    }
    hash *= label.length;
    const idx = Math.abs(hash) % COLORS.length;
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