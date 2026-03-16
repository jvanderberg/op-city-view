#!/usr/bin/env node
/**
 * Oak Park CityView Portal - Residential Permit Data Exporter
 *
 * Uses Playwright to interact with the CityView portal's internal APIs
 * to search for properties by address and export permit/complaint/license data.
 *
 * Usage:
 *   node export-permits.js --address "834 N AUSTIN BLVD"
 *   node export-permits.js --street "GROVE AVE"
 *   node export-permits.js --file addresses.txt
 *   node export-permits.js --range "100-200 N AUSTIN BLVD"
 *
 * Output: CSV file with all permit, complaint, license, and planning records.
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://villageview.oak-park.us';
const PORTAL = '/CityViewPortal';
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;

// Parse command-line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    addresses: [],
    street: null,
    file: null,
    output: 'permits-export.csv',
    delay: 1000, // ms between requests
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--address': case '-a':
        opts.addresses.push(args[++i]);
        break;
      case '--street': case '-s':
        opts.street = args[++i];
        break;
      case '--file': case '-f':
        opts.file = args[++i];
        break;
      case '--output': case '-o':
        opts.output = args[++i];
        break;
      case '--delay':
        opts.delay = parseInt(args[++i], 10);
        break;
      case '--help': case '-h':
        console.log(`Usage:
  node export-permits.js --address "834 N AUSTIN BLVD"
  node export-permits.js --street "GROVE AVE"           # Search all addresses on a street
  node export-permits.js --file addresses.txt           # One address per line
  node export-permits.js --output results.csv           # Output file (default: permits-export.csv)
  node export-permits.js --delay 2000                   # Delay between requests in ms`);
        process.exit(0);
    }
  }

  if (opts.file) {
    const content = fs.readFileSync(opts.file, 'utf-8');
    opts.addresses.push(...content.split('\n').map(l => l.trim()).filter(Boolean));
  }

  return opts;
}

async function createBrowser() {
  const launchOptions = {
    headless: true,
    executablePath: '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome',
  };
  if (proxyUrl) {
    const parsed = new URL(proxyUrl);
    launchOptions.proxy = {
      server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
      username: parsed.username,
      password: parsed.password,
    };
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  return { browser, context };
}

async function initPage(context) {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}${PORTAL}/Property`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForFunction(() => typeof window.jQuery !== 'undefined', { timeout: 10000 });
  return page;
}

// Search for addresses matching a term
async function searchAddresses(page, term) {
  return page.evaluate((t) => {
    return new Promise((resolve) => {
      const token = jQuery('input[name="__RequestVerificationToken"]').val();
      jQuery.ajax({
        type: 'POST',
        url: '/CityViewPortal/Property/LocationSearch',
        dataType: 'json',
        headers: { __RequestVerificationToken: token },
        data: {
          term: t,
          returnInactiveAddresses: false,
          module: '',
          returnParcelNumbers: true,
          appealPeriodStatusesOnly: false,
          returnParksRoadsAndTrails: false,
          locationCodeToAutosuggest: '',
          isIntermentSearch: false,
        },
        success: (data) => {
          let results = typeof data === 'string' ? JSON.parse(data) : data;
          if (typeof results === 'string') results = JSON.parse(results);
          resolve(results);
        },
        error: (xhr) => resolve([]),
      });
    });
  }, term);
}

// Get the property review URL for a specific address
async function getPropertyUrl(page, address) {
  return page.evaluate((addr) => {
    return new Promise((resolve) => {
      jQuery.ajax({
        type: 'GET',
        url: '/CityViewPortal/Property/LocateResults',
        data: { locationDesc: addr },
        success: (data) => resolve(data.RedirectUrl || null),
        error: () => resolve(null),
      });
    });
  }, address);
}

// Extract all data from a property review page
async function extractPropertyData(page, url) {
  await page.goto(`${BASE_URL}${url}`, { waitUntil: 'networkidle', timeout: 30000 });

  return page.evaluate(() => {
    const result = {
      parcelNumber: '',
      status: '',
      legalDescription: '',
      addresses: [],
      zones: [],
      complaints: [],
      licenses: [],
      permits: [],
      engineeringPermits: [],
      planningApps: [],
    };

    // Property details
    const detailFields = document.querySelectorAll('.displayField');
    detailFields.forEach(f => {
      const label = f.querySelector('.cv-label, label');
      const value = f.querySelector('.cv-value, .fieldData, span:last-child');
      if (label && value) {
        const l = label.textContent.trim().replace(':', '');
        const v = value.textContent.trim();
        if (l.includes('Parcel')) result.parcelNumber = v;
        if (l.includes('Status')) result.status = v;
        if (l.includes('Legal')) result.legalDescription = v;
      }
    });

    // Fallback: get parcel from page text
    if (!result.parcelNumber) {
      const match = document.body.innerText.match(/Parcel Number:\s*(\d+)/);
      if (match) result.parcelNumber = match[1];
    }

    // Addresses table
    const addrTable = document.getElementById('propertyAddresses');
    if (addrTable) {
      Array.from(addrTable.rows).slice(1).forEach(row => {
        const cells = Array.from(row.cells).map(c => c.textContent.trim());
        if (cells.length >= 4) {
          result.addresses.push({
            streetNumber: cells[0],
            preDirection: cells[1],
            streetName: cells[2],
            direction: cells[3],
            unit: cells[4] || '',
            status: cells[5] || '',
          });
        }
      });
    }

    // Parse all tables generically by section
    const fieldsets = document.querySelectorAll('fieldset, .accordion');
    fieldsets.forEach(fs => {
      const legend = fs.querySelector('legend, h3, h4');
      if (!legend) return;
      const sectionName = legend.textContent.trim();
      const table = fs.querySelector('table');

      if (!table) return;

      const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim());
      const rows = [];

      Array.from(table.rows).slice(1).forEach(row => {
        const cells = Array.from(row.cells).map(c => c.textContent.trim());
        if (cells.length > 0) {
          // Description rows have fewer cells (usually merged/colspan) and contain "Description:"
          const fullText = cells.join(' ');
          if (cells.length < headers.length || fullText.includes('Description:')) {
            if (rows.length > 0) {
              rows[rows.length - 1].Description = fullText.replace(/^[\s]*Description:[\s]*/i, '').replace(/\s+/g, ' ').trim();
            }
          } else {
            const rowData = {};
            headers.forEach((h, i) => { rowData[h] = cells[i] || ''; });
            rows.push(rowData);
          }
        }
      });

      if (sectionName.includes('Code Enforcement') || sectionName.includes('Complaint')) {
        result.complaints.push(...rows);
      } else if (sectionName.includes('License')) {
        result.licenses.push(...rows);
      } else if (sectionName.includes('Engineering')) {
        result.engineeringPermits.push(...rows);
      } else if (sectionName.includes('Permit')) {
        result.permits.push(...rows);
      } else if (sectionName.includes('Planning')) {
        result.planningApps.push(...rows);
      }
    });

    // Also try generic approach - grab all tables with known headers
    document.querySelectorAll('table').forEach(table => {
      const id = table.id;
      if (id === 'propertyAddresses' || id === 'propertyContacts') return;

      const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim());
      if (headers.includes('Permit Number') || headers.includes('Application Number')) {
        Array.from(table.rows).slice(1).forEach(row => {
          const cells = Array.from(row.cells).map(c => c.textContent.trim());
          if (cells.length >= headers.length) {
            const rowData = {};
            headers.forEach((h, i) => { rowData[h] = cells[i] || ''; });
            // Add to permits if not already captured
            const existing = [...result.permits, ...result.engineeringPermits, ...result.planningApps];
            const isDuplicate = existing.some(r =>
              (r['Permit Number'] === rowData['Permit Number'] && rowData['Permit Number']) ||
              (r['Application Number'] === rowData['Application Number'] && rowData['Application Number'])
            );
            if (!isDuplicate) result.permits.push(rowData);
          }
        });
      }
    });

    return result;
  });
}

