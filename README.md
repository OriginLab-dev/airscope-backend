# AIRSCOPE Backend

REST API and data pipeline for **AIRSCOPE**, an air-quality monitoring project. The backend imports hourly pollutant data from [OpenAQ](https://openaq.org), stores it in MySQL, calculates station-level Air Quality Index (AQI) values using India's **CPCB** methodology, and serves the results to the AIRSCOPE frontend.

> AQI values are AIRSCOPE calculations from OpenAQ data. They are **not** official CPCB readings.

## Features

- Hourly data import from the OpenAQ sensor `/hours` endpoint (previous 48 hours per run)
- CPCB-based AQI calculation for PM2.5, PM10, NO2, SO2, CO and O3
- Data-quality gates: hours with flags or under 75% coverage are ignored, and missing hours are never filled with the latest value
- Missing-coverage responses return a reason and coverage counts instead of a misleading zero AQI
- Express REST API with CORS enabled
- Unit tests for the AQI logic using the built-in Node test runner

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js (CommonJS) |
| Framework | Express 5 |
| Database | MySQL (via `mysql2`) |
| Data source | OpenAQ API |
| Deployment | Render |

## Project Structure

```
airscope-backend/
├── server.js            # Express app and API routes
├── openAqImporter.js    # Fetches and stores hourly OpenAQ data
├── aqi.js               # CPCB AQI calculation logic
├── aqi.test.js          # Unit tests for AQI calculation
├── AQI-NOTES.md         # Detailed AQI methodology notes
├── .env.example         # Environment variable template
└── package.json
```

## Getting Started

### Prerequisites

- Node.js 20.6+ (required for `--env-file`)
- A MySQL database
- An OpenAQ API key

### Installation

```bash
git clone https://github.com/OriginLab-dev/airscope-backend.git
cd airscope-backend
npm install
```

### Configuration

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

<!-- TODO: list the real variables from .env.example, e.g. -->

| Variable | Description |
|----------|-------------|
| `DB_HOST` | MySQL host |
| `DB_USER` | MySQL user |
| `DB_PASSWORD` | MySQL password |
| `DB_NAME` | Database name |
| `OPENAQ_API_KEY` | OpenAQ API key |
| `PORT` | Server port |

### Database Setup

<!-- TODO: add the schema (tables and columns) or link to the SQL file / Notion docs -->

### Run the Server

```bash
# Local, loads variables from .env
npm run start:local

# Production
npm start
```

## API Reference

<!-- TODO: replace with the real routes from server.js / your Notion API docs -->

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/...` | Describe what it returns |
| GET | `/api/...` | Describe what it returns |

Example response:

```json
{
  "station": "Example Station",
  "aqi": 142,
  "category": "Moderate",
  "coverage": { "pollutants": 4, "hours": 22 }
}
```

## AQI Calculation

Station AQI follows the Indian CPCB National AQI:

- **Breakpoints:** CPCB tables for PM2.5, PM10, NO2, SO2, CO and O3
- **Eligibility:** at least 16 distinct hourly values per pollutant in the last 24 hours, and at least 3 eligible pollutants including PM2.5 or PM10
- **Averaging:** 24-hour means for PM2.5, PM10, NO2 and SO2; 8-hour means for CO and O3
- **Result:** the highest pollutant sub-index becomes the station AQI
- AQI describes the monitored station, not the whole city

See [AQI-NOTES.md](./AQI-NOTES.md) for the full methodology.

## Testing

```bash
node --test aqi.test.js
```

## Deployment

The backend is deployed on **Render**. After pulling changes, redeploy so the importer keeps running and the API returns the latest AQI metadata.

<!-- TODO: add live API URL and Render setup notes (build command, start command, env vars) -->

## References

- [CPCB National AQI](https://cpcb.nic.in/displaypdf.php?id=bmF0aW9uYWwtYWlyLXF1YWxpdHktaW5kZXgvQWJvdXRfQVFJLnBkZg%3D%3D)
- [OpenAQ API documentation](https://docs.openaq.org/resources/measurements)

## License

ISC
