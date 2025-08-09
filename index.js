require('dotenv/config');
const express = require('express');
const dayjs = require('dayjs');
const { createObject, fetchCalendars, DAVClient } = require('tsdav');

const {
  SQUARE_ACCESS_TOKEN,
  SQUARE_API_VERSION = '2025-03-19',
  ICLOUD_USERNAME,             // your Apple ID email
  ICLOUD_APP_PASSWORD,         // app-specific password
  ICLOUD_CALENDAR_NAME = 'Lil’s Bookings'
} = process.env;

const app = express();
app.use(express.json({ type: '*/*' })); // Square sends application/json

const SQUARE_BASE = 'https://connect.squareup.com/v2';

// ---- Helpers ----
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
async function fetchBooking(bookingId) {
  const res = await fetch(`${SQUARE_BASE}/bookings/${bookingId}`, { headers: authHeaders() });
  const body = await getJson(res);
  if (!res.ok) throw body;
  return body.booking;
}
async function fetchCustomer(customerId) {
  const res = await fetch(`${SQUARE_BASE}/customers/${customerId}`, { headers: authHeaders() });
  const body = await getJson(res);
  if (!res.ok) throw body;
  return body.customer;
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
function toICSDate(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
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
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
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

// ---- CalDAV (iCloud) client init ----
async function getIcloudCalendar() {
  const client = new DAVClient({
    serverUrl: 'https://caldav.icloud.com',
    credentials: { username: ICLOUD_USERNAME, password: ICLOUD_APP_PASSWORD },
    authMethod: 'Basic',
    defaultAccountType: 'caldav'
  });
  await client.login();
  const cals = await fetchCalendars({ client });
  const target = cals.find(c => (c.displayName || '').trim() === ICLOUD_CALENDAR_NAME.trim()) || cals[0];
  if (!target) throw new Error('No iCloud calendars found for this account.');
  return { client, calendar: target };
}

// ---- Core: upsert event to iCloud ----
async function upsertIcloudEvent(ics, uid) {
  const { client, calendar } = await getIcloudCalendar();
  // Use UID as filename so updates overwrite
  const filename = `${uid}.ics`;
  await createObject({
    client,
    calendar,
    filename,
    iCalString: ics
  });
}

// ---- Webhook endpoint ----
app.post('/webhooks/square', async (req, res) => {
  try {
    // Optional: verify signature (can add later using your Square webhook signature key)
    const eventType = req.body?.type;
    const bookingId = req.body?.data?.id || req.body?.data?.object?.booking?.id;

    if (!bookingId || !eventType) {
      console.log('Ignoring payload (no booking id):', req.body);
      return res.sendStatus(200);
    }

    // We handle created + updated
    if (!/booking\.(created|updated)/i.test(eventType)) {
      return res.sendStatus(200);
    }

    // Pull booking + customer
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

    await upsertIcloudEvent(ics, uid);
    console.log(`Upserted iCloud event for booking ${booking.id} (${summary})`);
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err?.response?.body || err);
    res.sendStatus(200); // Avoid retries storm while debugging; switch to 500 later if needed
  }
});

// Health check
app.get('/health', (_req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on :${PORT}`));