# op-city-view

Exports residential permit, code enforcement, planning, and license data from the
[Oak Park CityView Portal](https://villageview.oak-park.us/CityViewPortal) into a
local SQLite database.

## Requirements

- **Node.js 22+** (uses built-in `node:sqlite`)
- **Playwright Chromium** browser binary

## Setup

```bash
npm install
node init-db.js            # Create empty database with schema
```

## Parcel Driver CSV

The scraper is driven by `parcels.csv`, a CSV file listing every Oak Park
residential property to scrape. Columns:

| Column | Description |
|--------|-------------|
| `parcel_number` | 14-digit Cook County PIN (e.g. `16184080040000`) |
| `address` | Street address from Cook County address points |
| `latitude` | Latitude coordinate (empty for ~354 unit-level PINs) |
| `longitude` | Longitude coordinate |
| `property_class` | Cook County Assessor class code (e.g. `205`, `206`) |
| `historic_district` | Oak Park historic district name, or empty |
| `scraped` | `true` if already scraped, `false` if pending |

The `scraped` column makes the export restartable — re-running picks up where
it left off.

### Generating the CSV

`generate-parcels.js` builds the CSV by querying the
[tax_appeal_app](../tax_appeal_app) SQLite database (`data/properties.db`) and
the Oak Park ArcGIS historic districts layer.

```bash
node generate-parcels.js                  # default paths
node generate-parcels.js --db <path>      # custom DB path
node generate-parcels.js --classes 205,206 # specific classes only
node generate-parcels.js --year 2024      # assessment year
```

**Source query** (against `tax_appeal_app/data/properties.db`):

```sql
SELECT
  av.pin,
  av.class,
  ap.address,
  ap.lat,
  ap.lon
FROM assessed_values av
LEFT JOIN address_points ap ON av.pin = ap.pin
WHERE av.township_name = 'Oak Park'
  AND av.year = 2024
  AND av.class IN ('202','203','204','205','206','207','208','209','210','234','278','295')
ORDER BY ap.address
```

This yields ~10,300 single-family residential properties. The class filter
excludes condos (299), multi-family (211-212), and non-residential classes.

**Historic district tagging**: The script fetches polygon boundaries from
Oak Park's [ArcGIS Historic Districts layer](https://oak-park-open-data-portal-v2-oakparkil.hub.arcgis.com/datasets/d3ff666dfb764e8183879667acce810e_13/explore)
and uses ray-casting point-in-polygon to classify each property into one of
three districts:

| District | Properties |
|----------|-----------|
| Frank Lloyd Wright | ~1,656 |
| Ridgeland - Oak Park | ~1,126 |
| Gunderson | ~267 |
| _(none)_ | ~7,251 |

## Usage

```bash
# CSV-driven bulk scrape (restartable, 10s between requests)
node export-permits.js --parcels parcels.csv

# Single address
node export-permits.js --address "1010 S EUCLID AVE"

# All addresses on a street
node export-permits.js --street "GROVE AVE"

# Bulk from file (one address per line)
node export-permits.js --file addresses.txt

# Custom output path (default: cityview.db)
node export-permits.js --output oakpark.db

# Adjust delay between requests (default: 10000ms)
node export-permits.js --delay 2000
```

Or via npm scripts:

```bash
npm run generate-parcels
npm run export -- --parcels parcels.csv
npm run init-db
```

## Authentication

Permit data requires a CityView Portal account. Pass credentials via environment
variables — **never commit them**:

```bash
export CITYVIEW_EMAIL="you@example.com"
export CITYVIEW_PASSWORD="your-password"
node export-permits.js --address "1010 S EUCLID AVE"
```

Without credentials, only Code Enforcement records are exported.

## Database Schema

The SQLite database has four tables in a normalized relational structure:

```
properties ──< applications ──< sub_permits
                            ──< fees
                            ──< inspections
```

### `properties`

One row per parcel. A parcel may have multiple addresses but is identified by
its Cook County parcel number.

| Column | Type | Description |
|--------|------|-------------|
| `parcel_number` | TEXT PK | Cook County parcel ID (e.g. `16184080040000`) |
| `address` | TEXT | Street address used to look up the property |
| `latitude` | REAL | Latitude coordinate |
| `longitude` | REAL | Longitude coordinate |
| `property_class` | TEXT | Property classification (e.g. `Single-family`, `Multi-family`) |
| `historic_district_id` | TEXT | Historic district identifier, if applicable |

### `applications`

One row per permit application, code enforcement case, planning application,
or license. This is the core record table.

| Column | Type | Description |
|--------|------|-------------|
| `reference_number` | TEXT PK | CityView reference (e.g. `PRRCA202100788`, `COD2006-00148`) |
| `parcel_number` | TEXT FK | References `properties.parcel_number` |
| `record_type` | TEXT | `Permit`, `Code Enforcement`, `Planning`, or `License` |
| `application_type` | TEXT | e.g. `Building`, `Electric (Alter or New)`, `Neighborhood Walk` |
| `work_class` | TEXT | Category of work (e.g. `EV Charger`, `Alterations 1 and 2 unit-Family Dwellings`) |
| `status` | TEXT | e.g. `Closed`, `Open`, `Finaled`, `Canceled` |
| `description` | TEXT | Free-text description of work or complaint |
| `application_date` | TEXT | Date the application was submitted (MM/DD/YYYY) |
| `issued_date` | TEXT | Date the permit was issued |
| `expiration_date` | TEXT | Permit expiration date |
| `date_finaled` | TEXT | Date the application was finaled/closed |
| `fetched_at` | TEXT | Timestamp when this record was scraped |

### `sub_permits`

Individual permits issued under a parent application. A single application
(e.g. a building project) can have multiple sub-permits for Building,
Electric, Plumbing, Mechanical, Plan Review, etc.

| Column | Type | Description |
|--------|------|-------------|
| `permit_number` | TEXT PK | Sub-permit number (e.g. `BLD2010-01782`, `ELE2010-00492`) |
| `application_number` | TEXT FK | References `applications.reference_number` |
| `permit_type` | TEXT | `Building`, `Electric`, `Plumbing`, `Mechanical`, `Plan Review` |
| `permit_status` | TEXT | `Finaled`, `Expired`, `Pending`, etc. |
| `date_issued` | TEXT | Date this sub-permit was issued |
| `expiration_date` | TEXT | Expiration date |

### `fees`

Fee line items associated with an application. Includes both paid and
outstanding fees.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment ID |
| `application_number` | TEXT FK | References `applications.reference_number` |
| `description` | TEXT | Fee description (e.g. `425 - Miscellaneous electrical system installation(s)`) |
| `amount` | REAL | Fee amount in dollars |
| `paid` | REAL | Amount paid |
| `owing` | REAL | Amount still owing |
| `date_paid` | TEXT | Date the fee was paid, or `Not Paid` |

### `inspections`

Inspection records associated with an application. Includes scheduled, completed,
and pending inspections from all modules (permits, code enforcement, etc.).

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment ID |
| `application_number` | TEXT FK | References `applications.reference_number` |
| `inspection_type` | TEXT | Type of inspection (e.g. `Final`, `Rough-In`, `Neighborhood Walk`) |
| `request_date` | TEXT | Date inspection was requested |
| `scheduled_date` | TEXT | Date inspection is/was scheduled |
| `completed_date` | TEXT | Date inspection was completed |
| `inspector` | TEXT | Name of the inspector |
| `result` | TEXT | Inspection result (e.g. `Pass`, `Fail`, `Violation`) |
| `comments` | TEXT | Inspector notes or comments |

## Example Queries

```sql
-- All permits for a property
SELECT * FROM applications
WHERE parcel_number = '16184080040000' AND record_type = 'Permit';

-- Sub-permits for a specific application
SELECT * FROM sub_permits WHERE application_number = 'PRJ2010-00712';

-- Total fees by application
SELECT application_number, SUM(amount) as total, SUM(paid) as paid
FROM fees GROUP BY application_number;

-- Properties with outstanding fees
SELECT p.address, a.reference_number, f.amount - f.paid as owing
FROM fees f
JOIN applications a ON a.reference_number = f.application_number
JOIN properties p ON p.parcel_number = a.parcel_number
WHERE f.paid < f.amount;

-- All open code enforcement cases
SELECT p.address, a.reference_number, a.application_type, a.description
FROM applications a
JOIN properties p ON p.parcel_number = a.parcel_number
WHERE a.record_type = 'Code Enforcement' AND a.status = 'Open';

-- Failed inspections
SELECT p.address, a.reference_number, i.inspection_type, i.completed_date, i.result, i.comments
FROM inspections i
JOIN applications a ON a.reference_number = i.application_number
JOIN properties p ON p.parcel_number = a.parcel_number
WHERE i.result LIKE '%Fail%' OR i.result LIKE '%Violation%';
```

## How It Works

1. **Address lookup** — The Property `LocationSearch` API resolves an address
   string to a parcel number via the `LocateResults` redirect URL.

2. **Record discovery** — For each module (Permit, Code Enforcement, Planning,
   License), the `LocatorResults` API is called with the parcel number. This
   returns a JSON response with a `View` field containing indexed record
   references (e.g. `permitNumber0`, `permitNumber1`, ...) which are extracted
   via regex.

3. **Detail extraction** — Each discovered reference number is fetched from its
   module's `StatusReference` page, which contains structured `displayField`
   elements with all record detail (dates, descriptions, sub-permits, fees).

4. **Storage** — All data is inserted into SQLite with `INSERT OR REPLACE`
   semantics, so re-running for the same addresses updates existing records.

## Data Source

All data comes from the Village of Oak Park's public CityView Portal at
https://villageview.oak-park.us/CityViewPortal. Code enforcement records are
publicly accessible; permit records require a free portal account.
