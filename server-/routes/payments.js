const express = require('express');
const nodemailer = require('nodemailer');
const { authenticate } = require('../middleware/auth');
const Payment = require('../models/Payment');
const User = require('../models/User');
const ArtistProfile = require('../models/ArtistProfile');
const Event = require('../models/Event');
const EventForm = require('../models/EventForm');
const FormSubmission = require('../models/FormSubmission');
const { artistInviteEmail } = require('../utils/emailTemplates');

const router = express.Router();

const getCashfreeBaseUrl = () => {
  const env = process.env.CASHFREE_ENV || 'TEST';
  return env === 'PRODUCTION' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
};

// Admin auth middleware
const adminAuth = async (req, res, next) => {
  if (process.env.DISABLE_ADMIN_AUTH === 'true' || process.env.NODE_ENV === 'development') {
    return next();
  }
  try {
    await authenticate(req, res, () => {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
      }
      next();
    });
  } catch (error) {
    res.status(401).json({ error: 'Authentication failed' });
  }
};

// ─── PUBLIC ENDPOINTS ────────────────────────────────────────────────────────

// 1. Create Artist Membership Payment Session
router.post('/create-membership-session', async (req, res) => {
  try {
    const { name, email, phone, artForm, bio } = req.body;

    if (!name || !email || !artForm) {
      return res.status(400).json({ error: 'Name, email, and art form are required' });
    }

    const orderId = `order_memb_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const cashfreeUrl = `${getCashfreeBaseUrl()}/orders`;

    const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host = req.headers.host;
    let returnUrl = `${protocol}://${host}/api/payments/return?order_id={order_id}`;
    if (process.env.CASHFREE_ENV === 'PRODUCTION' && returnUrl.startsWith('http://')) {
      returnUrl = returnUrl.replace('http://', 'https://');
    }

    // Create Cashfree Order
    const response = await fetch(
      cashfreeUrl,
      {
        method: 'POST',
        headers: {
          'x-client-id': process.env.CASHFREE_APP_ID,
          'x-client-secret': process.env.CASHFREE_SECRET_KEY,
          'x-api-version': '2023-08-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          order_id: orderId,
          order_amount: 999.00, // Fixed membership fee
          order_currency: 'INR',
          customer_details: {
            customer_id: email.replace(/[^a-zA-Z0-9]/g, '_'),
            customer_name: name,
            customer_email: email,
            customer_phone: phone || '9999999999'
          },
          order_meta: {
            return_url: returnUrl
          }
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const err = new Error(errorData.message || `Cashfree returned status ${response.status}`);
      err.response = { data: errorData };
      throw err;
    }

    const cfData = await response.json();

    // Save pending payment record in DB with registration details in details
    const payment = new Payment({
      orderId,
      amount: 999.00,
      currency: 'INR',
      status: 'pending',
      type: 'membership',
      email,
      name,
      details: {
        name,
        email,
        phone,
        artForm,
        bio
      }
    });

    await payment.save();

    res.status(201).json({
      success: true,
      paymentSessionId: cfData.payment_session_id,
      orderId,
      environment: process.env.CASHFREE_ENV || 'TEST'
    });

  } catch (error) {
    console.error('Create membership session error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to initiate payment session', details: error.response?.data?.message || error.message });
  }
});

// 2. Verify Artist Membership Payment & Onboard Artist
router.post('/verify-membership', async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: 'Order ID is required' });
    }

    const payment = await Payment.findOne({ orderId, type: 'membership' });
    if (!payment) {
      return res.status(404).json({ error: 'Payment record not found' });
    }

    // Call Cashfree order status
    const cashfreeUrl = `${getCashfreeBaseUrl()}/orders/${orderId}`;
    const response = await fetch(cashfreeUrl, {
      method: 'GET',
      headers: {
        'x-client-id': process.env.CASHFREE_APP_ID,
        'x-client-secret': process.env.CASHFREE_SECRET_KEY,
        'x-api-version': '2023-08-01',
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const err = new Error(errorData.message || `Cashfree returned status ${response.status}`);
      err.response = { data: errorData };
      throw err;
    }

    const cfOrder = await response.json();
    console.log(`[CASHFREE] Order ${orderId} status:`, cfOrder.order_status);

    if (cfOrder.order_status === 'PAID') {
      payment.status = 'success';
      payment.paymentId = cfOrder.cf_order_id ? String(cfOrder.cf_order_id) : '';
      await payment.save();

      // Elevate user and create ArtistProfile
      const { name, email, phone, artForm, bio } = payment.details;

      // 1. Create or Activate ArtistProfile
      let artistProfile = await ArtistProfile.findOne({ email: email.toLowerCase() });
      if (!artistProfile) {
        // Generate unique username
        const baseUsername = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
        let username = baseUsername;
        let attempts = 0;
        while ((await ArtistProfile.findOne({ username })) && attempts < 10) {
          username = `${baseUsername}_${Math.floor(1000 + Math.random() * 9000)}`;
          attempts++;
        }

        const artistNumber = `ART_${Math.floor(100000 + Math.random() * 900000)}`;

        artistProfile = await ArtistProfile.create({
          artistNumber,
          name,
          email: email.toLowerCase(),
          username,
          phone: phone || '',
          artForm: artForm || 'Visual Artist',
          image: {
            url: `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=random&size=200`,
            publicId: null,
            alt: name
          },
          location: { city: '', state: '', country: '' },
          social: { instagram: '', facebook: '', twitter: '', linkedin: '', website: '' },
          bio: bio || '',
          isActive: true
        });
      } else {
        artistProfile.isActive = true;
        await artistProfile.save();
      }

      // 2. Find and update User role to 'artist'
      const user = await User.findOne({ email: email.toLowerCase() });
      if (user && user.role !== 'admin') {
        user.role = 'artist';
        await user.save();
      }

      // 3. Send welcome email
      try {
        const createTransporter = () => {
          return nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: parseInt(process.env.SMTP_PORT) || 587,
            secure: false,
            auth: {
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASS
            },
            tls: {
              rejectUnauthorized: false
            }
          });
        };
        const transporter = createTransporter();
        const dashboardUrl = process.env.ARTIST_DASHBOARD_URL || 'http://localhost:3000/artist/login';
        
        await transporter.sendMail({
          from: `"ArtArtist" <${process.env.SMTP_USER}>`,
          to: email,
          subject: 'Welcome to ArtArtist — Your Artist Dashboard is Ready',
          html: artistInviteEmail(name, email, dashboardUrl)
        });
        console.log(`[EMAIL] Onboarding invite sent successfully to: ${email}`);
      } catch (emailErr) {
        console.error('[EMAIL_ERROR] Failed to send invite email:', emailErr.message);
      }

      return res.json({ success: true, message: 'Membership payment verified and artist elevated' });
    } else {
      payment.status = 'failed';
      await payment.save();
      return res.json({ success: false, status: cfOrder.order_status, message: 'Payment was not successful' });
    }

  } catch (error) {
    console.error('Verify membership error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Verification failed', details: error.response?.data?.message || error.message });
  }
});

