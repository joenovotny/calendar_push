// index.js
require('dotenv/config');
const express = require('express');
const dayjs = require('dayjs');

const app = express();
app.use(express.json({ type: '*/*' })); // accept Square's JSON

// ---- ENV ----
const {
  SQUARE_ACCESS_TOKEN,
  SQUARE_API_VERSION = '2025-03-19',
  ICLOUD_USERNAME,
  ICLOUD_APP_PASSWORD,
  ICLOUD_CALENDAR_NAME = 'Lil’s Bookings'
} = process.env;

const required = [
  'SQUARE_ACCESS_TOKEN',
  'SQUARE_API_VERSION',
  'ICLOUD_USERNAME',
  'ICLOUD_APP_PASSWORD'
];
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

// ---- Event builder ----
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
  const event = {
    summary: `Truck Event – ${fullName}`,
    location: addressLine,
    start: startISO,
    end: endISO,
    description: `Square: https://squareup.com/dashboard/appointments (Booking ID: ${booking.id})`
  };

  // TODO: push to iCloud here (CalDAV). For now, just log so we can verify end-to-end.
  console.log('Event built:', event);
  return event;
}

// ---- Routes ----
app.get('/health', (_req, res) => res.send('ok'));

app.post('/webhooks/square', async (req, res) => {
  try {
    console.log('--- Incoming Square Webhook ---');
    console.log('Type:', req.body?.type);
    const bookingId =
      req.body?.data?.object?.booking?.id ||
      req.body?.data?.id; // fallback if structure varies

    if (!bookingId) {
      console.warn('No booking ID found in webhook payload');
      return res.sendStatus(200);
    }

    await processBooking(bookingId);
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    // return 200 while debugging to avoid Square retry storms
    res.sendStatus(200);
  }
});

// ---- Start ----
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});