// Flatten property data into CSV rows
function flattenToCSVRows(address, data) {
  const rows = [];
  const baseFields = {
    Address: address,
    ParcelNumber: data.parcelNumber,
    PropertyStatus: data.status,
  };

  // Add complaint records
  data.complaints.forEach(c => {
    rows.push({
      ...baseFields,
      RecordType: 'Code Enforcement',
      ReferenceNumber: c['Case Number'] || '',
      Type: c['Type'] || '',
      Status: c['Status'] || '',
      Date: c['Date Entered'] || '',
      Description: (c['Description'] || '').replace(/[\n\r]+/g, ' ').trim(),
    });
  });

  // Add permit records
  data.permits.forEach(p => {
    rows.push({
      ...baseFields,
      RecordType: 'Permit',
      ReferenceNumber: p['Permit Number'] || p['Application Number'] || '',
      Type: p['Type'] || p['Permit Type'] || '',
      Status: p['Status'] || '',
      Date: p['Date Entered'] || p['Date'] || p['Application Date'] || '',
      Description: (p['Description'] || p['Work Description'] || '').replace(/[\n\r]+/g, ' ').trim(),
    });
  });

  // Add engineering permits
  data.engineeringPermits.forEach(p => {
    rows.push({
      ...baseFields,
      RecordType: 'Engineering Permit',
      ReferenceNumber: p['Permit Number'] || p['Application Number'] || '',
      Type: p['Type'] || '',
      Status: p['Status'] || '',
      Date: p['Date Entered'] || p['Date'] || '',
      Description: (p['Description'] || '').replace(/[\n\r]+/g, ' ').trim(),
    });
  });

  // Add license records
  data.licenses.forEach(l => {
    rows.push({
      ...baseFields,
      RecordType: 'License',
      ReferenceNumber: l['License Number'] || l['Application Number'] || '',
      Type: l['Type'] || '',
      Status: l['Status'] || '',
      Date: l['Date Entered'] || l['Date'] || '',
      Description: (l['Description'] || '').replace(/[\n\r]+/g, ' ').trim(),
    });
  });

  // Add planning records
  data.planningApps.forEach(p => {
    rows.push({
      ...baseFields,
      RecordType: 'Planning',
      ReferenceNumber: p['Application Number'] || '',
      Type: p['Type'] || '',
      Status: p['Status'] || '',
      Date: p['Date Entered'] || p['Date'] || '',
      Description: (p['Description'] || '').replace(/[\n\r]+/g, ' ').trim(),
    });
  });

  // If no records, add a row indicating empty
  if (rows.length === 0) {
    rows.push({
      ...baseFields,
      RecordType: 'None',
      ReferenceNumber: '',
      Type: '',
      Status: '',
      Date: '',
      Description: 'No records found',
    });
  }

  return rows;
}

