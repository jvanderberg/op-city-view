#!/usr/bin/env node
/**
 * Oak Park CityView Portal - Residential Permit Data Exporter
 *
 * Exports permit, code enforcement, planning, and license data to SQLite.
 *
 * Data flow:
 *   1. Property LocationSearch API -> address autocomplete (JSON)
 *   2. Property LocateResults API -> parcel number from redirect URL (JSON)
 *   3. Module LocatorResults APIs -> list of reference numbers by parcel (JSON)
 *   4. StatusReference detail pages -> full record data + sub-permits + fees
 *
 * Usage:
 *   node export-permits.js --address "1010 S EUCLID AVE"
 *   node export-permits.js --street "GROVE AVE"
 *   node export-permits.js --file addresses.txt
 *   node export-permits.js --output oakpark.db
 *
 * Environment:
 *   CITYVIEW_EMAIL / CITYVIEW_PASSWORD - Login for authenticated access (permits)
 */

const { chromium } = require('playwright-core');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://villageview.oak-park.us';
const PORTAL = '/CityViewPortal';
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
const cityviewEmail = process.env.CITYVIEW_EMAIL;
const cityviewPassword = process.env.CITYVIEW_PASSWORD;

// ─── Schema ──────────────────────────────────────────────────────────

function initDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS properties (
      parcel_number TEXT PRIMARY KEY,
      address TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS applications (
      reference_number TEXT PRIMARY KEY,
      parcel_number TEXT NOT NULL REFERENCES properties(parcel_number),
      record_type TEXT NOT NULL,  -- 'Permit', 'Code Enforcement', 'Planning', 'License'
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

  return db;
}

// ─── CLI ─────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    addresses: [],
    street: null,
    file: null,
    output: 'cityview.db',
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
  node export-permits.js --address "1010 S EUCLID AVE"
  node export-permits.js --street "GROVE AVE"
  node export-permits.js --file addresses.txt
  node export-permits.js --output oakpark.db
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

// ─── Browser ─────────────────────────────────────────────────────────

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
    console.log('No credentials. Set CITYVIEW_EMAIL and CITYVIEW_PASSWORD for full access.\n');
    return false;
  }

  console.log('Logging in...');
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
    return body.includes('Sign Out') || body.includes('Log Off') || body.includes('Logoff');
  });

  console.log(loggedIn ? 'Login successful.\n' : 'Login may have failed.\n');
  return loggedIn;
}

// ─── API helpers ─────────────────────────────────────────────────────

function parseViewRefNumbers(viewHtml, idPrefix) {
  const refs = [];
  const re = new RegExp(`id="${idPrefix}(\\d+)" class="inputText"[^>]*>([^<]*)`, 'g');
  let m;
  while ((m = re.exec(viewHtml)) !== null) {
    const val = m[2].trim();
    if (val) refs.push(val);
  }
  return [...new Set(refs)];
}

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

async function getModuleRefs(page, modulePath, idPrefix, parcel) {
  const result = await callLocatorByParcel(page, modulePath, parcel);
  if (!result || !result.View) return [];
  return parseViewRefNumbers(result.View, idPrefix);
}

