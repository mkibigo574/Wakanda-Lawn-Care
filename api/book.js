import Busboy from 'busboy';
import { Resend } from 'resend';

export const config = {
  api: { bodyParser: false },
};

const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_FILES = 5;
const FROM_ADDRESS = process.env.RESEND_FROM || 'Wakanda Lawn Care <bookings@wakandalawncare.com.au>';
const TO_ADDRESS = process.env.BOOKING_TO || 'admin@wakandalawncare.com.au';

function parseForm(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
      });
    } catch (err) {
      reject(err);
      return;
    }

    const fields = {};
    const files = [];
    let oversize = false;

    bb.on('field', (name, value) => {
      if (Object.prototype.hasOwnProperty.call(fields, name)) {
        const existing = fields[name];
        fields[name] = Array.isArray(existing) ? existing.concat(value) : [existing, value];
      } else {
        fields[name] = value;
      }
    });

    bb.on('file', (_name, file, info) => {
      const chunks = [];
      file.on('data', (chunk) => chunks.push(chunk));
      file.on('limit', () => {
        oversize = true;
        file.resume();
      });
      file.on('end', () => {
        if (!oversize && chunks.length > 0 && info.filename) {
          files.push({
            filename: info.filename,
            mimeType: info.mimeType || 'application/octet-stream',
            content: Buffer.concat(chunks),
          });
        }
      });
    });

    bb.on('close', () => {
      if (oversize) {
        reject(new Error(`One or more photos exceed the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB-per-file limit. Please resize and try again.`));
      } else {
        resolve({ fields, files });
      }
    });
    bb.on('error', reject);

    req.pipe(bb);
  });
}

function asScalar(value) {
  return Array.isArray(value) ? value[0] : value;
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '';
}

// --- Layer 4: best-effort in-memory rate limit (per warm instance) ---
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const rateBuckets = new Map(); // ip -> number[] (hit timestamps)

function isRateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();
  const recent = (rateBuckets.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  rateBuckets.set(ip, recent);
  // Opportunistic cleanup so the map can't grow unbounded on a long-lived instance.
  if (rateBuckets.size > 5000) {
    for (const [key, hits] of rateBuckets) {
      if (hits.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) rateBuckets.delete(key);
    }
  }
  return recent.length > RATE_LIMIT_MAX;
}

// --- Layer 2: Cloudflare Turnstile verification ---
async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Not configured yet — don't break the form. Set TURNSTILE_SECRET_KEY to enable.
    console.warn('TURNSTILE_SECRET_KEY not set — skipping CAPTCHA verification.');
    return true;
  }
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.append('remoteip', ip);
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await resp.json();
    return data.success === true;
  } catch {
    return false;
  }
}

// --- Layer 3: content & field validation ---
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LINK_RE = /(https?:\/\/|www\.|t\.me\/|wa\.me\/|telegram|\b\d{1,3}(?:\.\d{1,3}){3}\b)/i;
const SPAM_PHRASES = [
  /free sex/i, /chat me/i, /click here/i, /viagra/i, /cialis/i, /casino/i,
  /crypto/i, /bitcoin/i, /\bporn\b/i, /\bseo\b/i, /escort/i, /payday loan/i,
];

function looksGibberish(str) {
  const s = String(str || '').trim();
  // A 6+ char token with no vowels at all is almost never a real name.
  return s.length >= 6 && !/[aeiouy]/i.test(s);
}

// Spam → caller should silently return 200 (no email). Indistinguishable from success.
function isSpam(fields) {
  const textFields = ['first_name', 'last_name', 'address', 'suburb', 'details'];
  for (const key of textFields) {
    const value = String(asScalar(fields[key]) || '');
    if (LINK_RE.test(value)) return true;
    if (SPAM_PHRASES.some((re) => re.test(value))) return true;
  }
  if (looksGibberish(asScalar(fields.first_name)) || looksGibberish(asScalar(fields.last_name))) {
    return true;
  }
  return false;
}

