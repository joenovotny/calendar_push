// index.js
require('dotenv/config');
const express = require('express');
const dayjs = require('dayjs');
const { DAVClient, fetchCalendars } = require('tsdav');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json({ type: '*/*' })); // accept Square's JSON

// ---- ENV ----
const {
  SQUARE_ACCESS_TOKEN,
  SQUARE_API_VERSION = '2025-03-19',
  ICLOUD_USERNAME,
  ICLOUD_APP_PASSWORD,
  ICLOUD_CALENDAR_NAME = 'Lil’s Bookings',
  SMTP_HOST,
  SMTP_PORT = '587',
  SMTP_USER,
  SMTP_PASS,
  TO_EMAIL,
  FROM_EMAIL,
  SEND_EMAIL_ON_UPDATED = 'false' // set to 'true' to also email on updates
} = process.env;

console.log('[ENV] Loaded: SQUARE_ACCESS_TOKEN=✓  SQUARE_API_VERSION=✓  ICLOUD_USERNAME=✓  ICLOUD_APP_PASSWORD=✓');

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
    addr.address_line_1, addr.locality,
    addr.administrative_district_level_1, addr.postal_code, addr.country
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
  const pad = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
function icsEscape(s='') {
  return String(s).replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
}
function buildICS({ uid, summary, location, description, start, end }) {
  const now = toICSDate(new Date().toISOString());
  const dtStart = toICSDate(start);
  const dtEnd = toICSDate(end);
  return [
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Lils Ice Cream//Bookings//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsEscape(uid)}`,`DTSTAMP:${now}`,`DTSTART:${dtStart}`,`DTEND:${dtEnd}`,
    `SUMMARY:${icsEscape(summary)}`,`LOCATION:${icsEscape(location)}`,`DESCRIPTION:${icsEscape(description)}`,
    'END:VEVENT','END:VCALENDAR',''
  ].join('\r\n');
}

// ---- Email helper ----
async function sendIcsEmail({ to, subject, text, ics, filename }) {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !to) {
    console.warn('[SMTP] Missing config; skipping email.');
    return;
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  await transporter.sendMail({
    from: FROM_EMAIL || SMTP_USER,
    to,
    subject,
    text,
    attachments: [{ filename: filename || 'event.ics', content: ics, contentType: 'text/calendar; method=PUBLISH; charset=UTF-8' }]
  });
  console.log(`Emailed ICS to ${to}`);
}

// ---- iCloud CalDAV (raw PUT) ----
function ensureAbsoluteUrl(u) {
  if (!u) return null;
  if (typeof u === 'object') u = u.href || String(u);
  return /^https?:\/\//i.test(u) ? u : `https://caldav.icloud.com${u}`;
}
async function getIcloudCalendar() {
  const client = new DAVClient({
    serverUrl: 'https://caldav.icloud.com',
    credentials: { username: ICLOUD_USERNAME, password: ICLOUD_APP_PASSWORD },
    authMethod: 'Basic',
    defaultAccountType: 'caldav'
  });
  await client.login();
  await client.createAccount({ account: { serverUrl: 'https://caldav.icloud.com', accountType: 'caldav', rootUrl: 'https://caldav.icloud.com' } });
  const calendars = await client.fetchCalendars();
  if (!calendars?.length) throw new Error('No iCloud calendars found.');
  const calendar = calendars.find(c => (c.displayName || '').trim() === (ICLOUD_CALENDAR_NAME || '').trim()) || calendars[0];
  return { calendar };
}
async function putIcsToIcloud({ calUrl, filename, ics }) {
  const eventUrl = new URL(filename, calUrl).toString();
  const auth = Buffer.from(`${ICLOUD_USERNAME}:${ICLOUD_APP_PASSWORD}`).toString('base64');
  const res = await fetch(eventUrl, {
    method: 'PUT',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'text/calendar; charset=utf-8' },
    body: ics
  });
  if (!res.ok) {
    const text = await res.text().catch(()=> '');
    throw new Error(`CalDAV PUT failed ${res.status}: ${text || res.statusText}`);
  }
  return res.headers.get('etag') || null;
}
async function upsertIcloudEvent({ uid, ics }) {
  const { calendar } = await getIcloudCalendar();
  const rawCalUrl = calendar.url ?? calendar.href ?? calendar?.url?.href;
  const calUrl = ensureAbsoluteUrl(rawCalUrl);
  if (!calUrl) throw new Error('iCloud calendar URL missing.');
  const filename = `${uid}.ics`;
  const etag = await putIcsToIcloud({ calUrl, filename, ics });
  console.log(`${etag ? 'Upserted' : 'Created'} iCloud event: ${filename}`);
}

async function deleteIcloudEvent({ uid }) {
  const { calendar } = await getIcloudCalendar();
  const rawCalUrl = calendar.url ?? calendar.href ?? calendar?.url?.href;
  const calUrl = ensureAbsoluteUrl(rawCalUrl);
  if (!calUrl) throw new Error('iCloud calendar URL missing.');

  const filename = `${uid}.ics`;
  const eventUrl = new URL(filename, calUrl).toString();
  const auth = Buffer.from(`${ICLOUD_USERNAME}:${ICLOUD_APP_PASSWORD}`).toString('base64');

  const res = await fetch(eventUrl, {
    method: 'DELETE',
    headers: { 'Authorization': `Basic ${auth}` }
  });

  if (res.status === 404) {
    console.log(`Cancellation: event not found (already gone): ${filename}`);
    return;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`CalDAV DELETE failed ${res.status}: ${text || res.statusText}`);
  }
  console.log(`Deleted iCloud event: ${filename}`);
}

