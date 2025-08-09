// index.js
require('dotenv/config');
const express = require('express');
const dayjs = require('dayjs');
const { DAVClient, fetchCalendars, fetchCalendarObjects, createObject, updateObject } = require('tsdav');

const app = express();
app.use(express.json({ type: '*/*' })); // accept Square's JSON

// ---- ENV ----
const {
  SQUARE_ACCESS_TOKEN,
  SQUARE_API_VERSION = '2025-03-19',
  ICLOUD_USERNAME,             // Apple ID email
  ICLOUD_APP_PASSWORD,         // App-specific password from Apple
  ICLOUD_CALENDAR_NAME = 'Lil’s Bookings'
} = process.env;

const required = ['SQUARE_ACCESS_TOKEN','SQUARE_API_VERSION','ICLOUD_USERNAME','ICLOUD_APP_PASSWORD'];
console.log('[ENV] Loaded:', required.map(k => `${k}=${process.env[k] ? '✓' : '✗'}`).join('  '));

// ---- Square helpers ----
const BASE = 'https://connect.squareup.com/v2';
function authHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
    'Square-Version': SQUARE_API_VERSION,
    'Content-Type': 'application/json'
  };
}
async function getJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}
function formatAddress(addr) {
  if (!addr) return '';
  const parts = [
    addr.address_line_1,
    addr.locality,
    addr.administrative_district_level_1,
    addr.postal_code,
    addr.country
  ].filter(Boolean);
  return parts.join(', ');
}
async function fetchBooking(bookingId) {
  const res = await fetch(`${BASE}/bookings/${bookingId}`, { headers: authHeaders() });
  const body = await getJson(res);
  if (!res.ok) throw body;
  return body.booking;
}
async function fetchCustomer(customerId) {
  const res = await fetch(`${BASE}/customers/${customerId}`, { headers: authHeaders() });
  const body = await getJson(res);
  if (!res.ok) throw body;
  return body.customer;
}

// ---- ICS helpers ----
function toICSDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) + 'Z'
  );
}
function icsEscape(s = '') {
  return String(s).replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
}
function buildICS({ uid, summary, location, description, start, end }) {
  const now = toICSDate(new Date().toISOString());
  const dtStart = toICSDate(start);
  const dtEnd = toICSDate(end);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lils Ice Cream//Bookings//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsEscape(uid)}`,
    `DTSTAMP:${now}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${icsEscape(summary)}`,
    `LOCATION:${icsEscape(location)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    'END:VEVENT',
    'END:VCALENDAR',
    ''
  ].join('\r\n');
}

// ---- iCloud CalDAV helpers ----
async function getIcloudCalendar() {
  const client = new DAVClient({
    serverUrl: 'https://caldav.icloud.com',
    credentials: { username: ICLOUD_USERNAME, password: ICLOUD_APP_PASSWORD },
    authMethod: 'Basic',
    defaultAccountType: 'caldav'
  });

  await client.login();

  // ✅ REQUIRED: initialize a CalDAV account on the client
  await client.createAccount({
    account: {
      serverUrl: 'https://caldav.icloud.com',
      accountType: 'caldav',
      rootUrl: 'https://caldav.icloud.com'
    }
  });

  // Now you can fetch calendars from the initialized account
  const calendars = await client.fetchCalendars();
  if (!calendars || calendars.length === 0) {
    throw new Error('Could not fetch iCloud calendars. Check ICLOUD_USERNAME / ICLOUD_APP_PASSWORD and that Calendar is enabled.');
  }

  const target =
    calendars.find(c => (c.displayName || '').trim() === (ICLOUD_CALENDAR_NAME || '').trim()) ||
    calendars[0];

  return { client, calendar: target };
}

function ensureAbsoluteUrl(u) {
  if (!u) return null;
  // If it's an object (some tsdav versions), try .href or .toString()
  if (typeof u === 'object') {
    if (typeof u.href === 'string') u = u.href;
    else u = String(u);
  }
  // Make it absolute
  return /^https?:\/\//i.test(u) ? u : `https://caldav.icloud.com${u}`;
}

