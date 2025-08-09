// booking_to_event.js  (no SDK; uses fetch + writes .ics)
require('dotenv/config');
const fs = require('fs');
const dayjs = require('dayjs');

const { SQUARE_ACCESS_TOKEN, SQUARE_API_VERSION = '2025-03-19' } = process.env;
if (!SQUARE_ACCESS_TOKEN) {
  console.error('Missing SQUARE_ACCESS_TOKEN in .env');
  process.exit(1);
}

const BASE = 'https://connect.squareup.com/v2';

function authHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
    'Square-Version': SQUARE_API_VERSION,
    'Content-Type': 'application/json',
  };
}

// ---------- Helpers ----------
function formatAddress(addr) {
  if (!addr) return '';
  const parts = [
    addr.address_line_1,
    addr.locality,
    addr.administrative_district_level_1,
    addr.postal_code,
    addr.country,
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

// ----- ICS helpers -----
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

// Escape RFC5545 text (commas, semicolons, backslashes, newlines)
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

function writeICSFile(icsText, filename) {
  fs.writeFileSync(filename, icsText, 'utf8');
  return filename;
}

function safeName(s) {
  return String(s).replace(/[^a-z0-9-_]+/gi, '_').slice(0, 80);
}

// ---------- Main ----------
async function run(bookingId) {
  try {
    const booking = await fetchBooking(bookingId);

    const startISO = booking.start_at;
    const durMin = booking.appointment_segments?.[0]?.duration_minutes ?? 60;
    const endISO  = dayjs(startISO).add(durMin, 'minute').toISOString();

    // Always fetch customer for name + address
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

    // Build the event exactly to your spec
    const event = {
      summary: `Truck Event – ${fullName}`, // Event Name
      location: addressLine,               // Event Address
      start: startISO,                     // Start ISO
      end: endISO,                         // Start + Duration
      description: `Square: https://squareup.com/dashboard/appointments (Booking ID: ${booking.id})` // Notes
    };

    console.log('Event payload ready:\n', event);

    // Build & write ICS
    const uid = `${booking.id}@lilsicecream`;
    const icsText = buildICS({
      uid,
      summary: event.summary,
      location: event.location,
      description: event.description,
      start: event.start,
      end: event.end
    });

    const fileName = `truck_event_${safeName(event.summary)}_${booking.id}.ics`;
    const outPath = writeICSFile(icsText, fileName);

    console.log(`ICS saved: ${outPath}`);
  } catch (err) {
    console.error('Error:', JSON.stringify(err, null, 2));
  }
}

// Usage
const bookingId = process.argv[2];
if (!bookingId) {
  console.error('Usage: node booking_to_event.js <BOOKING_ID>');
  process.exit(1);
}
run(bookingId);