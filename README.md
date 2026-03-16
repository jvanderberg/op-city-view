# op-city-view

Exports residential permit, code enforcement, planning, and license data from the
[Oak Park CityView Portal](https://villageview.oak-park.us/CityViewPortal) into a
local SQLite database.

## Requirements

- **Node.js 22+** (uses built-in `node:sqlite`)
- **Playwright** (`npm install` pulls the browser binary)

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
ORDER BY CASE WHEN ap.address IS NULL THEN 1 ELSE 0 END, ap.address
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
# CSV-driven bulk scrape (restartable, 2s between requests)
node export-permits.js --parcels parcels.csv

# Single address
node export-permits.js --address "1010 S EUCLID AVE"

# All addresses on a street
node export-permits.js --street "GROVE AVE"

# Bulk from file (one address per line)
node export-permits.js --file addresses.txt

# Custom output path (default: cityview.db)
node export-permits.js --output oakpark.db

# Adjust delay between requests (default: 2000ms)
node export-permits.js --delay 5000
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
node export-permits.js --parcels parcels.csv
```

Without credentials, only Code Enforcement records are exported.
The scraper re-logs in every 20 parcels to prevent session expiry.

## Database Schema

The SQLite database uses separate tables for code enforcement and permits:

```
properties ──< code_enforcement ──< ce_inspections
                                ──< ce_fees
           ──< permits ──< sub_permits
                        ──< fees
                        ──< inspections
```

### `properties`

One row per parcel. Populated from the driver CSV with Cook County data.

| Column | Type | Description |
|--------|------|-------------|
| `parcel_number` | TEXT PK | Cook County PIN (e.g. `16184080040000`) |
| `address` | TEXT | Street address |
| `latitude` | REAL | Latitude coordinate |
| `longitude` | REAL | Longitude coordinate |
| `property_class` | TEXT | Cook County Assessor class code (e.g. `205`, `206`) |
| `historic_district_id` | TEXT | Historic district name, if applicable |

### `code_enforcement`

Code enforcement cases (complaints, violations, neighborhood walks).

| Column | Type | Description |
|--------|------|-------------|
| `case_number` | TEXT PK | CityView case number (e.g. `COD2006-00148`) |
| `parcel_number` | TEXT FK | References `properties.parcel_number` |
| `complaint_type` | TEXT | e.g. `Neighborhood Walk`, `Rats-External`, `Property Conditions/Standards` |
| `status` | TEXT | e.g. `Open`, `Closed`, `Closed - No Violations` |
| `description` | TEXT | Description of the complaint |
| `date_entered` | TEXT | Date the case was opened |
| `fetched_at` | TEXT | Timestamp when this record was scraped |

### `ce_inspections`

Inspections tied to code enforcement cases.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment ID |
| `case_number` | TEXT FK | References `code_enforcement.case_number` |
| `inspection_type` | TEXT | Type of inspection |
| `request_date` | TEXT | Date inspection was requested |
| `scheduled_date` | TEXT | Date inspection is/was scheduled |
| `completed_date` | TEXT | Date inspection was completed |
| `inspector` | TEXT | Name of the inspector |
| `result` | TEXT | Inspection result (e.g. `Pass`, `Fail`, `Violation`) |
| `comments` | TEXT | Inspector notes |

### `ce_fees`

Fees tied to code enforcement cases.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment ID |
| `case_number` | TEXT FK | References `code_enforcement.case_number` |
| `description` | TEXT | Fee description |
| `amount` | REAL | Fee amount in dollars |
| `paid` | REAL | Amount paid |
| `owing` | REAL | Amount still owing |
| `date_paid` | TEXT | Date the fee was paid, or `Not Paid` |

### `permits`

Permit applications, planning applications, and licenses.

| Column | Type | Description |
|--------|------|-------------|
| `reference_number` | TEXT PK | CityView reference (e.g. `PRRCA202100788`) |
| `parcel_number` | TEXT FK | References `properties.parcel_number` |
| `record_type` | TEXT | `Permit`, `Planning`, or `License` |
| `application_type` | TEXT | e.g. `Building`, `Electric (Alter or New)` |
| `work_class` | TEXT | Category of work (e.g. `EV Charger`, `Alterations`) |
| `status` | TEXT | e.g. `Closed`, `Finaled`, `Canceled`, `Pending` |
| `description` | TEXT | Description of work |
| `application_date` | TEXT | Date submitted |
| `issued_date` | TEXT | Date issued |
| `expiration_date` | TEXT | Expiration date |
| `date_finaled` | TEXT | Date finaled/closed |
| `fetched_at` | TEXT | Timestamp when this record was scraped |

### `sub_permits`

Individual permits issued under a parent permit application.

| Column | Type | Description |
|--------|------|-------------|
| `permit_number` | TEXT PK | Sub-permit number (e.g. `BLD2010-01782`) |
| `reference_number` | TEXT FK | References `permits.reference_number` |
| `permit_type` | TEXT | `Building`, `Electric`, `Plumbing`, `Mechanical`, `Plan Review` |
| `permit_status` | TEXT | `Finaled`, `Expired`, `Pending`, etc. |
| `date_issued` | TEXT | Date this sub-permit was issued |
| `expiration_date` | TEXT | Expiration date |

### `fees`

Fee line items associated with a permit/planning/license record.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment ID |
| `reference_number` | TEXT FK | References `permits.reference_number` |
| `description` | TEXT | Fee description |
| `amount` | REAL | Fee amount in dollars |
| `paid` | REAL | Amount paid |
| `owing` | REAL | Amount still owing |
| `date_paid` | TEXT | Date the fee was paid, or `Not Paid` |

### `inspections`

Inspections tied to permit/planning/license records.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment ID |
| `reference_number` | TEXT FK | References `permits.reference_number` |
| `inspection_type` | TEXT | Type of inspection (e.g. `Final`, `Rough-In`) |
| `request_date` | TEXT | Date inspection was requested |
| `scheduled_date` | TEXT | Date inspection is/was scheduled |
| `completed_date` | TEXT | Date inspection was completed |
| `inspector` | TEXT | Name of the inspector |
| `result` | TEXT | Inspection result (e.g. `Pass`, `Fail`) |
| `comments` | TEXT | Inspector notes |

## Example Queries

```sql
-- All permits for a property
SELECT * FROM permits
WHERE parcel_number = '16184080040000' AND record_type = 'Permit';

-- Sub-permits for a specific permit
SELECT * FROM sub_permits WHERE reference_number = 'PRJ2010-00712';

-- Total fees by permit
SELECT reference_number, SUM(amount) as total, SUM(paid) as paid
FROM fees GROUP BY reference_number;

-- Properties with outstanding permit fees
SELECT p.address, pm.reference_number, f.amount - f.paid as owing
FROM fees f
JOIN permits pm ON pm.reference_number = f.reference_number
JOIN properties p ON p.parcel_number = pm.parcel_number
WHERE f.paid < f.amount;

-- All open code enforcement cases
SELECT p.address, ce.case_number, ce.complaint_type, ce.description
FROM code_enforcement ce
JOIN properties p ON p.parcel_number = ce.parcel_number
WHERE ce.status = 'Open';

-- Properties in the Frank Lloyd Wright historic district with CE cases
SELECT p.address, ce.case_number, ce.complaint_type, ce.status
FROM code_enforcement ce
JOIN properties p ON p.parcel_number = ce.parcel_number
WHERE p.historic_district_id = 'Frank Lloyd Wright';
```

## How It Works

1. **Parcel list** — The driver CSV provides Cook County PINs for all Oak Park
   residential properties, pre-tagged with coordinates and historic districts.

2. **Record discovery** — For each module (Permit, Code Enforcement, Planning,
   License), the `LocatorResults` API is called with the parcel number. This
   returns a JSON response with a `View` field containing indexed record
   references (e.g. `permitNumber0`, `permitNumber1`, ...) which are extracted
   via regex.

3. **Detail extraction** — Each discovered reference number is fetched from its
   module's `StatusReference` page, which contains structured `displayField`
   elements with all record detail (dates, descriptions, sub-permits, fees).

4. **Storage** — All data is inserted into SQLite with `INSERT OR REPLACE`
   semantics, so re-running for the same parcels updates existing records.

## Data Source

All data comes from the Village of Oak Park's public CityView Portal at
https://villageview.oak-park.us/CityViewPortal. Code enforcement records are
publicly accessible; permit records require a free portal account.
