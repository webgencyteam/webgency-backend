// ============================================================
// WEBGENCY — Stripe Checkout Backend
// Deploy this to Railway, Render, or Vercel (free tier)
// Node.js 18+  |  npm install stripe cors express
// ============================================================

const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY); // set in env vars

app.use(cors({ origin: '*' })); // restrict to your domain in production
app.use(express.json());

app.post('/create-checkout', async (req, res) => {
  try {
    const {
      amount,
      currency,
      customerName,
      customerEmail,
      designType,
      sections,
      customBlocks,
      lang1,
      extraLangs,
      extras,
      personalLinks,
      extraVersions,
      eventDate,
      notes,
      breakdown
    } = req.body;

    // Build a readable description for Stripe
    const description = [
      designType,
      sections && sections.length ? 'Sections: ' + sections.join(', ') : '',
      customBlocks && customBlocks.length ? 'Custom: ' + customBlocks.join(', ') : '',
      lang1 ? 'Language: ' + lang1 : '',
      extraLangs && extraLangs.length ? 'Extra langs: ' + extraLangs.join(', ') : '',
      extras && extras.length ? 'Extras: ' + extras.join(', ') : '',
      personalLinks ? 'Links: ' + personalLinks : '',
      extraVersions ? 'Versions: ' + extraVersions : '',
      eventDate ? 'Event date: ' + eventDate : '',
      notes ? 'Notes: ' + notes : '',
    ].filter(Boolean).join(' | ');

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: customerEmail,
      line_items: [{
        price_data: {
          currency: currency || 'eur',
          unit_amount: Math.round(amount * 100), // Stripe uses cents
          product_data: {
            name: 'Webgency — ' + designType,
            description: description.substring(0, 500), // Stripe limit
          },
        },
        quantity: 1,
      }],
      // Pre-fill customer name via metadata (shown in Stripe dashboard)
      metadata: {
        customerName,
        designType,
        breakdown,
        eventDate: eventDate || '',
        personalLinks: String(personalLinks || 0),
        extraVersions: String(extraVersions || 0),
      },
      // Where to send the customer after payment
      success_url: 'https://webgencyinvitations.com/thank-you?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://webgencyinvitations.com/order',
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/', (req, res) => res.send('Webgency checkout server running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