function escapeCSV(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function writeCSVHeader(filePath) {
  const headers = ['Address', 'ParcelNumber', 'PropertyStatus', 'RecordType', 'ReferenceNumber', 'Type', 'Status', 'Date', 'Description'];
  fs.writeFileSync(filePath, headers.join(',') + '\n');
}

function appendCSVRows(filePath, rows) {
  const headers = ['Address', 'ParcelNumber', 'PropertyStatus', 'RecordType', 'ReferenceNumber', 'Type', 'Status', 'Date', 'Description'];
  const lines = rows.map(row => headers.map(h => escapeCSV(row[h])).join(','));
  fs.appendFileSync(filePath, lines.join('\n') + '\n');
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const opts = parseArgs();

  console.log('Oak Park CityView Permit Exporter');
  console.log('==================================\n');

  const { browser, context } = await createBrowser();

  try {
    let page = await initPage(context);
    console.log('Connected to CityView portal.\n');

    let addresses = [...opts.addresses];

    // If street search, find all addresses on that street using multiple prefix queries
    // The autocomplete returns max ~12 results per query, so we search with different
    // number prefixes to get comprehensive coverage.
    if (opts.street) {
      console.log(`Searching for all addresses on "${opts.street}"...`);
      const seen = new Set();
      // Search with each leading digit (1-9) and double-digit prefixes
      const prefixes = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
      for (let d = 10; d <= 19; d++) prefixes.push(String(d));

      for (const prefix of prefixes) {
        const term = `${prefix} ${opts.street}`;
        const results = await searchAddresses(page, term);
        let newCount = 0;
        for (const addr of results) {
          if (!seen.has(addr)) {
            seen.add(addr);
            addresses.push(addr);
            newCount++;
          }
        }
        if (newCount > 0) {
          console.log(`  "${term}" -> ${results.length} results (${newCount} new)`);
        }
        await sleep(300);

        // If this prefix returned 12 results, search deeper with sub-prefixes
        if (results.length >= 12) {
          for (let sub = 0; sub <= 9; sub++) {
            const subTerm = `${prefix}${sub} ${opts.street}`;
            const subResults = await searchAddresses(page, subTerm);
            let subNew = 0;
            for (const addr of subResults) {
              if (!seen.has(addr)) {
                seen.add(addr);
                addresses.push(addr);
                subNew++;
              }
            }
            if (subNew > 0) {
              console.log(`  "${subTerm}" -> ${subResults.length} results (${subNew} new)`);
            }
            await sleep(300);
          }
        }
      }
      console.log(`Total unique addresses found: ${addresses.length}`);
    }

    // If no addresses specified, show help
    if (addresses.length === 0) {
      console.log('No addresses specified. Use --address, --street, or --file.\n');
      console.log('Example: node export-permits.js --street "GROVE AVE"');
      console.log('         node export-permits.js --address "834 N AUSTIN BLVD OAK PARK IL 60302"');
      await browser.close();
      return;
    }

    // Initialize CSV
    writeCSVHeader(opts.output);
    console.log(`Writing results to: ${opts.output}\n`);

    let processed = 0;
    let totalRecords = 0;

    for (const address of addresses) {
      processed++;
      console.log(`[${processed}/${addresses.length}] Processing: ${address}`);

      try {
        // Get property review URL
        const reviewUrl = await getPropertyUrl(page, address);
        if (!reviewUrl) {
          console.log('  -> No property found, skipping');
          appendCSVRows(opts.output, [{ Address: address, ParcelNumber: '', PropertyStatus: '', RecordType: 'Not Found', ReferenceNumber: '', Type: '', Status: '', Date: '', Description: 'Property not found' }]);
          continue;
        }

        // Extract property data
        const data = await extractPropertyData(page, reviewUrl);
        const totalForProperty = data.complaints.length + data.permits.length + data.engineeringPermits.length + data.licenses.length + data.planningApps.length;
        console.log(`  -> Parcel: ${data.parcelNumber} | ${totalForProperty} records (${data.complaints.length} complaints, ${data.permits.length} permits, ${data.engineeringPermits.length} eng permits, ${data.licenses.length} licenses, ${data.planningApps.length} planning)`);

        // Flatten and write
        const rows = flattenToCSVRows(address, data);
        appendCSVRows(opts.output, rows);
        totalRecords += rows.length;

        // Navigate back to search page for next search
        await page.goto(`${BASE_URL}${PORTAL}/Property`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForFunction(() => typeof window.jQuery !== 'undefined', { timeout: 10000 });
      } catch (e) {
        console.log(`  -> Error: ${e.message}`);
        appendCSVRows(opts.output, [{ Address: address, ParcelNumber: '', PropertyStatus: '', RecordType: 'Error', ReferenceNumber: '', Type: '', Status: '', Date: '', Description: e.message }]);

        // Reinitialize page on error
        try {
          await page.goto(`${BASE_URL}${PORTAL}/Property`, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForFunction(() => typeof window.jQuery !== 'undefined', { timeout: 10000 });
        } catch {
          // If page is completely broken, create a new one
          const newPage = await initPage(context);
          page = newPage;
        }
      }

      // Rate limiting
      if (processed < addresses.length) {
        await sleep(opts.delay);
      }
    }

    console.log(`\n==================================`);
    console.log(`Done! Processed ${processed} addresses, exported ${totalRecords} records.`);
    console.log(`Output: ${path.resolve(opts.output)}`);
  } finally {
    await browser.close();
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