router.post('/create-event-session', async (req, res) => {
  try {
    const { eventId, guestName, guestEmail, guestPhone, responses } = req.body;

    if (!eventId || !guestName || !guestEmail) {
      return res.status(400).json({ error: 'Event ID, name, and email are required' });
    }

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    if (event.pricing?.type !== 'paid' || !event.pricing?.amount) {
      return res.status(400).json({ error: 'This event is not a paid event' });
    }

    const amount = Number(event.pricing.amount);
    const orderId = `order_event_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const cashfreeUrl = `${getCashfreeBaseUrl()}/orders`;

    const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host = req.headers.host;
    let returnUrl = `${protocol}://${host}/api/payments/return?order_id={order_id}`;
    if (process.env.CASHFREE_ENV === 'PRODUCTION' && returnUrl.startsWith('http://')) {
      returnUrl = returnUrl.replace('http://', 'https://');
    }

    // Create Cashfree Order
    const response = await fetch(
      cashfreeUrl,
      {
        method: 'POST',
        headers: {
          'x-client-id': process.env.CASHFREE_APP_ID,
          'x-client-secret': process.env.CASHFREE_SECRET_KEY,
          'x-api-version': '2023-08-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          order_id: orderId,
          order_amount: amount,
          order_currency: 'INR',
          customer_details: {
            customer_id: guestEmail.replace(/[^a-zA-Z0-9]/g, '_'),
            customer_name: guestName,
            customer_email: guestEmail,
            customer_phone: guestPhone || '9999999999'
          },
          order_meta: {
            return_url: returnUrl
          }
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const err = new Error(errorData.message || `Cashfree returned status ${response.status}`);
      err.response = { data: errorData };
      throw err;
    }

    const cfData = await response.json();

    // Save pending payment record in DB
    const payment = new Payment({
      orderId,
      amount,
      currency: 'INR',
      status: 'pending',
      type: 'event',
      email: guestEmail,
      name: guestName,
      details: {
        eventId,
        guestName,
        guestEmail,
        guestPhone,
        responses
      }
    });

    await payment.save();

    res.status(201).json({
      success: true,
      paymentSessionId: cfData.payment_session_id,
      orderId,
      environment: process.env.CASHFREE_ENV || 'TEST'
    });

  } catch (error) {
    console.error('Create event session error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to initiate payment session', details: error.response?.data?.message || error.message });
  }
});

// 4. Verify Event Registration Payment & Create Attendee
router.post('/verify-event', async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: 'Order ID is required' });
    }

    const payment = await Payment.findOne({ orderId, type: 'event' });
    if (!payment) {
      return res.status(404).json({ error: 'Payment record not found' });
    }

    if (payment.status === 'success') {
      return res.json({ success: true, message: 'Event payment already verified and registration completed' });
    }

    // Call Cashfree to check order status
    const cashfreeUrl = `${getCashfreeBaseUrl()}/orders/${orderId}`;
    const response = await fetch(cashfreeUrl, {
      method: 'GET',
      headers: {
        'x-client-id': process.env.CASHFREE_APP_ID,
        'x-client-secret': process.env.CASHFREE_SECRET_KEY,
        'x-api-version': '2023-08-01',
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const err = new Error(errorData.message || `Cashfree returned status ${response.status}`);
      err.response = { data: errorData };
      throw err;
    }

    const cfOrder = await response.json();

    if (cfOrder.order_status === 'PAID') {
      // Use findOneAndUpdate to atomically set status to success to prevent concurrent verification duplicates
      const updatedPayment = await Payment.findOneAndUpdate(
        { _id: payment._id, status: { $ne: 'success' } },
        { 
          $set: { 
            status: 'success', 
            paymentId: cfOrder.cf_order_id ? String(cfOrder.cf_order_id) : '' 
          } 
        },
        { new: true }
      );

      // If already success, another request completed the verification, return early.
      if (!updatedPayment) {
        return res.json({ success: true, message: 'Event payment already verified and registration completed' });
      }

      // Auto-submit Form and Add Attendee
      const { eventId, guestName, guestEmail, responses } = payment.details;

      const event = await Event.findById(eventId);
      if (event) {
        const form = await EventForm.findOne({ eventId, isActive: true });
        
        // Find if user already exists
        const user = await User.findOne({ email: guestEmail.toLowerCase() });

        // Save form submission
        if (form) {
          await FormSubmission.create({
            formId: form._id,
            eventId: event._id,
            guestName,
            guestEmail,
            responses,
            status: 'approved',
            userId: user ? user._id : null
          });
        }

        // Add to Event Attendees array
        const attendeeRecord = {
          user: user ? user._id : null,
          registeredAt: new Date(),
          status: 'registered',
          paymentStatus: 'paid'
        };

        const alreadyRegistered = event.attendees.some(
          a => user && a.user?.toString() === user._id.toString()
        );

        if (!alreadyRegistered) {
          event.attendees.push(attendeeRecord);
          event.capacity.current = (event.capacity.current || 0) + 1;
          await event.save();
        }
      }

      return res.json({ success: true, message: 'Event payment verified and registration completed' });
    } else {
      payment.status = 'failed';
      await payment.save();
      return res.json({ success: false, status: cfOrder.order_status, message: 'Payment was not successful' });
    }

  } catch (error) {
    console.error('Verify event error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Verification failed', details: error.response?.data?.message || error.message });
  }
});

