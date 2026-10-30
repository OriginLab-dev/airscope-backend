// CPCB About AQI / final report table 3.11. Concentrations are stored in µg/m³.
// The open-ended severe band is reported as a range, never an invented exact AQI.
const limits = { pm25:[30,60,90,120,250], pm10:[50,100,250,350,430], no2:[40,80,180,280,400], so2:[40,80,380,800,1600], co:[1,2,10,17,34], o3:[50,100,168,208,748] };
const indexLimits = [50,100,200,300,400];
function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function time(value) {
  if (value instanceof Date) return value.getTime();
  const s = String(value);
  return Date.parse(/Z$|[+-]\d\d:\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
}
function calculateAqi(reading, history) {
  const end = time(reading.recordedAt);
  const subIndices = {};
  const coverage = {};
  const averages = {};
  let severe = false;
  for (const [key, bands] of Object.entries(limits)) {
    const hours = new Map();
    for (const row of history) {
      const t = time(row.recordedAt), value = numeric(row[key]);
      if (row.city === reading.city && row.source === reading.source &&
          t <= end && t > end - 86400000 && value !== null) hours.set(Math.floor(t / 3600000), { t, value });
    }
    coverage[key] = hours.size;
    if (hours.size < 16) continue;
    let samples = [...hours.values()];
    const shortWindow = key === 'co' || key === 'o3';
    if (shortWindow) samples = samples.filter(item => item.t > end - 8 * 3600000);
    // Conservative completeness policy: all eight hourly means for 8-hour gases.
    if (shortWindow && samples.length < 8) continue;
    let mean = samples.reduce((sum,item) => sum + item.value,0) / samples.length;
    // CPCB's very-poor/severe ozone bands use a one-hour monitoring value.
    if (key === 'o3') {
      const current = [...hours.values()].find(item => item.t === end);
      if (current && current.value > 208) mean = current.value;
      else if (mean > 208) mean = 208; // 8-hour bands end at the Poor category.
    }
    if (key === 'co') mean /= 1000;
    const precision = key === 'co' ? 10 : 1;
    const concentration = Math.round(mean * precision) / precision;
    averages[key] = concentration;
    const band = bands.findIndex(limit => concentration <= limit);
    if (band < 0) { severe = true; subIndices[key] = 401; continue; }
    const low = band === 0 ? 0 : bands[band-1] + 1 / precision;
    const indexLow = band === 0 ? 0 : indexLimits[band-1] + 1;
    subIndices[key] = Math.round(indexLow + (concentration-low) * (indexLimits[band]-indexLow)/(bands[band]-low));
  }
  const sufficient = Object.keys(subIndices).length >= 3 && (subIndices.pm25 !== undefined || subIndices.pm10 !== undefined);
  const value = sufficient && !severe ? Math.max(...Object.values(subIndices)) : null;
  const category = sufficient ? severe ? 'Severe' : ['Good','Satisfactory','Moderate','Poor','Very Poor'][indexLimits.findIndex(limit => value <= limit)] : null;
  return {
    aqi: value,
    aqiDisplay: sufficient && severe ? '401–500' : value === null ? null : String(value),
    aqiCategory: category,
    aqiStatus: sufficient ? 'Calculated station AQI · India CPCB' : 'Insufficient data for AQI',
    aqiReason: sufficient ? 'Calculated from available station pollutants; not an official CPCB reading.' : 'Requires 16 distinct hourly readings for at least three pollutants, including PM2.5 or PM10. CO and ozone also need eight recent hourly readings.',
    aqiStandard: 'India CPCB',
    aqiPollutants: Object.keys(subIndices),
    aqiCoverage: coverage,
    aqiAverages: averages,
  };
}
module.exports = { calculateAqi };
