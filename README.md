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

## Usage

```bash
# Single address
node export-permits.js --address "1010 S EUCLID AVE"

# All addresses on a street
node export-permits.js --street "GROVE AVE"

# Bulk from file (one address per line)
node export-permits.js --file addresses.txt

# Custom output path (default: cityview.db)
node export-permits.js --output oakpark.db

# Adjust delay between requests (default: 1000ms)
node export-permits.js --delay 2000
```

Or via npm scripts:

```bash
npm run export -- --address "1010 S EUCLID AVE"
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
                            ──< documents
```

### `properties`

One row per parcel. A parcel may have multiple addresses but is identified by
its Cook County parcel number.

| Column | Type | Description |
|--------|------|-------------|
| `parcel_number` | TEXT PK | Cook County parcel ID (e.g. `16184080040000`) |
| `address` | TEXT | Street address used to look up the property |

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

### `documents`

Documents and images attached to an application. Includes violation notices,
inspection results, citations, photos, and other uploaded files.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment ID |
| `application_number` | TEXT FK | References `applications.reference_number` |
| `document_name` | TEXT | File/document name (e.g. `Inspection Results - Violations`, `661 SOUTH BLVD CITATION`) |
| `document_type` | TEXT | Document category/type |
| `document_date` | TEXT | Date the document was uploaded or created |

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

-- Violation-related documents for a property
SELECT p.address, a.reference_number, d.document_name, d.document_date
FROM documents d
JOIN applications a ON a.reference_number = d.application_number
JOIN properties p ON p.parcel_number = a.parcel_number
WHERE d.document_name LIKE '%violation%' OR d.document_name LIKE '%citation%';

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
