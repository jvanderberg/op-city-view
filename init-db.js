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
  db.exec(`
    DROP TABLE IF EXISTS documents;
    DROP TABLE IF EXISTS inspections;
    DROP TABLE IF EXISTS fees;
    DROP TABLE IF EXISTS sub_permits;
    DROP TABLE IF EXISTS applications;
    DROP TABLE IF EXISTS properties;
  `);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS properties (
    parcel_number TEXT PRIMARY KEY,
    address TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS applications (
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
    application_number TEXT NOT NULL REFERENCES applications(reference_number),
    permit_type TEXT,
    permit_status TEXT,
    date_issued TEXT,
    expiration_date TEXT
  );

  CREATE TABLE IF NOT EXISTS fees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_number TEXT NOT NULL REFERENCES applications(reference_number),
    description TEXT,
    amount REAL,
    paid REAL,
    owing REAL,
    date_paid TEXT
  );

  CREATE TABLE IF NOT EXISTS inspections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_number TEXT NOT NULL REFERENCES applications(reference_number),
    inspection_type TEXT,
    request_date TEXT,
    scheduled_date TEXT,
    completed_date TEXT,
    inspector TEXT,
    result TEXT,
    comments TEXT
  );

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_number TEXT NOT NULL REFERENCES applications(reference_number),
    document_name TEXT,
    document_type TEXT,
    document_date TEXT
  );
`);

const counts = {
  properties: db.prepare('SELECT COUNT(*) as n FROM properties').get().n,
  applications: db.prepare('SELECT COUNT(*) as n FROM applications').get().n,
  sub_permits: db.prepare('SELECT COUNT(*) as n FROM sub_permits').get().n,
  fees: db.prepare('SELECT COUNT(*) as n FROM fees').get().n,
  inspections: db.prepare('SELECT COUNT(*) as n FROM inspections').get().n,
  documents: db.prepare('SELECT COUNT(*) as n FROM documents').get().n,
};

console.log(`Database: ${path.resolve(dbPath)}`);
console.log(`Tables: properties (${counts.properties}), applications (${counts.applications}), sub_permits (${counts.sub_permits}), fees (${counts.fees}), inspections (${counts.inspections}), documents (${counts.documents})`);

db.close();