// Extract full detail from a StatusReference page: fields, sub-permits, fees
async function fetchFullDetail(page, modulePath, referenceNumber) {
  await page.goto(`${BASE_URL}${PORTAL}/${modulePath}/StatusReference?referenceNumber=${encodeURIComponent(referenceNumber)}`, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  return page.evaluate(() => {
    const result = { fields: {}, subPermits: [], fees: [], inspections: [], documents: [] };

    // Top-level displayFields (application summary)
    const summaryFieldset = document.querySelector('fieldset');
    if (summaryFieldset) {
      summaryFieldset.querySelectorAll('.displayField').forEach(f => {
        const label = f.querySelector('label');
        const value = f.querySelector('.inputText, .fieldData');
        if (label && value) {
          const l = label.textContent.trim().replace(/:$/, '');
          const v = value.textContent.trim();
          if (l && v) result.fields[l] = v;
        }
      });
    }

    // All fieldsets for sub-permits, fees, etc.
    document.querySelectorAll('fieldset').forEach(fs => {
      const legend = fs.querySelector('legend');
      if (!legend) return;
      const name = legend.textContent.trim();

      // Sub-permit sections: "Permit Number: XXX"
      if (name.startsWith('Permit Number:')) {
        const permit = { permitNumber: name.replace('Permit Number:', '').trim() };
        fs.querySelectorAll('.displayField').forEach(f => {
          const label = f.querySelector('label');
          const value = f.querySelector('.inputText, .fieldData');
          if (label && value) {
            const l = label.textContent.trim().replace(/:$/, '');
            const v = value.textContent.trim();
            if (l && v) permit[l] = v;
          }
        });
        result.subPermits.push(permit);
      }
    });

    // Fees table
    document.querySelectorAll('table').forEach(table => {
      const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim());
      if (!headers.some(h => h.includes('Fee') || h.includes('Amount'))) return;

      Array.from(table.rows).slice(1).forEach(row => {
        const cells = Array.from(row.cells).map(c => c.textContent.trim());
        if (cells.length < 3) return;
        if (cells[0].includes('Outstanding') || cells[0].includes('Totals')) return;

        const fee = {
          description: cells[0] || '',
          amount: cells[1] || '',
          paid: cells[2] || '',
          owing: cells[3] || '',
          datePaid: cells[4] || '',
        };
        if (fee.amount.includes('$')) result.fees.push(fee);
      });
    });

    // Inspections table — look for tables with inspection-related headers
    document.querySelectorAll('table').forEach(table => {
      const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim().toLowerCase());
      const isInspectionTable = headers.some(h =>
        h.includes('inspection') || h.includes('inspector') || h.includes('result')
      ) && !headers.some(h => h.includes('fee') || h.includes('amount'));
      if (!isInspectionTable) return;

      const headerNames = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim());
      Array.from(table.rows).slice(1).forEach(row => {
        const cells = Array.from(row.cells).map(c => c.textContent.trim());
        if (cells.length < 2) return;
        // Map cells to header names
        const entry = {};
        headerNames.forEach((h, i) => { if (cells[i]) entry[h] = cells[i]; });
        result.inspections.push(entry);
      });
    });

    // Documents table — look for tables with document-related headers or within Documents fieldsets
    document.querySelectorAll('fieldset').forEach(fs => {
      const legend = fs.querySelector('legend');
      if (!legend) return;
      const name = legend.textContent.trim().toLowerCase();
      if (!name.includes('document') && !name.includes('image')) return;

      fs.querySelectorAll('table').forEach(table => {
        const headerNames = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim());
        Array.from(table.rows).slice(1).forEach(row => {
          const cells = Array.from(row.cells).map(c => c.textContent.trim());
          if (cells.length < 1) return;
          const entry = {};
          headerNames.forEach((h, i) => { if (cells[i]) entry[h] = cells[i]; });
          result.documents.push(entry);
        });
      });
    });

    // Also check for document tables outside fieldsets
    if (result.documents.length === 0) {
      document.querySelectorAll('table').forEach(table => {
        const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim().toLowerCase());
        const isDocTable = headers.some(h => h.includes('document') || h.includes('file'));
        if (!isDocTable) return;

        const headerNames = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim());
        Array.from(table.rows).slice(1).forEach(row => {
          const cells = Array.from(row.cells).map(c => c.textContent.trim());
          if (cells.length < 1) return;
          const entry = {};
          headerNames.forEach((h, i) => { if (cells[i]) entry[h] = cells[i]; });
          result.documents.push(entry);
        });
      });
    }

    return result;
  });
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

// ─── DB writers ──────────────────────────────────────────────────────

function parseDollar(s) {
  if (!s) return null;
  const n = parseFloat(s.replace(/[$,]/g, ''));
  return isNaN(n) ? null : n;
}

function nullIfEmpty(s) {
  return s || null;
}

function insertProperty(db, parcel, address) {
  db.prepare(`INSERT OR IGNORE INTO properties (parcel_number, address) VALUES (?, ?)`)
    .run(parcel, address);
}

function insertApplication(db, app) {
  db.prepare(`INSERT OR REPLACE INTO applications
    (reference_number, parcel_number, record_type, application_type, work_class,
     status, description, application_date, issued_date, expiration_date, date_finaled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      app.referenceNumber, app.parcelNumber, app.recordType,
      nullIfEmpty(app.applicationType), nullIfEmpty(app.workClass),
      nullIfEmpty(app.status), nullIfEmpty(app.description),
      nullIfEmpty(app.applicationDate), nullIfEmpty(app.issuedDate),
      nullIfEmpty(app.expirationDate), nullIfEmpty(app.dateFinaled),
    );
}

function insertSubPermit(db, sp) {
  db.prepare(`INSERT OR REPLACE INTO sub_permits
    (permit_number, application_number, permit_type, permit_status, date_issued, expiration_date)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      sp.permitNumber, sp.applicationNumber,
      nullIfEmpty(sp.permitType), nullIfEmpty(sp.permitStatus),
      nullIfEmpty(sp.dateIssued), nullIfEmpty(sp.expirationDate),
    );
}

