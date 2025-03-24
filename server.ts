import express from 'express';
import compression from 'compression';
import { config } from 'dotenv';
import rateLimit from 'express-rate-limit';

config(); // Load environment variables from .env file

const app = express();
const port = process.env.PORT || 3000;
const apiKey = process.env.API_KEY;
const apiUrl = 'https://api.at.govt.nz/realtime/legacy';

if (!apiKey) {
    throw new Error('API_KEY environment variable is required');
}

// Rate limit configuration (customize these values in .env if needed)
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'), // 1 minute
    max: parseInt(process.env.RATE_LIMIT_MAX || '20'), // Limit each IP to 20 requests per window
    standardHeaders: true, // Return rate limit info in headers
    legacyHeaders: false,
    message: {
        status: 429,
        error: 'Too many requests - please try again later'
    }
});

// Apply rate limiting to all requests
app.use(limiter);

// Cached data and timestamp
let cachedData: any = null;
let lastFetchTime: Date | null = null;
let isFetching = false;

// Use compression by default
app.use(compression());

// Middleware to set CORS headers
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// Fetch data from API
async function fetchData() {
    if (isFetching) return;
    isFetching = true;

    try {
        const response = await fetch(apiUrl, {
            headers: {
                'Ocp-Apim-Subscription-Key': apiKey as string,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const data = await response.json();
        cachedData = data;
        lastFetchTime = new Date();
        console.log(`Data fetched at ${lastFetchTime.toISOString()}`);
    } catch (error) {
        console.error('Error fetching data:', error);
    } finally {
        isFetching = false;
    }
}

// Initial fetch and periodic updates
fetchData();
setInterval(fetchData, 20 * 1000);

// Endpoints
app.get('/api/data', (req, res) => {
    if (!cachedData) {
        res.status(503).json({
            error: 'Data not yet available',
            lastFetchTime
        });
    }

    res.json(cachedData);
});

app.get('/status', (req, res) => {
    res.json({
        status: 'OK',
        lastFetchTime,
        nextFetchIn: lastFetchTime ? 20 - ((Date.now() - lastFetchTime.getTime()) / 1000) : 'N/A'
    });
});

app.get('/', (req, res) => {
    res.send('GTFS-Realtime-Cache-Server is running');
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
