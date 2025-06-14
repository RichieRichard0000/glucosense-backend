// server.js or index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { InfluxDB } = require('@influxdata/influxdb-client');

const app = express();
const port = process.env.PORT || 3000;

// Middleware - OPTION 3: LOCALHOST FOCUSED CORS CONFIGURATION
app.use(cors({
  origin: [
    'http://localhost:3000',    // Create React App default
    'http://localhost:5173',    // Your Vite dev server
    'http://127.0.0.1:5173',    // Alternative localhost format
    'https://*.vercel.app',     // All Vercel deployments (wildcard)
    process.env.FRONTEND_URL
  ],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.static('public'));

// InfluxDB Configuration
const influxConfig = {
  url: process.env.INFLUX_URL,
  token: process.env.INFLUX_TOKEN,
  org: process.env.INFLUX_ORG,
  bucket: process.env.INFLUX_BUCKET
};

// Validate required environment variables
const requiredEnvVars = ['INFLUX_URL', 'INFLUX_TOKEN', 'INFLUX_ORG', 'INFLUX_BUCKET'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingVars);
  process.exit(1);
}

// Initialize InfluxDB client
let queryApi;
try {
  const influxDB = new InfluxDB({
    url: influxConfig.url,
    token: influxConfig.token,
  });
  queryApi = influxDB.getQueryApi(influxConfig.org);
  console.log('✅ InfluxDB client initialized successfully');
} catch (error) {
  console.error('❌ Failed to initialize InfluxDB client:', error.message);
  process.exit(1);
}

// Sensor configuration
const SENSOR_FIELDS = [
  "TGS2602", "H", "MQ138", "MQ2", "T",
  "TGS2600", "TGS2603", "TGS2610",
  "TGS2620", "TGS2611", "TGS822"
];

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    sensors: SENSOR_FIELDS.length,
    influxdb: 'connected'
  });
});

// Main sensor data endpoint
app.get('/sensor-data', async (req, res) => {
  console.log("📡 Hit /sensor-data endpoint");
  
  const timeRange = req.query.range || '5m'; // Default to 5 minutes
  
  const fluxQuery = `
    from(bucket: "${influxConfig.bucket}")
      |> range(start: -${timeRange})
      |> filter(fn: (r) => r._measurement == "wifi_status")
      |> filter(fn: (r) => ${SENSOR_FIELDS.map(f => `r._field == "${f}"`).join(" or ")})
      |> keep(columns: ["_time", "_field", "_value"])
      |> sort(columns: ["_time"], desc: false)
  `;

  try {
    console.log('🔍 Executing InfluxDB query...');
    const rows = await queryApi.collectRows(fluxQuery);
    
    if (rows.length === 0) {
      console.log('⚠️ No data found for the specified time range');
      return res.json({ 
        data: [], 
        message: 'No sensor data available for the specified time range',
        timeRange: timeRange
      });
    }

    // Group data by timestamp
    const grouped = {};
    rows.forEach(row => {
      const time = row._time;
      if (!grouped[time]) {
        grouped[time] = { time };
      }
      grouped[time][row._field] = row._value;
    });

    const finalData = Object.values(grouped);
    
    console.log(`✅ Successfully fetched and grouped ${finalData.length} records`);
    
    res.json({
      data: finalData,
      count: finalData.length,
      timeRange: timeRange,
      sensors: SENSOR_FIELDS,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error("❌ InfluxDB query error:", error);
    
    res.status(500).json({ 
      error: "Failed to fetch sensor data", 
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get latest 2 minutes data (specific endpoint for ML model)
app.get('/sensor-data/latest', async (req, res) => {
  console.log("📡 Hit /sensor-data/latest endpoint");
  
  const fluxQuery = `
    from(bucket: "${influxConfig.bucket}")
      |> range(start: -2m)
      |> filter(fn: (r) => r._measurement == "wifi_status")
      |> filter(fn: (r) => ${SENSOR_FIELDS.map(f => `r._field == "${f}"`).join(" or ")})
      |> keep(columns: ["_time", "_field", "_value"])
      |> sort(columns: ["_time"], desc: false)
  `;

  try {
    const rows = await queryApi.collectRows(fluxQuery);
    
    const grouped = {};
    rows.forEach(row => {
      const time = row._time;
      if (!grouped[time]) {
        grouped[time] = { time };
      }
      grouped[time][row._field] = row._value;
    });

    const finalData = Object.values(grouped);
    
    console.log(`✅ Latest 2min data: ${finalData.length} records`);
    
    res.json({
      data: finalData,
      count: finalData.length,
      timeRange: '2m',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error("❌ Error fetching latest data:", error);
    res.status(500).json({ 
      error: "Failed to fetch latest sensor data", 
      details: error.message 
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('💥 Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    availableEndpoints: ['/health', '/sensor-data', '/sensor-data/latest']
  });
});

// Start server
app.listen(port, () => {
  console.log(`🚀 Sensor API server running on port ${port}`);
  console.log(`📊 Monitoring ${SENSOR_FIELDS.length} sensors`);
  console.log(`🔗 Health check: http://localhost:${port}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('👋 Received SIGINT, shutting down gracefully');
  process.exit(0);
});
