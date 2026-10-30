const express = require('express');
const dns = require('node:dns/promises');
const net = require('node:net');
const mysql = require('mysql2/promise');
const { startOpenAqImporter } = require('./openAqImporter');

const app = express();
const port = Number(process.env.PORT) || 3000;

const databaseConfigured = Boolean(
  process.env.DB_HOST &&
    process.env.DB_USER &&
    process.env.DB_PASSWORD &&
    process.env.DB_NAME,
);

let database = null;

async function resolveDatabaseAddress(hostname) {
  try {
    const result = await dns.lookup(hostname, { family: 4 });
    return { address: result.address, usedFallback: false };
  } catch (localDnsError) {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
      { headers: { accept: 'application/dns-json' } },
    );
    const answer = (await response.json()).Answer?.find(
      (record) => record.type === 1 && net.isIP(record.data) === 4,
    );

    if (!response.ok || !answer) {
      throw new Error(`Unable to resolve ${hostname}: ${localDnsError.message}`);
    }

    console.warn(`Local DNS could not resolve ${hostname}; using the approved DNS fallback.`);
    return { address: answer.data, usedFallback: true };
  }
}

async function connectDatabase() {
  if (!databaseConfigured) return null;

  const host = process.env.DB_HOST;
  const port = Number(process.env.DB_PORT) || 4000;
  const { address, usedFallback } = await resolveDatabaseAddress(host);

  database = mysql.createPool({
    host,
    port,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    timezone: 'Z',
    waitForConnections: true,
    connectionLimit: 5,
    ssl: process.env.DB_SSL === 'true' ? {} : undefined,
    // Preserve the TiDB hostname for TLS certificate verification while
    // opening TCP to the fallback-resolved address when necessary.
    stream: usedFallback ? () => net.connect(port, address) : undefined,
  });
  return database;
}

app.use(express.json());

const cities = [
  { id: 'kolkata', name: 'Kolkata' },
  { id: 'howrah', name: 'Howrah' },
  { id: 'asansol', name: 'Asansol' },
];

app.get('/api/health', async (_request, response) => {
  let databaseConnected = false;

  if (database) {
    try {
      await database.query('SELECT 1');
      databaseConnected = true;
    } catch (error) {
      console.error('Database health check failed:', error.message);
    }
  }

  response.status(databaseConfigured && !databaseConnected ? 503 : 200).json({
    status: databaseConfigured && !databaseConnected ? 'degraded' : 'ok',
    service: 'airscope-backend',
    databaseConfigured,
    databaseConnected,
  });
});

app.get('/api/cities', async (_request, response) => {
  if (!database) {
    response.status(503).json({ message: 'Database connection is not configured.' });
    return;
  }

  try {
    const [rows] = await database.query(
      'SELECT id, name FROM cities ORDER BY id',
    );
    response.status(200).json({ cities: rows });
  } catch (error) {
    console.error('Failed to retrieve cities:', error.message);
    response.status(503).json({ message: 'Database is unavailable.' });
  }
});

app.get('/api/air-quality', async (request, response) => {
  if (!database) {
    response.status(503).json({ message: 'Database connection is not configured.' });
    return;
  }

  const city = typeof request.query.city === 'string' ? request.query.city.trim() : '';
  const requestedLimit = request.query.limit === undefined ? 24 : Number(request.query.limit);

  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    response.status(400).json({
      message: 'limit must be a whole number from 1 to 100.',
    });
    return;
  }

  try {
    const [rows] = await database.query(
      `SELECT
         c.name AS city,
         r.recorded_at AS recordedAt,
         r.aqi,
         r.pm25,
         r.pm10,
         r.no2,
         r.so2,
         r.co,
         r.o3,
         r.source
       FROM air_quality_readings AS r
       INNER JOIN cities AS c ON c.id = r.city_id
       WHERE (? = '' OR c.name = ?)
       ORDER BY r.recorded_at DESC, c.name
       LIMIT ?`,
      [city, city, requestedLimit],
    );

    response.status(200).json({
      readings: rows,
      count: rows.length,
    });
  } catch (error) {
    console.error('Failed to retrieve air-quality readings:', error.message);
    response.status(503).json({ message: 'Database is unavailable.' });
  }
});

async function startServer() {
  try {
    await connectDatabase();
  } catch (error) {
    console.error('Database setup failed:', error.message);
  }

  app.listen(port, () => {
    console.log(`AIRSCOPE backend is listening on port ${port}.`);
    if (database) {
      startOpenAqImporter({
        database,
        apiKey: process.env.OPENAQ_API_KEY,
        intervalMs: Number(process.env.OPENAQ_REFRESH_INTERVAL_MS) || 60 * 60 * 1000,
      });
    }
  });
}

if (require.main === module) {
  void startServer();
}

module.exports = { app, connectDatabase, startServer };
