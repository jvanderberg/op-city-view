#!/usr/bin/env node
/**
 * Generate a CSV driver file for CityView scraping.
 *
 * Reads all Oak Park residential properties from the tax_appeal_app SQLite DB,
 * fetches historic district polygons from Oak Park's ArcGIS service, and does
 * point-in-polygon to tag each property with its historic district (if any).
 *
 * Output CSV columns:
 *   parcel_number, address, latitude, longitude, property_class, historic_district, scraped
 *
 * Usage:
 *   node generate-parcels.js
 *   node generate-parcels.js --db ~/git/tax_appeal_app/data/properties.db
 *   node generate-parcels.js --output parcels.csv
 *   node generate-parcels.js --classes 202,203,204,205,206
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────

const RESIDENTIAL_CLASSES = [
  '202','203','204','205','206','207','208','209','210','234','278','295',
];

const ARCGIS_HISTORIC_DISTRICTS_URL =
  'https://utility.arcgis.com/usrsvcs/servers/4cff1aaefa364b57b8c70d5c606f2088/rest/services/VOP/AGOL_VOP_Project/MapServer/13/query';

// ─── CLI ─────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    db: path.join(process.env.HOME, 'git/tax_appeal_app/data/properties.db'),
    output: 'parcels.csv',
    classes: RESIDENTIAL_CLASSES,
    year: 2024,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--db':
        opts.db = args[++i];
        break;
      case '--output': case '-o':
        opts.output = args[++i];
        break;
      case '--classes':
        opts.classes = args[++i].split(',').map(s => s.trim());
        break;
      case '--year':
        opts.year = parseInt(args[++i], 10);
        break;
      case '--help': case '-h':
        console.log(`Usage:
  node generate-parcels.js
  node generate-parcels.js --db <path>        Tax appeal app DB (default: ~/git/tax_appeal_app/data/properties.db)
  node generate-parcels.js --output <path>    Output CSV file (default: parcels.csv)
  node generate-parcels.js --classes 202,203  Comma-separated property classes
  node generate-parcels.js --year 2024        Assessment year (default: 2024)`);
        process.exit(0);
    }
  }

  return opts;
}

// ─── Point-in-polygon (ray casting) ─────────────────────────────────

function pointInPolygon(point, polygon) {
  const [x, y] = point;
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];

    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }

  return inside;
}

function pointInMultiPolygon(point, rings) {
  if (!pointInPolygon(point, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInPolygon(point, rings[i])) return false;
  }
  return true;
}

function findHistoricDistrict(lon, lat, districts) {
  const point = [lon, lat];
  for (const district of districts) {
    const geom = district.geometry;
    if (geom.type === 'Polygon') {
      if (pointInMultiPolygon(point, geom.coordinates)) return district.name;
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        if (pointInMultiPolygon(point, poly)) return district.name;
      }
    }
  }
  return null;
}

// ─── ArcGIS fetch ────────────────────────────────────────────────────

async function fetchHistoricDistricts() {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: 'NAME,TYPE',
    f: 'geojson',
    returnGeometry: 'true',
  });

  const url = `${ARCGIS_HISTORIC_DISTRICTS_URL}?${params}`;
  console.log('Fetching historic district polygons...');

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`ArcGIS fetch failed: ${resp.status} ${resp.statusText}`);

  const geojson = await resp.json();
  const districts = geojson.features.map(f => ({
    name: f.properties.NAME,
    type: f.properties.TYPE,
    geometry: f.geometry,
  }));

  console.log(`  Found ${districts.length} districts: ${districts.map(d => d.name).join(', ')}`);
  return districts;
}

// ─── CSV helpers ─────────────────────────────────────────────────────

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

const CSV_COLUMNS = ['parcel_number', 'address', 'latitude', 'longitude', 'property_class', 'historic_district', 'scraped'];

function csvRow(obj) {
  return CSV_COLUMNS.map(col => csvEscape(obj[col])).join(',');
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log('Generate Parcels for CityView Scraping');
  console.log('======================================\n');

  // Open tax_appeal_app DB
  console.log(`Tax appeal DB: ${opts.db}`);
  if (!fs.existsSync(opts.db)) {
    console.error(`Database not found: ${opts.db}`);
    process.exit(1);
  }

  const db = new DatabaseSync(opts.db, { open: true, readOnly: true });

  // Query all Oak Park residential properties
  const placeholders = opts.classes.map(() => '?').join(',');
  const query = `
    SELECT
      av.pin,
      av.class,
      ap.address,
      ap.lat,
      ap.lon
    FROM assessed_values av
    LEFT JOIN address_points ap ON av.pin = ap.pin
    WHERE av.township_name = 'Oak Park'
      AND av.year = ?
      AND av.class IN (${placeholders})
    ORDER BY ap.address
  `;

  const rows = db.prepare(query).all(opts.year, ...opts.classes);
  db.close();

  console.log(`Found ${rows.length} Oak Park residential properties (year ${opts.year}, classes: ${opts.classes.join(',')})\n`);

  if (rows.length === 0) {
    console.log('No properties found. Check --db, --year, and --classes.');
    process.exit(1);
  }

  // Fetch historic district polygons
  const districts = await fetchHistoricDistricts();

  // Point-in-polygon for each property
  console.log('\nClassifying historic districts...');
  const districtCounts = {};
  let noCoords = 0;

  const parcels = rows.map(row => {
    let historicDistrict = null;

    if (row.lat && row.lon) {
      historicDistrict = findHistoricDistrict(row.lon, row.lat, districts);
    } else {
      noCoords++;
    }

    if (historicDistrict) {
      districtCounts[historicDistrict] = (districtCounts[historicDistrict] || 0) + 1;
    }

    return {
      parcel_number: row.pin,
      address: row.address || '',
      latitude: row.lat || '',
      longitude: row.lon || '',
      property_class: row.class,
      historic_district: historicDistrict || '',
      scraped: 'false',
    };
  });

  // Summary
  console.log(`\nHistoric district breakdown:`);
  for (const [name, count] of Object.entries(districtCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name}: ${count}`);
  }
  const noDistrict = parcels.length - Object.values(districtCounts).reduce((a, b) => a + b, 0);
  console.log(`  (none): ${noDistrict}`);
  if (noCoords > 0) console.log(`  (no coordinates): ${noCoords}`);

  // Write CSV
  const lines = [CSV_COLUMNS.join(','), ...parcels.map(csvRow)];
  fs.writeFileSync(opts.output, lines.join('\n') + '\n');
  console.log(`\nWrote ${parcels.length} parcels to ${path.resolve(opts.output)}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
