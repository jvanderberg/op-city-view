#!/usr/bin/env node
/**
 * Oak Park CityView Portal - Residential Permit Data Exporter
 *
 * Uses Playwright to call CityView portal's internal APIs to discover records,
 * then fetches full detail from each record's StatusReference page.
 *
 * Data flow:
 *   1. Property LocationSearch API -> address autocomplete (JSON)
 *   2. Property LocateResults API -> parcel number from redirect URL (JSON)
 *   3. Module LocatorResults APIs -> list of reference numbers (JSON + View)
 *   4. StatusReference detail pages -> full record data (displayField extraction)
 *
 * Usage:
 *   node export-permits.js --address "834 N AUSTIN BLVD"
 *   node export-permits.js --street "GROVE AVE"
 *   node export-permits.js --file addresses.txt
 *
 * Environment:
 *   CITYVIEW_EMAIL / CITYVIEW_PASSWORD - Login for authenticated access (permits)
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://villageview.oak-park.us';
const PORTAL = '/CityViewPortal';
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
const cityviewEmail = process.env.CITYVIEW_EMAIL;
const cityviewPassword = process.env.CITYVIEW_PASSWORD;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    addresses: [],
    street: null,
    file: null,
    output: 'permits-export.csv',
    delay: 1000,
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
  node export-permits.js --street "GROVE AVE"
  node export-permits.js --file addresses.txt
  node export-permits.js --output results.csv
  node export-permits.js --delay 2000`);
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

async function login(page) {
  if (!cityviewEmail || !cityviewPassword) {
    console.log('No credentials provided. Running unauthenticated (permits may be unavailable).');
    console.log('Set CITYVIEW_EMAIL and CITYVIEW_PASSWORD env vars for full access.\n');
    return false;
  }

  console.log('Logging in to CityView portal...');
  await page.goto(`${BASE_URL}${PORTAL}/Account/Logon`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('#emailAddress', cityviewEmail);
  await page.fill('#password', cityviewPassword);

  await Promise.all([
    page.waitForURL((url) => !url.href.includes('/Account/Logon'), { timeout: 30000 }).catch(() => {}),
    page.click('#bnext'),
  ]);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  const loggedIn = await page.evaluate(() => {
    const body = document.body.innerText;
    return body.includes('Log Off') || body.includes('Logoff') || !!document.querySelector('a[href*="Logoff"], a[href*="LogOff"]');
  });

  console.log(loggedIn ? 'Login successful.\n' : 'Login may have failed. Continuing anyway.\n');
  return loggedIn;
}

// ─── API helpers ──────────────────────────────────────────────────────

// Extract indexed field values from LocatorResults View HTML via regex
function parseViewRefNumbers(viewHtml, idPrefix) {
  const refs = [];
  const re = new RegExp(`id="${idPrefix}(\\d+)" class="inputText"[^>]*>([^<]*)`, 'g');
  let m;
  while ((m = re.exec(viewHtml)) !== null) {
    const val = m[2].trim();
    if (val) refs.push(val);
  }
  return [...new Set(refs)]; // deduplicate
}

// Call a module's LocatorResults API with a parcel number
async function callLocatorByParcel(page, modulePath, parcel) {
  await page.goto(`${BASE_URL}${PORTAL}/${modulePath}/Locator`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForFunction(() => typeof window.jQuery !== 'undefined', { timeout: 10000 });

  return page.evaluate(({ modulePath, searchValue }) => {
    return new Promise((resolve) => {
      jQuery.ajax({
        type: 'GET',
        url: `/CityViewPortal/${modulePath}/LocatorResults`,
        data: { searchValue },
        success: (data) => resolve(data),
        error: () => resolve(null),
      });
    });
  }, { modulePath, searchValue: parcel });
}

// Extract all displayField label:value pairs from the current page
async function extractDisplayFields(page) {
  return page.evaluate(() => {
    const fields = {};
    document.querySelectorAll('.displayField').forEach(f => {
      const label = f.querySelector('label');
      const value = f.querySelector('.inputText, .fieldData');
      if (label && value) {
        const l = label.textContent.trim().replace(/:$/, '');
        const v = value.textContent.trim();
        if (l && v) fields[l] = v;
      }
    });
    return fields;
  });
}

// Fetch full detail from a StatusReference page
async function fetchStatusDetail(page, modulePath, referenceNumber) {
  await page.goto(`${BASE_URL}${PORTAL}/${modulePath}/StatusReference?referenceNumber=${encodeURIComponent(referenceNumber)}`, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  return extractDisplayFields(page);
}

// ─── Address search ──────────────────────────────────────────────────

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
        error: () => resolve([]),
      });
    });
  }, term);
}

async function getParcelNumber(page, address) {
  const result = await page.evaluate((addr) => {
    return new Promise((resolve) => {
      jQuery.ajax({
        type: 'GET',
        url: '/CityViewPortal/Property/LocateResults',
        data: { locationDesc: addr },
        success: (data) => resolve(data),
        error: () => resolve(null),
      });
    });
  }, address);

  if (!result || !result.RedirectUrl) return null;
  const match = result.RedirectUrl.match(/searchValue=PRO(\d+)/);
  return match ? match[1] : null;
}

// ─── Module fetchers ─────────────────────────────────────────────────

// Get all unique reference numbers for a module by searching by parcel
async function getModuleRefs(page, modulePath, idPrefix, parcel) {
  const result = await callLocatorByParcel(page, modulePath, parcel);
  if (!result || !result.View) return [];
  return parseViewRefNumbers(result.View, idPrefix);
}

async function fetchComplaints(page, parcel) {
  const refs = await getModuleRefs(page, 'CodeEnforcement', 'caseNumber', parcel);
  const records = [];
  for (const ref of refs) {
    const fields = await fetchStatusDetail(page, 'CodeEnforcement', ref);
    records.push({
      RecordType: 'Code Enforcement',
      ReferenceNumber: fields['Case Number'] || ref,
      Type: fields['Complaint Type'] || '',
      Status: fields['Status'] || '',
      Date: fields['Date Entered'] || '',
      Description: fields['Description'] || '',
    });
  }
  return records;
}

async function fetchPermits(page, parcel) {
  const refs = await getModuleRefs(page, 'Permit', 'permitNumber', parcel);
  const records = [];
  for (const ref of refs) {
    const fields = await fetchStatusDetail(page, 'Permit', ref);
    records.push({
      RecordType: 'Permit',
      ReferenceNumber: fields['Application Number'] || ref,
      Type: fields['Application Type'] || '',
      WorkClass: fields['Category of Work'] || '',
      Status: fields['Application Status'] || '',
      DateIssued: fields['Issued Date'] || fields['Date Issued'] || '',
      ApplicationDate: fields['Application Date'] || '',
      ExpirationDate: fields['Expiration Date'] || '',
      DateFinaled: fields['Date Finaled'] || '',
      PermitType: fields['Permit Type'] || '',
      PermitStatus: fields['Permit Status'] || '',
      Description: fields['Description of Work'] || '',
    });
  }
  return records;
}

async function fetchPlanning(page, parcel) {
  const refs = await getModuleRefs(page, 'Planning', 'applicationNumber', parcel);
  const records = [];
  for (const ref of refs) {
    const fields = await fetchStatusDetail(page, 'Planning', ref);
    records.push({
      RecordType: 'Planning',
      ReferenceNumber: fields['Application Number'] || ref,
      Type: fields['Application Type'] || fields['Type'] || '',
      Status: fields['Status'] || fields['Application Status'] || '',
      Date: fields['Date Entered'] || fields['Application Date'] || '',
      Description: fields['Description'] || '',
    });
  }
  return records;
}

async function fetchLicenses(page, parcel) {
  const refs = await getModuleRefs(page, 'License', 'licenseNumber', parcel);
  const records = [];
  for (const ref of refs) {
    const fields = await fetchStatusDetail(page, 'License', ref);
    records.push({
      RecordType: 'License',
      ReferenceNumber: fields['License Number'] || ref,
      Type: fields['License Type'] || fields['Type'] || '',
      Status: fields['Status'] || '',
      Date: fields['Date Entered'] || fields['Issue Date'] || '',
      Description: fields['Description'] || '',
    });
  }
  return records;
}

// ─── CSV output ──────────────────────────────────────────────────────

const CSV_HEADERS = [
  'Address', 'ParcelNumber', 'RecordType', 'ReferenceNumber', 'Type',
  'WorkClass', 'Status', 'ApplicationDate', 'DateIssued', 'ExpirationDate',
  'DateFinaled', 'PermitType', 'PermitStatus', 'Date', 'Description',
];

function escapeCSV(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function writeCSVHeader(filePath) {
  fs.writeFileSync(filePath, CSV_HEADERS.join(',') + '\n');
}

function appendCSVRows(filePath, rows) {
  const lines = rows.map(row => CSV_HEADERS.map(h => escapeCSV(row[h])).join(','));
  fs.appendFileSync(filePath, lines.join('\n') + '\n');
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log('Oak Park CityView Permit Exporter');
  console.log('==================================\n');

  const { browser, context } = await createBrowser();

  try {
    let page = await initPage(context);
    console.log('Connected to CityView portal.\n');

    const isAuthenticated = await login(page);

    // Navigate to Property search
    await page.goto(`${BASE_URL}${PORTAL}/Property`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForFunction(() => typeof window.jQuery !== 'undefined', { timeout: 10000 });

    let addresses = [...opts.addresses];

    if (opts.street) {
      console.log(`Searching for all addresses on "${opts.street}"...`);
      const seen = new Set();
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
        if (newCount > 0) console.log(`  "${term}" -> ${results.length} results (${newCount} new)`);
        await sleep(300);

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
            if (subNew > 0) console.log(`  "${subTerm}" -> ${subResults.length} results (${subNew} new)`);
            await sleep(300);
          }
        }
      }
      console.log(`Total unique addresses found: ${addresses.length}`);
    }

    if (addresses.length === 0) {
      console.log('No addresses specified. Use --address, --street, or --file.');
      await browser.close();
      return;
    }

    writeCSVHeader(opts.output);
    console.log(`Writing results to: ${opts.output}\n`);

    let processed = 0;
    let totalRecords = 0;

    for (const address of addresses) {
      processed++;
      console.log(`[${processed}/${addresses.length}] Processing: ${address}`);

      try {
        // Get parcel number via Property API
        await page.goto(`${BASE_URL}${PORTAL}/Property`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForFunction(() => typeof window.jQuery !== 'undefined', { timeout: 10000 });
        const parcel = await getParcelNumber(page, address);

        if (!parcel) {
          console.log('  -> No property found');
          appendCSVRows(opts.output, [{ Address: address, RecordType: 'Not Found' }]);
          continue;
        }

        console.log(`  -> Parcel: ${parcel}`);
        const baseFields = { Address: address, ParcelNumber: parcel };
        const rows = [];

        // Code Enforcement via API + StatusReference detail
        const complaints = await fetchComplaints(page, parcel);
        console.log(`  -> ${complaints.length} code enforcement records`);
        for (const c of complaints) rows.push({ ...baseFields, ...c });

        // Permits via API + StatusReference detail (requires auth)
        if (isAuthenticated) {
          const permits = await fetchPermits(page, parcel);
          console.log(`  -> ${permits.length} permit records`);
          for (const p of permits) rows.push({ ...baseFields, ...p });
        }

        // Planning via API + StatusReference detail
        const planning = await fetchPlanning(page, parcel);
        if (planning.length > 0) console.log(`  -> ${planning.length} planning records`);
        for (const p of planning) rows.push({ ...baseFields, ...p });

        // Licenses via API + StatusReference detail
        const licenses = await fetchLicenses(page, parcel);
        if (licenses.length > 0) console.log(`  -> ${licenses.length} license records`);
        for (const l of licenses) rows.push({ ...baseFields, ...l });

        if (rows.length === 0) {
          rows.push({ ...baseFields, RecordType: 'None' });
        }

        appendCSVRows(opts.output, rows);
        totalRecords += rows.length;
      } catch (e) {
        console.log(`  -> Error: ${e.message}`);
        appendCSVRows(opts.output, [{ Address: address, RecordType: 'Error', Description: e.message }]);

        try {
          page = await initPage(context);
          if (isAuthenticated) await login(page);
        } catch {
          page = await initPage(context);
        }
      }

      if (processed < addresses.length) await sleep(opts.delay);
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
