const express = require('express');
const twilio = require('twilio');
const cron = require('node-cron');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fs = require('fs-extra');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// File to store subscriber phone numbers
const SUBSCRIBERS_FILE = path.join(__dirname, 'subscribers.json');

// Load or initialize subscribers list
async function getSubscribers() {
  try {
    await fs.ensureFile(SUBSCRIBERS_FILE);
    const data = await fs.readFile(SUBSCRIBERS_FILE, 'utf8');
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

async function saveSubscriber(phone) {
  const subscribers = await getSubscribers();
  const normalized = phone.replace(/\D/g, '');
  const e164 = normalized.startsWith('1') ? `+${normalized}` : `+1${normalized}`;
  if (!subscribers.includes(e164)) {
    subscribers.push(e164);
    await fs.writeFile(SUBSCRIBERS_FILE, JSON.stringify(subscribers, null, 2));
    console.log(`New subscriber added: ${e164}`);
  }
}

// Stripe webhook - must use raw body
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle successful subscription creation
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Extract phone number from custom fields
    const phoneField = session.custom_fields?.find(
      f => f.label?.custom?.toLowerCase().includes('phone')
    );
    const phone = phoneField?.text?.value || session.customer_details?.phone;

    if (phone) {
      await saveSubscriber(phone);

      // Send welcome text
      try {
        await twilioClient.messages.create({
          body: "you're in. every morning at 6am you'll get one word. starting tomorrow.",
          from: process.env.TWILIO_PHONE_NUMBER,
          to: phone.startsWith('+') ? phone : `+1${phone.replace(/\D/g, '')}`
        });
        console.log(`Welcome text sent to ${phone}`);
      } catch (err) {
        console.error('Failed to send welcome text:', err.message);
      }
    } else {
      console.warn('No phone number found in session:', session.id);
    }
  }

  res.json({ received: true });
});

// Health check
app.use(express.json());
app.get('/', (req, res) => res.send('is he dead yet? no.'));

// Daily text at 6am Eastern (11:00 UTC)
cron.schedule('0 11 * * *', async () => {
  console.log('Sending daily text...');
  const subscribers = await getSubscribers();

  for (const phone of subscribers) {
    try {
      await twilioClient.messages.create({
        body: 'no.',
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone
      });
      console.log(`Sent to ${phone}`);
    } catch (err) {
      console.error(`Failed to send to ${phone}:`, err.message);
    }
  }

  console.log(`Daily text sent to ${subscribers.length} subscribers.`);
}, {
  timezone: 'America/New_York'
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
