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

  if (fields.botcheck) {
    return res.status(200).json({ success: true });
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
