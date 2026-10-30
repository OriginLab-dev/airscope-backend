const MONITORED_LOCATIONS = [
  { city: 'Kolkata', locationId: 10633, station: 'Victoria, Kolkata - WBPCB' },
  { city: 'Howrah', locationId: 5614, station: 'Padmapukur, Howrah - WBPCB' },
  { city: 'Asansol', locationId: 5602, station: 'Asansol Court Area - WBPCB' },
];

const SUPPORTED_PARAMETERS = new Set(['pm25', 'pm10', 'no2', 'so2', 'co', 'o3']);
const MAX_MEASUREMENT_AGE_MS = 24 * 60 * 60 * 1000;
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
  if (!Number.isFinite(Number(value))) return null;
  if (units === 'µg/m³') return Number(value);
  if (units === 'ppb' && PPB_TO_MICROGRAMS_PER_CUBIC_METER[parameter]) {
    return Number(value) * PPB_TO_MICROGRAMS_PER_CUBIC_METER[parameter];
  }
  return null;
}

async function openAqRequest(path, apiKey) {
  const response = await fetch(`https://api.openaq.org/v3${path}`, {
    headers: { 'X-API-Key': apiKey },
  });

  if (!response.ok) {
    throw new Error(`OpenAQ request failed (${response.status}).`);
  }

  return response.json();
}

async function getHourlyReadings(location, apiKey) {
  const [latestResponse, sensorsResponse] = await Promise.all([
    openAqRequest(`/locations/${location.locationId}/latest`, apiKey),
    openAqRequest(`/locations/${location.locationId}/sensors?limit=100`, apiKey),
  ]);

  const sensors = new Map(
    (sensorsResponse.results || []).map((sensor) => [sensor.id, sensor.parameter]),
  );
  const readingsByHour = new Map();

  for (const measurement of latestResponse.results || []) {
    const parameterDetails = sensors.get(measurement.sensorsId);
    const parameter = parameterDetails?.name;
    const timestamp = measurement.datetime?.utc;
    const measurementTime = new Date(timestamp).getTime();

    if (!SUPPORTED_PARAMETERS.has(parameter) || !timestamp) continue;
    if (!Number.isFinite(measurementTime) || Date.now() - measurementTime > MAX_MEASUREMENT_AGE_MS) {
      continue;
    }

    const value = normalizeValue(measurement.value, parameter, parameterDetails.units);
    if (value === null) continue;

    const recordedAt = utcHour(timestamp);
    const reading = readingsByHour.get(recordedAt) || {
      recordedAt,
      source: `OpenAQ: ${location.station}`,
    };
    reading[parameter] = value;
    readingsByHour.set(recordedAt, reading);
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
    } catch (error) {
      console.error(`OpenAQ import failed for ${location.city}:`, error.message);
      failures += 1;
    }
  }

  return { imported, failures };
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

module.exports = { importOpenAqReadings, startOpenAqImporter };
