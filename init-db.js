#!/usr/bin/env node
/**
 * Initialize (or reset) the CityView SQLite database with the schema.
 *
 * Usage:
 *   node init-db.js                  # creates cityview.db
 *   node init-db.js myfile.db        # custom path
 *   node init-db.js --reset          # drops and recreates all tables
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const args = process.argv.slice(2);
const reset = args.includes('--reset');
const dbPath = args.find(a => !a.startsWith('--')) || 'cityview.db';

const db = new DatabaseSync(dbPath);

if (reset) {
  console.log('Dropping existing tables...');
  db.exec(`PRAGMA foreign_keys = OFF`);
  db.exec(`
    DROP TABLE IF EXISTS ce_inspections;
    DROP TABLE IF EXISTS ce_fees;
    DROP TABLE IF EXISTS code_enforcement;
    DROP TABLE IF EXISTS inspections;
    DROP TABLE IF EXISTS fees;
    DROP TABLE IF EXISTS sub_permits;
    DROP TABLE IF EXISTS permits;
    DROP TABLE IF EXISTS applications;
    DROP TABLE IF EXISTS properties;
  `);
  db.exec(`PRAGMA foreign_keys = ON`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS properties (
    parcel_number TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    property_class TEXT,
    historic_district_id TEXT
  );

  CREATE TABLE IF NOT EXISTS code_enforcement (
    case_number TEXT PRIMARY KEY,
    parcel_number TEXT NOT NULL REFERENCES properties(parcel_number),
    complaint_type TEXT,
    status TEXT,
    description TEXT,
    date_entered TEXT,
    fetched_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ce_inspections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_number TEXT NOT NULL REFERENCES code_enforcement(case_number),
    inspection_type TEXT,
    request_date TEXT,
    scheduled_date TEXT,
    completed_date TEXT,
    inspector TEXT,
    result TEXT,
    comments TEXT
  );

  CREATE TABLE IF NOT EXISTS ce_fees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_number TEXT NOT NULL REFERENCES code_enforcement(case_number),
    description TEXT,
    amount REAL,
    paid REAL,
    owing REAL,
    date_paid TEXT
  );

  CREATE TABLE IF NOT EXISTS permits (
    reference_number TEXT PRIMARY KEY,
    parcel_number TEXT NOT NULL REFERENCES properties(parcel_number),
    record_type TEXT NOT NULL,
    application_type TEXT,
    work_class TEXT,
    status TEXT,
    description TEXT,
    application_date TEXT,
    issued_date TEXT,
    expiration_date TEXT,
    date_finaled TEXT,
    fetched_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sub_permits (
    permit_number TEXT PRIMARY KEY,
    reference_number TEXT NOT NULL REFERENCES permits(reference_number),
    permit_type TEXT,
    permit_status TEXT,
    date_issued TEXT,
    expiration_date TEXT
  );

  CREATE TABLE IF NOT EXISTS fees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference_number TEXT NOT NULL REFERENCES permits(reference_number),
    description TEXT,
    amount REAL,
    paid REAL,
    owing REAL,
    date_paid TEXT
  );

  CREATE TABLE IF NOT EXISTS inspections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference_number TEXT NOT NULL REFERENCES permits(reference_number),
    inspection_type TEXT,
    request_date TEXT,
    scheduled_date TEXT,
    completed_date TEXT,
    inspector TEXT,
    result TEXT,
    comments TEXT
  );

`);

const counts = {
  properties: db.prepare('SELECT COUNT(*) as n FROM properties').get().n,
  code_enforcement: db.prepare('SELECT COUNT(*) as n FROM code_enforcement').get().n,
  ce_inspections: db.prepare('SELECT COUNT(*) as n FROM ce_inspections').get().n,
  permits: db.prepare('SELECT COUNT(*) as n FROM permits').get().n,
  sub_permits: db.prepare('SELECT COUNT(*) as n FROM sub_permits').get().n,
  fees: db.prepare('SELECT COUNT(*) as n FROM fees').get().n,
  inspections: db.prepare('SELECT COUNT(*) as n FROM inspections').get().n,
};

console.log(`Database: ${path.resolve(dbPath)}`);
console.log(`Tables: properties (${counts.properties}), code_enforcement (${counts.code_enforcement}), ce_inspections (${counts.ce_inspections}), permits (${counts.permits}), sub_permits (${counts.sub_permits}), fees (${counts.fees}), inspections (${counts.inspections})`);

db.close();
