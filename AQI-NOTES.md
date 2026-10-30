# AIRSCOPE AQI

The importer retrieves the previous 48 hours from the OpenAQ sensor /hours
endpoint for the existing three approved stations. It selects the most recently
reporting sensor for each supported pollutant, ignores flagged or less than 75%
covered hours, and retains the actual end time of each hourly mean in UTC.
It does not copy a latest observation into missing hours. Hourly-mean records
have a distinct source suffix so calculation does not mix them with older
instantaneous snapshots.

## Calculation

- India CPCB breakpoints for PM2.5, PM10, NO2, SO2, CO and O3.
- At least 16 distinct hourly values per eligible pollutant in the preceding
  24 hours; at least three eligible pollutants, including PM2.5 or PM10.
- PM2.5, PM10, NO2 and SO2: 24-hour means of available hours.
- CO and O3: recent eight-hour means. AIRSCOPE conservatively requires all eight
  hours, as well as the 16-hour overall coverage gate.
- CO is stored in micrograms/m³ and converted to milligrams/m³ for its index.
- Ozone's very-poor and severe breakpoints use the current one-hour value,
  following the CPCB table footnote.
- The largest valid pollutant sub-index determines station AQI.
- The open-ended severe concentration band displays 401–500 rather than
  fabricating an exact number; its numeric AQI remains null for charts.
- Missing coverage produces a reason and coverage counts, not a zero AQI.

AQI describes the monitored station, not an average across the whole city.
These are AIRSCOPE calculations from OpenAQ data, not official CPCB readings.
Calculated numeric values are saved to the existing aqi column after each
import; the read API additionally returns category, reason and coverage.
No schema migration or new package is needed.

## Verification and operation

Run node --test aqi.test.js. Restart the backend with npm run start:local
to activate the updated importer locally. Render needs the updated backend
files deployed to continue hourly-history imports and return AQI metadata.
Existing stored AQI values are already visible through the existing read API.
The frontend must also use the updated code for the detailed missing-data message.

References:
- https://cpcb.nic.in/displaypdf.php?id=bmF0aW9uYWwtYWlyLXF1YWxpdHktaW5kZXgvQWJvdXRfQVFJLnBkZg%3D%3D
- https://www.cpcb.nic.in/displaypdf.php?id=bmF0aW9uYWwtYWlyLXF1YWxpdHktaW5kZXgvRklOQUwtUkVQT1JUX0FRSV8ucGRm
- https://docs.openaq.org/resources/measurements