function insertFee(db, fee) {
  db.prepare(`INSERT INTO fees
    (application_number, description, amount, paid, owing, date_paid)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      fee.applicationNumber, nullIfEmpty(fee.description),
      parseDollar(fee.amount), parseDollar(fee.paid),
      parseDollar(fee.owing), nullIfEmpty(fee.datePaid),
    );
}

function insertInspection(db, insp) {
  db.prepare(`INSERT INTO inspections
    (application_number, inspection_type, request_date, scheduled_date,
     completed_date, inspector, result, comments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      insp.applicationNumber,
      nullIfEmpty(insp.inspectionType), nullIfEmpty(insp.requestDate),
      nullIfEmpty(insp.scheduledDate), nullIfEmpty(insp.completedDate),
      nullIfEmpty(insp.inspector), nullIfEmpty(insp.result),
      nullIfEmpty(insp.comments),
    );
}

function insertDocument(db, doc) {
  db.prepare(`INSERT INTO documents
    (application_number, document_name, document_type, document_date)
    VALUES (?, ?, ?, ?)`)
    .run(
      doc.applicationNumber,
      nullIfEmpty(doc.documentName), nullIfEmpty(doc.documentType),
      nullIfEmpty(doc.documentDate),
    );
}

// ─── Module fetchers ─────────────────────────────────────────────────

async function fetchAndStoreComplaints(page, db, parcel) {
  const refs = await getModuleRefs(page, 'CodeEnforcement', 'caseNumber', parcel);
  for (const ref of refs) {
    const { fields, fees, inspections, documents } = await fetchFullDetail(page, 'CodeEnforcement', ref);
    const appNum = fields['Case Number'] || ref;

    insertApplication(db, {
      referenceNumber: appNum,
      parcelNumber: parcel,
      recordType: 'Code Enforcement',
      applicationType: fields['Complaint Type'],
      workClass: null,
      status: fields['Status'],
      description: fields['Description'],
      applicationDate: fields['Date Entered'],
      issuedDate: null,
      expirationDate: null,
      dateFinaled: null,
    });

    for (const fee of fees) {
      insertFee(db, {
        applicationNumber: appNum,
        description: fee.description,
        amount: fee.amount,
        paid: fee.paid,
        owing: fee.owing,
        datePaid: fee.datePaid,
      });
    }

    for (const insp of inspections) {
      insertInspection(db, {
        applicationNumber: appNum,
        inspectionType: insp['Inspection Type'] || insp['Type'] || '',
        requestDate: insp['Request Date'] || insp['Requested'] || '',
        scheduledDate: insp['Scheduled Date'] || insp['Scheduled'] || '',
        completedDate: insp['Completed Date'] || insp['Completed'] || insp['Date'] || '',
        inspector: insp['Inspector'] || '',
        result: insp['Result'] || insp['Status'] || '',
        comments: insp['Comments'] || insp['Notes'] || '',
      });
    }

    for (const doc of documents) {
      insertDocument(db, {
        applicationNumber: appNum,
        documentName: doc['Document Name'] || doc['File Name'] || doc['Name'] || doc['Description'] || '',
        documentType: doc['Document Type'] || doc['Type'] || doc['Category'] || '',
        documentDate: doc['Date'] || doc['Upload Date'] || doc['Document Date'] || '',
      });
    }
  }
  return refs.length;
}

async function fetchAndStorePermits(page, db, parcel) {
  const refs = await getModuleRefs(page, 'Permit', 'permitNumber', parcel);
  for (const ref of refs) {
    const { fields, subPermits, fees, inspections, documents } = await fetchFullDetail(page, 'Permit', ref);
    const appNum = fields['Application Number'] || ref;

    insertApplication(db, {
      referenceNumber: appNum,
      parcelNumber: parcel,
      recordType: 'Permit',
      applicationType: fields['Application Type'],
      workClass: fields['Category of Work'],
      status: fields['Application Status'],
      description: fields['Description of Work'],
      applicationDate: fields['Application Date'],
      issuedDate: fields['Issued Date'] || fields['Date Issued'],
      expirationDate: fields['Expiration Date'],
      dateFinaled: fields['Date Finaled'],
    });

    for (const sp of subPermits) {
      insertSubPermit(db, {
        permitNumber: sp.permitNumber,
        applicationNumber: appNum,
        permitType: sp['Permit Type'],
        permitStatus: sp['Permit Status'],
        dateIssued: sp['Date Issued'],
        expirationDate: sp['Expiration Date'],
      });
    }

    for (const fee of fees) {
      insertFee(db, {
        applicationNumber: appNum,
        description: fee.description,
        amount: fee.amount,
        paid: fee.paid,
        owing: fee.owing,
        datePaid: fee.datePaid,
      });
    }

    for (const insp of inspections) {
      insertInspection(db, {
        applicationNumber: appNum,
        inspectionType: insp['Inspection Type'] || insp['Type'] || '',
        requestDate: insp['Request Date'] || insp['Requested'] || '',
        scheduledDate: insp['Scheduled Date'] || insp['Scheduled'] || '',
        completedDate: insp['Completed Date'] || insp['Completed'] || insp['Date'] || '',
        inspector: insp['Inspector'] || '',
        result: insp['Result'] || insp['Status'] || '',
        comments: insp['Comments'] || insp['Notes'] || '',
      });
    }

    for (const doc of documents) {
      insertDocument(db, {
        applicationNumber: appNum,
        documentName: doc['Document Name'] || doc['File Name'] || doc['Name'] || doc['Description'] || '',
        documentType: doc['Document Type'] || doc['Type'] || doc['Category'] || '',
        documentDate: doc['Date'] || doc['Upload Date'] || doc['Document Date'] || '',
      });
    }
  }
  return refs.length;
}

async function fetchAndStorePlanning(page, db, parcel) {
  const refs = await getModuleRefs(page, 'Planning', 'applicationNumber', parcel);
  for (const ref of refs) {
    const { fields, fees, inspections, documents } = await fetchFullDetail(page, 'Planning', ref);
    const appNum = fields['Application Number'] || ref;

    insertApplication(db, {
      referenceNumber: appNum,
      parcelNumber: parcel,
      recordType: 'Planning',
      applicationType: fields['Application Type'] || fields['Type'],
      workClass: null,
      status: fields['Status'] || fields['Application Status'],
      description: fields['Description'],
      applicationDate: fields['Date Entered'] || fields['Application Date'],
      issuedDate: null,
      expirationDate: null,
      dateFinaled: null,
    });

    for (const fee of fees) {
      insertFee(db, {
        applicationNumber: appNum,
        description: fee.description,
        amount: fee.amount,
        paid: fee.paid,
        owing: fee.owing,
        datePaid: fee.datePaid,
      });
    }

    for (const insp of inspections) {
      insertInspection(db, {
        applicationNumber: appNum,
        inspectionType: insp['Inspection Type'] || insp['Type'] || '',
        requestDate: insp['Request Date'] || insp['Requested'] || '',
        scheduledDate: insp['Scheduled Date'] || insp['Scheduled'] || '',
        completedDate: insp['Completed Date'] || insp['Completed'] || insp['Date'] || '',
        inspector: insp['Inspector'] || '',
        result: insp['Result'] || insp['Status'] || '',
        comments: insp['Comments'] || insp['Notes'] || '',
      });
    }

    for (const doc of documents) {
      insertDocument(db, {
        applicationNumber: appNum,
        documentName: doc['Document Name'] || doc['File Name'] || doc['Name'] || doc['Description'] || '',
        documentType: doc['Document Type'] || doc['Type'] || doc['Category'] || '',
        documentDate: doc['Date'] || doc['Upload Date'] || doc['Document Date'] || '',
      });
    }
  }
  return refs.length;
}

async function fetchAndStoreLicenses(page, db, parcel) {
  const refs = await getModuleRefs(page, 'License', 'licenseNumber', parcel);
  for (const ref of refs) {
    const { fields, fees, inspections, documents } = await fetchFullDetail(page, 'License', ref);
    const appNum = fields['License Number'] || ref;

    insertApplication(db, {
      referenceNumber: appNum,
      parcelNumber: parcel,
      recordType: 'License',
      applicationType: fields['License Type'] || fields['Type'],
      workClass: null,
      status: fields['Status'],
      description: fields['Description'],
      applicationDate: fields['Date Entered'] || fields['Issue Date'],
      issuedDate: null,
      expirationDate: null,
      dateFinaled: null,
    });

    for (const fee of fees) {
      insertFee(db, {
        applicationNumber: appNum,
        description: fee.description,
        amount: fee.amount,
        paid: fee.paid,
        owing: fee.owing,
        datePaid: fee.datePaid,
      });
    }

    for (const insp of inspections) {
      insertInspection(db, {
        applicationNumber: appNum,
        inspectionType: insp['Inspection Type'] || insp['Type'] || '',
        requestDate: insp['Request Date'] || insp['Requested'] || '',
        scheduledDate: insp['Scheduled Date'] || insp['Scheduled'] || '',
        completedDate: insp['Completed Date'] || insp['Completed'] || insp['Date'] || '',
        inspector: insp['Inspector'] || '',
        result: insp['Result'] || insp['Status'] || '',
        comments: insp['Comments'] || insp['Notes'] || '',
      });
    }

    for (const doc of documents) {
      insertDocument(db, {
        applicationNumber: appNum,
        documentName: doc['Document Name'] || doc['File Name'] || doc['Name'] || doc['Description'] || '',
        documentType: doc['Document Type'] || doc['Type'] || doc['Category'] || '',
        documentDate: doc['Date'] || doc['Upload Date'] || doc['Document Date'] || '',
      });
    }
  }
  return refs.length;
}

// ─── Main ────────────────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const opts = parseArgs();

  console.log('Oak Park CityView Permit Exporter');
  console.log('==================================\n');

  const db = initDatabase(opts.output);
  console.log(`Database: ${path.resolve(opts.output)}\n`);

  const { browser, context } = await createBrowser();

  try {
    let page = await initPage(context);
    console.log('Connected to CityView portal.\n');

    const isAuthenticated = await login(page);

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
          if (!seen.has(addr)) { seen.add(addr); addresses.push(addr); newCount++; }
        }
        if (newCount > 0) console.log(`  "${term}" -> ${results.length} results (${newCount} new)`);
        await sleep(300);

        if (results.length >= 12) {
          for (let sub = 0; sub <= 9; sub++) {
            const subTerm = `${prefix}${sub} ${opts.street}`;
            const subResults = await searchAddresses(page, subTerm);
            let subNew = 0;
            for (const addr of subResults) {
              if (!seen.has(addr)) { seen.add(addr); addresses.push(addr); subNew++; }
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

    let processed = 0;

    for (const address of addresses) {
      processed++;
      console.log(`[${processed}/${addresses.length}] ${address}`);

      try {
        await page.goto(`${BASE_URL}${PORTAL}/Property`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForFunction(() => typeof window.jQuery !== 'undefined', { timeout: 10000 });
        const parcel = await getParcelNumber(page, address);

        if (!parcel) {
          console.log('  -> No property found');
          continue;
        }

        insertProperty(db, parcel, address);
        console.log(`  -> Parcel: ${parcel}`);

        const ce = await fetchAndStoreComplaints(page, db, parcel);
        if (ce > 0) console.log(`  -> ${ce} code enforcement`);

        if (isAuthenticated) {
          const permits = await fetchAndStorePermits(page, db, parcel);
          if (permits > 0) console.log(`  -> ${permits} permits`);
        }

        const planning = await fetchAndStorePlanning(page, db, parcel);
        if (planning > 0) console.log(`  -> ${planning} planning`);

        const licenses = await fetchAndStoreLicenses(page, db, parcel);
        if (licenses > 0) console.log(`  -> ${licenses} licenses`);
      } catch (e) {
        console.log(`  -> Error: ${e.message}`);
        try {
          page = await initPage(context);
          if (isAuthenticated) await login(page);
        } catch {
          page = await initPage(context);
        }
      }

      if (processed < addresses.length) await sleep(opts.delay);
    }

    // Summary
    const counts = {
      properties: db.prepare('SELECT COUNT(*) as n FROM properties').get().n,
      applications: db.prepare('SELECT COUNT(*) as n FROM applications').get().n,
      subPermits: db.prepare('SELECT COUNT(*) as n FROM sub_permits').get().n,
      fees: db.prepare('SELECT COUNT(*) as n FROM fees').get().n,
      inspections: db.prepare('SELECT COUNT(*) as n FROM inspections').get().n,
      documents: db.prepare('SELECT COUNT(*) as n FROM documents').get().n,
    };

    console.log(`\n==================================`);
    console.log(`Done! ${counts.properties} properties, ${counts.applications} applications, ${counts.subPermits} sub-permits, ${counts.fees} fees, ${counts.inspections} inspections, ${counts.documents} documents`);
    console.log(`Database: ${path.resolve(opts.output)}`);
  } finally {
    await browser.close();
    db.close();
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
