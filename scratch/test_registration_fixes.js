const mongoose = require('mongoose');
require('dotenv').config();
const User = require('../models/User');
const Event = require('../models/Event');
const EventForm = require('../models/EventForm');
const FormSubmission = require('../models/FormSubmission');
const Payment = require('../models/Payment');

async function test() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected!');

    // 1. Create mock data
    const uniqueId = new mongoose.Types.ObjectId().toString();
    const guestEmail = `test_guest_${uniqueId}@example.com`;
    const guestName = `Test Guest ${uniqueId}`;

    console.log('Creating mock event...');
    const organizer = await User.findOne({}) || new User({
      email: 'organizer@example.com',
      displayName: 'Organizer',
      firebaseUid: 'mock_org_uid_' + uniqueId
    });
    if (!organizer._id) await organizer.save();

    const event = new Event({
      title: 'Mock Test Event ' + uniqueId,
      description: 'A mock event for testing fixes',
      category: 'exhibition',
      organizer: organizer._id,
      date: { start: new Date(), end: new Date(Date.now() + 3600000) },
      location: { type: 'physical', city: 'Delhi' },
      pricing: { type: 'paid', amount: 100 },
      status: 'published'
    });
    await event.save();

    const form = new EventForm({
      eventId: event._id,
      title: 'Registration Form',
      isActive: true,
      fields: [
        { label: 'Category', type: 'select', required: true, options: ['Art', 'Craft'] }
      ]
    });
    await form.save();

    const orderId = 'order_' + uniqueId;
    const payment = new Payment({
      orderId,
      amount: 100,
      currency: 'INR',
      status: 'pending',
      type: 'event',
      email: guestEmail,
      name: guestName,
      details: {
        eventId: event._id,
        guestName,
        guestEmail,
        guestPhone: '9999999999',
        responses: [
          { fieldLabel: 'Category', fieldType: 'select', value: 'Craft Category Selected' }
        ]
      }
    });
    await payment.save();

    // 2. Simulate concurrent verify-event execution (optimistic locking verification)
    console.log('\n--- Simulating concurrent verify-event calls ---');
    
    // Simulate PAID check with findOneAndUpdate
    const runVerification = async (callNum) => {
      console.log(`Call ${callNum}: Verifying PAID status...`);
      const paymentRecord = await Payment.findOne({ orderId, type: 'event' });
      if (paymentRecord.status === 'success') {
        return { success: true, alreadyCompleted: true };
      }

      // Cashfree mock: PAID status response from Cashfree API
      // Atomically mark status to success
      const updatedPayment = await Payment.findOneAndUpdate(
        { _id: paymentRecord._id, status: { $ne: 'success' } },
        { $set: { status: 'success', paymentId: 'cf_pay_' + uniqueId } },
        { new: true }
      );

      if (!updatedPayment) {
        console.log(`Call ${callNum}: Optimistic lock triggered, return alreadyCompleted`);
        return { success: true, alreadyCompleted: true };
      }

      console.log(`Call ${callNum}: Optimistic lock acquired! Creating registration...`);
      // Perform DB registration
      const { eventId, responses } = updatedPayment.details;
      const targetEvent = await Event.findById(eventId);
      const targetForm = await EventForm.findOne({ eventId, isActive: true });
      const user = await User.findOne({ email: guestEmail.toLowerCase() });

      if (targetForm) {
        await FormSubmission.create({
          formId: targetForm._id,
          eventId: targetEvent._id,
          guestName,
          guestEmail,
          responses,
          status: 'approved',
          userId: user ? user._id : null
        });
      }

      const attendeeRecord = {
        user: user ? user._id : null,
        registeredAt: new Date(),
        status: 'registered',
        paymentStatus: 'paid'
      };

      targetEvent.attendees.push(attendeeRecord);
      targetEvent.capacity.current = (targetEvent.capacity.current || 0) + 1;
      await targetEvent.save();

      return { success: true, newlyCompleted: true };
    };

    // Run both parallel calls
    const [res1, res2] = await Promise.all([
      runVerification(1),
      runVerification(2)
    ]);

    console.log('Call 1 Result:', res1);
    console.log('Call 2 Result:', res2);

    // Verify registrations
    const submissionCount = await FormSubmission.countDocuments({ eventId: event._id });
    const finalEvent = await Event.findById(event._id);
    console.log(`Form Submissions count: ${submissionCount} (Expected: 1)`);
    console.log(`Event Attendees count: ${finalEvent.attendees.length} (Expected: 1)`);

    if (submissionCount !== 1 || finalEvent.attendees.length !== 1) {
      throw new Error('Verification failed: Duplicate registrations created!');
    }
    console.log('✅ Success: Duplicate calls correctly debounced using optimistic locking.');

    // 3. Verify category extraction
    console.log('\n--- Verifying Category Extraction in Admin Route logic ---');
    const getCategoryFromResponses = (responses) => {
      if (!Array.isArray(responses)) return '';
      const catField = responses.find(r => 
        /category|art.*craft|type|role|class/i.test(r.fieldLabel || '')
      );
      if (catField && catField.value) {
        const val = catField.value.trim();
        if (/art/i.test(val)) return 'Art';
        if (/craft/i.test(val)) return 'Craft';
        return val;
      }
      for (const r of responses) {
        const val = (r.value || '').trim();
        if (/art/i.test(val)) return 'Art';
        if (/craft/i.test(val)) return 'Craft';
      }
      return '';
    };

    const firstSub = await FormSubmission.findOne({ eventId: event._id });
    const extractedCategory = getCategoryFromResponses(firstSub.responses);
    console.log(`Extracted Category from "${firstSub.responses[0].value}": ${extractedCategory} (Expected: Craft)`);
    if (extractedCategory !== 'Craft') {
      throw new Error('Verification failed: Category extraction incorrect!');
    }
    console.log('✅ Success: Category extraction works perfectly.');

    // 4. Verify self-healing guest linking
    console.log('\n--- Verifying Self-Healing Guest Linking ---');
    // Create the User account afterwards
    console.log('Creating User account post-registration...');
    const guestUser = new User({
      email: guestEmail,
      displayName: 'Registered Guest',
      firebaseUid: 'guest_uid_' + uniqueId
    });
    await guestUser.save();

    // Mock GET /registered-events logic
    const req = {
      user: {
        userId: guestUser._id,
        email: guestEmail
      }
    };

    console.log('Running self-healing linking...');
    const userEmail = req.user.email ? req.user.email.toLowerCase() : '';
    await FormSubmission.updateMany(
      { guestEmail: userEmail, userId: null },
      { $set: { userId: req.user.userId } }
    );

    const userSubmissions = await FormSubmission.find({ userId: req.user.userId });
    const eventIdsFromSubs = userSubmissions.map(s => s.eventId).filter(Boolean);

    if (eventIdsFromSubs.length > 0) {
      const eventsToLink = await Event.find({
        _id: { $in: eventIdsFromSubs }
      });

      for (const ev of eventsToLink) {
        let updated = false;
        const eventSubs = userSubmissions.filter(
          s => s.eventId && s.eventId.toString() === ev._id.toString()
        );
        const N = eventSubs.length;

        const userAttendees = ev.attendees.filter(
          a => a.user && a.user.toString() === req.user.userId.toString()
        );
        const M = userAttendees.length;

        if (M < N) {
          const diff = N - M;
          let linkedCount = 0;
          for (const a of ev.attendees) {
            if (!a.user) {
              a.user = req.user.userId;
              linkedCount++;
              if (linkedCount === diff) break;
            }
          }
          if (linkedCount < diff) {
            for (let k = 0; k < (diff - linkedCount); k++) {
              ev.attendees.push({
                user: req.user.userId,
                registeredAt: new Date(),
                status: 'registered',
                paymentStatus: 'paid'
              });
            }
          }
          updated = true;
        }

        if (updated) {
          await ev.save();
        }
      }
    }

    const linkedSub = await FormSubmission.findOne({ guestEmail });
    const linkedEvent = await Event.findById(event._id);
    console.log(`Linked FormSubmission userId: ${linkedSub.userId} (Expected: ${guestUser._id})`);
    console.log(`Linked Event attendee user: ${linkedEvent.attendees[0].user} (Expected: ${guestUser._id})`);

    if (String(linkedSub.userId) !== String(guestUser._id) || String(linkedEvent.attendees[0].user) !== String(guestUser._id)) {
      throw new Error('Verification failed: Self-healing guest linking failed!');
    }
    console.log('✅ Success: Self-healing linking completed perfectly.');

    // Cleanup
    console.log('\nCleaning up mock data...');
    await Payment.deleteOne({ orderId });
    await FormSubmission.deleteOne({ eventId: event._id });
    await EventForm.deleteOne({ _id: form._id });
    await Event.deleteOne({ _id: event._id });
    await User.deleteOne({ _id: guestUser._id });
    console.log('Cleanup completed.');

  } catch (err) {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected.');
  }
}

test();