// Genuine, user-facing validation. Returns an error message (→ real 4xx) or null.
function validateFields(fields) {
  const firstName = String(asScalar(fields.first_name) || '').trim();
  const lastName = String(asScalar(fields.last_name) || '').trim();
  const email = String(asScalar(fields.email) || '').trim();
  const phone = String(asScalar(fields.phone) || '').trim();
  const postcode = String(asScalar(fields.postcode) || '').trim();

  if (!firstName || !lastName) return 'Please enter your first and last name.';
  if (!EMAIL_RE.test(email)) return 'Please enter a valid email address.';

  const phoneDigits = phone.replace(/\D/g, '');
  if (phoneDigits.length < 8 || phoneDigits.length > 15) {
    return 'Please enter a valid phone number.';
  }
  // Postcode is optional; if supplied it must be a 4-digit Australian postcode (shape only).
  if (postcode && !/^\d{4}$/.test(postcode)) {
    return 'Please enter a valid 4-digit postcode.';
  }
  return null;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function buildHtml(fields) {
  const services = asList(fields.service);
  const fullName = `${fields.first_name || ''} ${fields.last_name || ''}`.trim();
  const row = (label, value) => {
    if (!value) return '';
    const safe = esc(value).replace(/\n/g, '<br>');
    return `<tr><th align="left" style="padding:8px 16px 8px 0;vertical-align:top;color:#5a6f5e;font-weight:600;white-space:nowrap;">${esc(label)}</th><td style="padding:8px 0;color:#0d3320;">${safe}</td></tr>`;
  };
  return `<!doctype html><html><body style="margin:0;background:#f4f2ec;padding:24px;font-family:Inter,Arial,sans-serif;">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;color:#0d3320;">
    <h2 style="margin:0 0 4px;font-family:'Playfair Display',Georgia,serif;color:#0d3320;">New booking request</h2>
    <p style="margin:0 0 20px;color:#5a6f5e;">Submitted via wakandalawncare.com.au</p>
    <table style="border-collapse:collapse;width:100%;font-size:15px;">
      ${row('Name', fullName)}
      ${row('Email', fields.email)}
      ${row('Mobile', fields.phone)}
      ${row('Services', services.join(', '))}
      ${row('Property type', fields.property_type)}
      ${row('Address', fields.address)}
      ${row('Suburb', fields.suburb)}
      ${row('Postcode', fields.postcode)}
      ${row('Preferred date', fields.service_date)}
      ${row('Preferred time', fields.service_time)}
      ${row('Job details', fields.details)}
    </table>
  </div>
</body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ success: false, message: 'Email service not configured.' });
  }

  let parsed;
  try {
    parsed = await parseForm(req);
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message || 'Could not read your submission.' });
  }

  const { fields, files } = parsed;

  // Layer 1: honeypots. If filled, a bot did it — fake success, send nothing.
  const honeypotHit = fields.botcheck
    || (typeof asScalar(fields.company_website) === 'string' && asScalar(fields.company_website).trim() !== '');
  if (honeypotHit) {
    return res.status(200).json({ success: true });
  }

  // Layer 4: rate limit by IP (real 429 — a genuine error a real user could hit).
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return res.status(429).json({
      success: false,
      message: 'Too many requests. Please wait a few minutes and try again, or call 0402 654 148.',
    });
  }

  // Layer 2: CAPTCHA. Verification failure is user-facing (real 4xx).
  const captchaOk = await verifyTurnstile(asScalar(fields['cf-turnstile-response']), ip);
  if (!captchaOk) {
    return res.status(400).json({
      success: false,
      message: "Could not verify you're human. Please complete the verification and try again.",
    });
  }

  // Layer 3a: content checks → silently accept like the honeypot (no email).
  if (isSpam(fields)) {
    return res.status(200).json({ success: true });
  }

  // Layer 3b: field-shape validation → genuine, helpful 4xx.
  const validationError = validateFields(fields);
  if (validationError) {
    return res.status(400).json({ success: false, message: validationError });
  }

  const fullName = `${fields.first_name || ''} ${fields.last_name || ''}`.trim();
  const services = asList(fields.service);
  const subject = `New booking${fullName ? ' — ' + fullName : ''}${services.length ? ' (' + services.join(', ') + ')' : ''}`;

  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    const { error } = await resend.emails.send({
      from: FROM_ADDRESS,
      to: [TO_ADDRESS],
      replyTo: fields.email || undefined,
      subject,
      html: buildHtml(fields),
      attachments: files.map((f) => ({ filename: f.filename, content: f.content })),
    });

    if (error) {
      return res.status(502).json({ success: false, message: error.message || 'Could not send booking email.' });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Unexpected error sending email.' });
  }
}
