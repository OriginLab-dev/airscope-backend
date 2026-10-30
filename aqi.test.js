const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateAqi } = require('./aqi');
const { normalizeValue, getHourlyReadings } = require('./openAqImporter');
const end = Date.UTC(2026,9,30,16,30);
function records(values = {}, count = 24) {
  return Array.from({length:count}, (_,i) => ({
    city:'Kolkata', source:'OpenAQ: Victoria · hourly mean',
    recordedAt:new Date(end - (count-1-i)*3600000),
    pm25:30, pm10:50, no2:40, ...values,
  }));
}
test('CPCB breakpoints and worst pollutant determine AQI', () => {
  let rows=records(); assert.equal(calculateAqi(rows.at(-1),rows).aqi,50);
  rows=records({pm25:45}); assert.equal(calculateAqi(rows.at(-1),rows).aqi,75);
  rows=records({pm25:120}); assert.equal(calculateAqi(rows.at(-1),rows).aqi,300);
});
test('16 distinct hours and three pollutants including particulates are required', () => {
  const rows=records({},16);
  assert.equal(calculateAqi(rows.at(-1),rows).aqi,50);
  assert.equal(calculateAqi(rows.at(-1),rows.slice(1)).aqi,null);
  assert.equal(calculateAqi(rows.at(-1),Array(24).fill(rows[0])).aqi,null);
  const gases=records({pm25:null,pm10:null,no2:40,so2:40,co:1000,o3:50});
  assert.equal(calculateAqi(gases.at(-1),gases).aqi,null);
});
test('no mixing stations, cities, future readings or expired history', () => {
  const rows=records(); const target=rows.at(-1);
  for(const changed of [{city:'Howrah'},{source:'other station'},{recordedAt:new Date(end+3600000)},{recordedAt:new Date(end-86400000)}]){
    assert.equal(calculateAqi(target,rows.map(r=>({...r,...changed}))).aqi,null);
  }
});
test('CO uses recent 8-hour mean and converts micrograms to milligrams', () => {
  const rows=records({co:1000});
  rows.slice(-8).forEach(r=>r.co=2000);
  const result=calculateAqi(rows.at(-1),rows);
  assert.equal(result.aqiAverages.co,2); assert.equal(result.aqi,100);
  rows.at(-2).co=null;
  assert.ok(!calculateAqi(rows.at(-1),rows).aqiPollutants.includes('co'));
});
test('ozone uses 8-hour mean and switches to 1-hour for high levels', () => {
  const rows=records({o3:100});
  assert.equal(calculateAqi(rows.at(-1),rows).aqi,100);
  rows.at(-1).o3=748;
  assert.equal(calculateAqi(rows.at(-1),rows).aqi,400);
  rows.at(-1).o3=749;
  assert.equal(calculateAqi(rows.at(-1),rows).aqiDisplay,'401–500');
});
test('severe is a range, missing/invalid values are not zero, numeric strings work', () => {
  let rows=records({pm25:251}); let result=calculateAqi(rows.at(-1),rows);
  assert.equal(result.aqiCategory,'Severe'); assert.equal(result.aqi,null);
  rows=records({pm25:'30',pm10:'50',no2:'40'});
  assert.equal(calculateAqi(rows.at(-1),rows).aqi,50);
  rows=records({pm25:null,pm10:'',no2:-1});
  assert.equal(calculateAqi(rows.at(-1),rows).aqi,null);
});
test('importer units and null handling', () => {
  assert.equal(normalizeValue(null,'co','ppb'),null);
  assert.equal(normalizeValue(-1,'pm25','µg/m³'),null);
  assert.equal(normalizeValue(2,'co','mg/m³'),2000);
  assert.equal(normalizeValue(100,'co','ppb'),114.56);
});
test('hourly import preserves period end, excludes flagged and incomplete observations', async () => {
  const original=global.fetch;
  const now=Date.now(); const stamp=new Date(now-3600000).toISOString();
  global.fetch=async url=>({ok:true,json:async()=> url.includes('/locations/') ?
    {results:[{id:1,parameter:{name:'pm25',units:'µg/m³'},datetimeLast:{utc:stamp}}]} :
    {results:[
      {value:30,period:{datetimeTo:{utc:stamp}},coverage:{percentCoverage:100}},
      {value:999,period:{datetimeTo:{utc:stamp}},flagInfo:{hasFlags:true}},
      {value:888,period:{datetimeTo:{utc:stamp}},coverage:{percentCoverage:10}},
    ]}});
  try {
    const result=await getHourlyReadings({locationId:1,station:'Test'},'test');
    assert.equal(result.length,1); assert.equal(result[0].pm25,30);
    assert.equal(result[0].recordedAt,stamp.slice(0,19).replace('T',' '));
    assert.match(result[0].source,/hourly mean$/);
  } finally {global.fetch=original;}
});
