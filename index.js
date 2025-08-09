// index.js
require('dotenv/config');
const express = require('express');
const fetch = require('node-fetch');
const dayjs = require('dayjs');
const ical = require('ical-generator');

const app = express();
app.use(express.json());

const {
  SQUARE_ACCESS_TOKEN,
  SQUARE_API_VERSION = '2025-03-19',
  ICLOUD_USERNAME,
  ICLOUD_APP_PASSWORD,
  ICLOUD_CALENDAR_NAME = 'Lil’s Bookings'
} = process.env;

// ---- ENV check ----
const required = [
  'SQUARE_ACCESS_TOKEN',
  'SQUARE_API_VERSION',
  'ICLOUD_USERNAME',
  'ICLOUD_APP_PASSWORD'
];
for (const k of required) {
  if (!process.env[k]) {
    console.warn(`[ENV] Missing ${k}`);
  }
}
console.log('[ENV] Loaded:',
  required.map(k => `${k}=${process.env[k] ? '✓' : '✗'}`).join('  ')
);

const BASE = 'https://connect.squareup.com/v2';
function authHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
    'Square-Version': SQUARE_API_VERSION,
    'Content-Type': 'application/json'
  };
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

async function getJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
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

// Create calendar event (replace this with actual iCloud push)
async function createCalendarEvent(event) {
  // This is where you integrate with iCloud Calendar via CalDAV or another library.
  // For now, we'll just log.
  console.log('Creating calendar event:', event);
}

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
      last = customer.family_name || '';
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
    description: `Square Booking Link: https://squareup.com/dashboard/appointments/booking/${booking.id}`
  };

  await createCalendarEvent(event);
}

// ---- Routes ----
app.get('/health', (_req, res) => {
  res.send('ok');
});

app.post('/webhooks/square', async (req, res) => {
  console.log('--- Incoming Square Webhook ---');
  console.log('Headers:', req.headers);
  console.log('Body:', JSON.stringify(req.body, null, 2));

  try {
    const eventType = req.body?.type || 'unknown';
    if (eventType.includes('booking')) {
      const bookingId = req.body?.data?.object?.booking?.id;
      if (bookingId) {
        console.log(`Processing booking ID: ${bookingId}`);
        await processBooking(bookingId);
      } else {
        console.warn('No booking ID found in webhook payload');
      }
    }
    res.status(200).send('ok');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('error');
  }
});

// ---- Start server ----
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});