// 5. Cashfree standard return redirect landing
router.get('/return', (req, res) => {
  const { order_id } = req.query;
  res.send(`
    <html>
      <body style="font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background-color: #f7fafc;">
        <div style="background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); text-align: center;">
          <h2 style="color: #2d3748;">Payment Processing</h2>
          <p style="color: #4a5568;">Your payment for order <strong>${order_id}</strong> is being processed.</p>
          <p style="color: #718096; font-size: 14px;">You can close this window now.</p>
        </div>
        <script>
          setTimeout(() => {
            window.close();
          }, 3000);
        </script>
      </body>
    </html>
  `);
});

// ─── ADMIN ENDPOINTS ─────────────────────────────────────────────────────────

// 6. Get All Payments (Admin view)
router.get('/admin/all', adminAuth, async (req, res) => {
  try {
    const payments = await Payment.find({}).sort({ createdAt: -1 });
    res.json(payments);
  } catch (error) {
    console.error('Get admin payments error:', error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// 7. Delete Payment Log (Admin view)
router.delete('/admin/:id', adminAuth, async (req, res) => {
  try {
    const payment = await Payment.findByIdAndDelete(req.params.id);
    if (!payment) return res.status(404).json({ error: 'Payment record not found' });
    res.json({ success: true, message: 'Payment record deleted successfully' });
  } catch (error) {
    console.error('Delete payment error:', error);
    res.status(500).json({ error: 'Failed to delete payment record' });
  }
});

module.exports = router;
