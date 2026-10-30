const { calculateAqi } = require('./aqi');
const MONITORED_LOCATIONS = [
  { city: 'Kolkata', locationId: 10633, station: 'Victoria, Kolkata - WBPCB' },
  { city: 'Howrah', locationId: 5614, station: 'Padmapukur, Howrah - WBPCB' },
  { city: 'Asansol', locationId: 5602, station: 'Asansol Court Area - WBPCB' },
];

const SUPPORTED_PARAMETERS = new Set(['pm25', 'pm10', 'no2', 'so2', 'co', 'o3']);
const MAX_MEASUREMENT_AGE_MS = 48 * 60 * 60 * 1000;
const PPB_TO_MICROGRAMS_PER_CUBIC_METER = {
  co: 1.1456,
  no2: 1.8816,
  so2: 2.6203,
};

function utcHour(dateTime) {
  const date = new Date(dateTime);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeValue(value, parameter, units) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) return null;
  if (units === 'µg/m³') return Number(value);
  if (units === 'mg/m³') return Number(value) * 1000;
  if (units === 'ppb' && PPB_TO_MICROGRAMS_PER_CUBIC_METER[parameter]) {
    return Number(value) * PPB_TO_MICROGRAMS_PER_CUBIC_METER[parameter];
  }
  return null;
}

async function openAqRequest(path, apiKey) {
  const response = await fetch(`https://api.openaq.org/v3${path}`, {
    headers: { 'X-API-Key': apiKey },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`OpenAQ request failed (${response.status}).`);
  }

  return response.json();
}

async function getHourlyReadings(location, apiKey) {
  const sensorsResponse = await openAqRequest(`/locations/${location.locationId}/sensors?limit=100`, apiKey);
  const now = Date.now();
  const from = now - MAX_MEASUREMENT_AGE_MS;
  // Choose the most recently reporting sensor per pollutant at the approved station.
  const sensors = new Map();
  for (const sensor of sensorsResponse.results || []) {
    const key = sensor.parameter?.name;
    const last = Date.parse(sensor.datetimeLast?.utc);
    if (!SUPPORTED_PARAMETERS.has(key) || !Number.isFinite(last) || last < from) continue;
    if (!sensors.has(key) || last > Date.parse(sensors.get(key).datetimeLast.utc)) sensors.set(key, sensor);
  }
  const readingsByHour = new Map();
  for (const [parameter, sensor] of sensors) {
    const query = new URLSearchParams({ datetime_from:new Date(from).toISOString(), datetime_to:new Date(now).toISOString(), limit:'100' });
    const result = await openAqRequest(`/sensors/${sensor.id}/hours?${query}`, apiKey);
    for (const measurement of result.results || []) {
      const timestamp = measurement.period?.datetimeTo?.utc;
      const measurementTime = Date.parse(timestamp);
      if (!Number.isFinite(measurementTime) || measurementTime <= from || measurementTime > now || measurement.flagInfo?.hasFlags) continue;
      if (measurement.coverage?.percentCoverage != null && measurement.coverage.percentCoverage < 75) continue;
      const value = normalizeValue(measurement.value, parameter, measurement.parameter?.units || sensor.parameter.units);
      if (value === null) continue;
      // Preserve the actual hour's end (Indian stations often report at :30 UTC).
      const recordedAt = new Date(measurementTime).toISOString().slice(0,19).replace('T',' ');
      const reading = readingsByHour.get(recordedAt) || { recordedAt, source:`OpenAQ: ${location.station} · hourly mean` };
      reading[parameter] = value;
      readingsByHour.set(recordedAt, reading);
    }
  }

  return [...readingsByHour.values()];
}

async function importOpenAqReadings({ database, apiKey }) {
  if (!apiKey) {
    console.warn('OpenAQ import skipped: OPENAQ_API_KEY is not configured.');
    return { imported: 0, failures: 0 };
  }

  const [cities] = await database.query('SELECT id, name FROM cities');
  const cityIds = new Map(cities.map((city) => [city.name, city.id]));
  let imported = 0;
  let failures = 0;

  for (const location of MONITORED_LOCATIONS) {
    const cityId = cityIds.get(location.city);
    if (!cityId) {
      console.warn(`OpenAQ import skipped: ${location.city} is missing from cities.`);
      failures += 1;
      continue;
    }

    try {
      const readings = await getHourlyReadings(location, apiKey);
      for (const reading of readings) {
        await database.query(
          `INSERT INTO air_quality_readings
            (city_id, recorded_at, aqi, pm25, pm10, no2, so2, co, o3, source)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             pm25 = COALESCE(VALUES(pm25), pm25),
             pm10 = COALESCE(VALUES(pm10), pm10),
             no2 = COALESCE(VALUES(no2), no2),
             so2 = COALESCE(VALUES(so2), so2),
             co = COALESCE(VALUES(co), co),
             o3 = COALESCE(VALUES(o3), o3),
             source = VALUES(source)`,
          [
            cityId,
            reading.recordedAt,
            reading.pm25 ?? null,
            reading.pm10 ?? null,
            reading.no2 ?? null,
            reading.so2 ?? null,
            reading.co ?? null,
            reading.o3 ?? null,
            reading.source,
          ],
        );
        imported += 1;
      }
      await refreshStoredAqi(database, cityId, location.city);
    } catch (error) {
      console.error(`OpenAQ import failed for ${location.city}:`, error.message);
      failures += 1;
    }
  }

  return { imported, failures };
}

async function refreshStoredAqi(database, cityId, city) {
  const [history] = await database.query(
    `SELECT recorded_at AS recordedAt, source, pm25, pm10, no2, so2, co, o3
     FROM air_quality_readings WHERE city_id = ?
       AND recorded_at >= UTC_TIMESTAMP() - INTERVAL 72 HOUR
     ORDER BY recorded_at`, [cityId],
  );
  const rows = history.map(row => ({ ...row, city }));
  let updated = 0;
  for (const row of rows) {
    if (!row.source?.endsWith(' · hourly mean')) continue;
    const result = calculateAqi(row, rows);
    await database.query(
      'UPDATE air_quality_readings SET aqi = ? WHERE city_id = ? AND recorded_at = ? AND source = ?',
      [result.aqi, cityId, row.recordedAt, row.source],
    );
    if (result.aqi !== null) updated += 1;
  }
  return updated;
}

function startOpenAqImporter({ database, apiKey, intervalMs = 60 * 60 * 1000 }) {
  let importing = false;
  let retryTimer;
  const retryDelayMs = 5 * 60 * 1000;

  const run = async () => {
    if (importing) return;
    importing = true;
    let retrySoon = false;
    try {
      const result = await importOpenAqReadings({ database, apiKey });
      console.log(`OpenAQ import complete: ${result.imported} reading group(s), ${result.failures} issue(s).`);
      retrySoon = result.failures > 0;
    } catch (error) {
      console.error('OpenAQ import failed:', error.message);
      retrySoon = true;
    } finally {
      importing = false;
      retryTimer = setTimeout(run, retrySoon ? retryDelayMs : intervalMs);
    }
  };

  void run();
  return () => clearTimeout(retryTimer);
}

module.exports = { importOpenAqReadings, startOpenAqImporter, normalizeValue, getHourlyReadings, refreshStoredAqi };
