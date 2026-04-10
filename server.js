// ============================================================
// WEBGENCY — Stripe Checkout Backend v2
// Now also logs every order to Google Sheets server-side.
// Node.js 18+  |  npm install stripe cors express node-fetch
// Environment variables needed in Railway:
//   STRIPE_SECRET_KEY  — your Stripe secret key
//   SHEETS_WEBHOOK_URL — your Google Apps Script URL
// ============================================================

const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Helper: send row to Google Sheets ──────────────────────
async function logToSheets(data) {
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url || url === 'PASTE_YOUR_URL_HERE') return; // skip if not configured

  try {
    // node-fetch v2 (CommonJS compatible)
    const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        submittedAt:   new Date().toISOString(),
        customerName:  data.customerName  || '',
        customerEmail: data.customerEmail || '',
        designType:    data.designType    || '',
        amount:        data.amount        || 0,
        sections:      Array.isArray(data.sections)    ? data.sections.join(', ')    : '',
        customBlocks:  Array.isArray(data.customBlocks)? data.customBlocks.join(', '): '',
        lang1:         data.lang1         || '',
        extraLangs:    Array.isArray(data.extraLangs)  ? data.extraLangs.join(', ')  : '',
        extras:        Array.isArray(data.extras)      ? data.extras.join(', ')      : '',
        personalLinks: data.personalLinks || 0,
        extraVersions: data.extraVersions || 0,
        eventDate:     data.eventDate     || '',
        notes:         data.notes         || '',
        breakdown:     data.breakdown     || '',
      }),
    });
    console.log('Logged to Sheets OK');
  } catch (err) {
    // Never block the Stripe redirect because of a Sheets failure
    console.error('Sheets log failed:', err.message);
  }
}

// ── Main checkout endpoint ──────────────────────────────────
app.post('/create-checkout', async (req, res) => {
  try {
    const {
      amount, currency, customerName, customerEmail,
      designType, sections, customBlocks, lang1, extraLangs,
      extras, personalLinks, extraVersions, eventDate, notes, breakdown
    } = req.body;

    // Log to Google Sheets first (non-blocking — won't delay Stripe)
    logToSheets(req.body).catch(() => {});

    // Build Stripe description
    const description = [
      designType,
      sections?.length      ? 'Sections: '     + sections.join(', ')    : '',
      customBlocks?.length  ? 'Custom: '        + customBlocks.join(', '): '',
      lang1                 ? 'Language: '      + lang1                  : '',
      extraLangs?.length    ? 'Extra langs: '   + extraLangs.join(', ')  : '',
      extras?.length        ? 'Extras: '        + extras.join(', ')      : '',
      personalLinks         ? 'Links: '         + personalLinks          : '',
      extraVersions         ? 'Versions: '      + extraVersions          : '',
      eventDate             ? 'Event date: '    + eventDate              : '',
      notes                 ? 'Notes: '         + notes                  : '',
    ].filter(Boolean).join(' | ');

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: customerEmail,
      line_items: [{
        price_data: {
          currency: currency || 'eur',
          unit_amount: Math.round(amount * 100),
          product_data: {
            name: 'Webgency — ' + designType,
            description: description.substring(0, 500),
          },
        },
        quantity: 1,
      }],
      metadata: {
        customerName,
        designType,
        breakdown,
        eventDate:     eventDate     || '',
        personalLinks: String(personalLinks  || 0),
        extraVersions: String(extraVersions  || 0),
      },
      success_url: 'https://webgencyinvitations.com/paymentsuccessful?session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  'https://webgencyinvitations.com/order',
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Webgency checkout server running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