// ---- Booking -> Calendar
async function processBooking(bookingId, { shouldEmail }) {
  const booking = await fetchBooking(bookingId);
  const startISO = booking.start_at;
  const durMin = booking.appointment_segments?.[0]?.duration_minutes ?? 60;
  const endISO = dayjs(startISO).add(durMin, 'minute').toISOString();

  let first = '', last = '', addressLine = 'TBD', phone = '';
  if (booking.customer_id) {
    try {
      const customer = await fetchCustomer(booking.customer_id);
      first = customer.given_name || '';
      last  = customer.family_name || '';
      addressLine = formatAddress(customer.address) || 'TBD';
      phone = customer.phone_number || '';
    } catch (e) { console.warn('Customer lookup failed:', e); }
  }

  const fullName = `${first} ${last}`.trim() || 'Customer';
  const summary = `Truck Event – ${fullName}`;
  const descriptionLines = [
    `Square: https://squareup.com/dashboard/appointments (Booking ID: ${booking.id})`,
    phone ? `Phone: ${phone}` : null
  ].filter(Boolean);
  const description = descriptionLines.join('\n');

  const uid = `${booking.id}@lilsicecream`;
  const ics = buildICS({ uid, summary, location: addressLine, description, start: startISO, end: endISO });

  if (shouldEmail) {
    await sendIcsEmail({
      to: TO_EMAIL,
      subject: summary,
      text: `Booking ${booking.id}\n${description}\nLocation: ${addressLine}\nStart: ${startISO}\nEnd: ${endISO}`,
      ics,
      filename: `${uid}.ics`
    });
  }
  await upsertIcloudEvent({ uid, ics });
}

async function processCancellation(bookingId, { shouldEmail }) {
  const uid = `${bookingId}@lilsicecream`;

  // (Optional) try to fetch name/phone for nicer email; ignore errors
  let summary = `Truck Event – Canceled`;
  try {
    const booking = await fetchBooking(bookingId);
    let first = '', last = '';
    if (booking.customer_id) {
      try {
        const customer = await fetchCustomer(booking.customer_id);
        first = customer.given_name || '';
        last  = customer.family_name || '';
      } catch {}
    }
    const fullName = `${first} ${last}`.trim();
    if (fullName) summary = `Truck Event – ${fullName} (Canceled)`;
  } catch {}

  if (shouldEmail) {
    await sendIcsEmail({
      to: TO_EMAIL,
      subject: summary,
      text: `Booking ${bookingId}\nStatus: CANCELED`,
      ics: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n',
      filename: `${uid}.ics`
    });
  }

  await deleteIcloudEvent({ uid });
}


// ---- Webhook de-dupe (memory TTL) ----
const seen = new Map(); // eventId -> expiresAt
const DEDUPE_TTL_MS = 10 * 60 * 1000; // 10 minutes
function isDuplicate(eventId) {
  if (!eventId) return false;
  const now = Date.now();
  for (const [k, v] of seen) if (v < now) seen.delete(k);
  if (seen.has(eventId)) return true;
  seen.set(eventId, now + DEDUPE_TTL_MS);
  return false;
}

async function processBookingRouter(bookingId, { shouldEmail }) {
  const booking = await fetchBooking(bookingId);

  const statusRaw = booking.status || booking.booking_status || '';
  const status = String(statusRaw).toUpperCase();
  const canceledAt = booking.canceled_at || booking.cancelled_at || null;
  const cancelReason = booking.cancellation_reason || null;

  console.log('[Booking status]', { bookingId, status, canceledAt, cancelReason });

  const isCancelled =
    status.includes('CANCEL') ||        // CANCELLED / CANCELED
    status === 'NO_SHOW' ||
    !!canceledAt ||
    !!cancelReason;

  if (isCancelled) {
    await processCancellation(bookingId, {
      shouldEmail: String(process.env.SEND_EMAIL_ON_CANCELED || 'true').toLowerCase() === 'true'
    });
  } else {
    await processBooking(bookingId, { shouldEmail });
  }
}

// ---- Routes ----
app.get('/health', (_req, res) => res.send('ok'));

app.post('/webhooks/square', async (req, res) => {
  try {
    const eventType = req.body?.type || req.body?.event_type || 'unknown';
    const eventId   = req.body?.event_id || req.body?.id || null;
    const bookingId = req.body?.data?.object?.booking?.id || req.body?.data?.id || null;

    console.log('Square webhook:', { eventType, eventId, bookingId });

    if (isDuplicate(eventId)) {
      console.log('Duplicate webhook suppressed:', eventId);
      return res.sendStatus(200);
    }
    if (!bookingId || String(bookingId).startsWith('TEST')) {
      return res.sendStatus(200);
    }

    // Handle both explicit cancel events and status-driven cancels
    if (/^booking\.(created|updated|canceled|cancelled)$/i.test(eventType)) {
      const shouldEmail =
        eventType === 'booking.created' ||
        (eventType === 'booking.updated' && (process.env.SEND_EMAIL_ON_UPDATED || 'false').toLowerCase() === 'true');
      await processBookingRouter(bookingId, { shouldEmail });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err?.response?.body || err);
    res.sendStatus(200);
  }
});

app.post('/debug/delete/:bookingId', async (req, res) => {
  try {
    const uid = `${req.params.bookingId}@lilsicecream`;
    await deleteIcloudEvent({ uid });
    return res.json({ ok: true });
  } catch (e) {
    console.error('Manual delete failed:', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---- Start ----
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));