async function upsertIcloudEvent({ uid, ics }) {
  const { client, calendar } = await getIcloudCalendar();
  const filename = `${uid}.ics`;

  // Normalize calendar URL to a plain absolute string
  let rawCalUrl = calendar.url ?? calendar.href ?? calendar?.url?.href;
  const calUrl = ensureAbsoluteUrl(rawCalUrl);
  if (!calUrl) {
    throw new Error('iCloud calendar URL missing; cannot create/update event.');
  }

  // Use a minimal calendar descriptor with a clean absolute url
  const cal = { url: calUrl };

  // List existing objects
  const objects = await fetchCalendarObjects({ client, calendar: cal });

  // Compare by filename; normalize each object URL too
  const existing = (objects || []).find(o => {
    const objRaw = o.url ?? o.href ?? o?.url?.href;
    const objUrl = ensureAbsoluteUrl(objRaw);
    return objUrl && objUrl.endsWith(`/${filename}`);
  });

  if (!existing) {
    await createObject({ client, calendar: cal, filename, iCalString: ics });
    console.log(`Created iCloud event: ${filename}`);
  } else {
    const existingUrl = ensureAbsoluteUrl(existing.url ?? existing.href ?? existing?.url?.href);
    await updateObject({
      client,
      calendarObject: { ...existing, url: existingUrl },
      iCalString: ics
    });
    console.log(`Updated iCloud event: ${filename}`);
  }
}

// ---- Booking -> Calendar
async function processBooking(bookingId) {
  const booking = await fetchBooking(bookingId);
  const startISO = booking.start_at;
  const durMin = booking.appointment_segments?.[0]?.duration_minutes ?? 60;
  const endISO = dayjs(startISO).add(durMin, 'minute').toISOString();

  let first = '', last = '', addressLine = 'TBD';
  if (booking.customer_id) {
    try {
      const customer = await fetchCustomer(booking.customer_id);
      first = customer.given_name || '';
      last  = customer.family_name || '';
      addressLine = formatAddress(customer.address) || 'TBD';
    } catch (e) {
      console.warn('Customer lookup failed:', e);
    }
  }

  const fullName = `${first} ${last}`.trim() || 'Customer';
  const summary = `Truck Event – ${fullName}`;
  const description = `Square: https://squareup.com/dashboard/appointments (Booking ID: ${booking.id})`;
  const uid = `${booking.id}@lilsicecream`;

  const ics = buildICS({
    uid,
    summary,
    location: addressLine,
    description,
    start: startISO,
    end: endISO
  });

  await upsertIcloudEvent({ uid, ics });
}

// ---- Routes ----
app.get('/health', (_req, res) => res.send('ok'));

// (optional) list calendars to confirm the name; remove after testing
app.get('/debug/caldav', async (_req, res) => {
  try {
    const client = new DAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: { username: ICLOUD_USERNAME, password: ICLOUD_APP_PASSWORD },
      authMethod: 'Basic',
      defaultAccountType: 'caldav'
    });
    await client.login();
    const calendars = await fetchCalendars({ client });
    res.json({ calendars: (calendars || []).map(c => c.displayName || '(no name)') });
  } catch (e) {
    res.status(500).send('CalDAV login failed. Check ICLOUD_USERNAME / ICLOUD_APP_PASSWORD and that Calendar is enabled.');
  }
});

app.post('/webhooks/square', async (req, res) => {
  try {
    const eventType = req.body?.type || 'unknown';
    const bookingId =
      req.body?.data?.object?.booking?.id ||
      req.body?.data?.id; // fallback if Square payload differs

    console.log('Square webhook:', eventType, 'bookingId:', bookingId || '(none)');

    // Skip obviously fake IDs from Square "Send Test Event"
    if (!bookingId || String(bookingId).startsWith('TEST')) {
      return res.sendStatus(200);
    }

    if (/booking\.(created|updated)/i.test(eventType)) {
      await processBooking(bookingId);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err?.response?.body || err);
    res.sendStatus(200);
  }
});

// ---- Start ----
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));