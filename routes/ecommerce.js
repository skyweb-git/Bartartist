const express = require('express');
const router = express.Router();
const ArtistProfile = require('../models/ArtistProfile');
const Product = require('../models/Product');
const EcommercePayment = require('../models/EcommercePayment');
const { authenticate } = require('../middleware/auth');

// Admin authentication middleware
const adminAuth = async (req, res, next) => {
  if (process.env.DISABLE_ADMIN_AUTH === 'true' || process.env.NODE_ENV === 'development') {
    return next();
  }
  try {
    await authenticate(req, res, () => {
      if (req.user && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
      }
      next();
    });
  } catch (error) {
    res.status(401).json({ error: 'Authentication failed' });
  }
};

// ─── ARTIST E-COMMERCE SELLERS & PAYMENT CONFIGURATION ────────────────────

/**
 * @route   GET /api/ecommerce/sellers
 * @desc    Get all artists with their e-commerce selling status & payment setups
 * @access  Admin
 */
router.get('/sellers', adminAuth, async (req, res) => {
  try {
    const { search, isSeller } = req.query;

    const filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search.trim(), $options: 'i' } },
        { artForm: { $regex: search.trim(), $options: 'i' } },
        { email: { $regex: search.trim(), $options: 'i' } },
        { username: { $regex: search.trim(), $options: 'i' } }
      ];
    }

    if (isSeller === 'true') {
      filter.isEcommerceSeller = true;
    } else if (isSeller === 'false') {
      filter.isEcommerceSeller = false;
    }

    const artists = await ArtistProfile.find(filter).sort({ name: 1 }).lean();

    // Attach product counts for each artist
    const artistIds = artists.map(a => a._id);
    const productCounts = await Product.aggregate([
      { $match: { artistProfile: { $in: artistIds } } },
      { $group: { _id: '$artistProfile', count: { $sum: 1 }, availableCount: { $sum: { $cond: [{ $eq: ['$status', 'available'] }, 1, 0] } } } }
    ]);

    const countMap = {};
    productCounts.forEach(pc => {
      countMap[String(pc._id)] = {
        total: pc.count,
        available: pc.availableCount
      };
    });

    const enrichedArtists = artists.map(a => ({
      ...a,
      artworksCount: countMap[String(a._id)]?.total || 0,
      availableArtworksCount: countMap[String(a._id)]?.available || 0
    }));

    const totalArtists = await ArtistProfile.countDocuments();
    const totalSellers = await ArtistProfile.countDocuments({ isEcommerceSeller: true });

    res.json({
      success: true,
      artists: enrichedArtists,
      stats: {
        totalArtists,
        totalSellers,
        nonSellers: totalArtists - totalSellers
      }
    });
  } catch (error) {
    console.error('Fetch e-commerce sellers error:', error);
    res.status(500).json({ error: 'Failed to fetch e-commerce sellers.' });
  }
});

/**
 * @route   GET /api/ecommerce/sellers/:artistId/payment
 * @desc    Fetch payment details for a specific artist (used by Admin Edit Product)
 * @access  Public / Admin
 */
router.get('/sellers/:artistId/payment', async (req, res) => {
  try {
    const artist = await ArtistProfile.findById(req.params.artistId).select(
      'name isEcommerceSeller ecommercePayment email phone'
    );

    if (!artist) {
      return res.status(404).json({ error: 'Artist not found.' });
    }

    res.json({
      success: true,
      artistId: artist._id,
      name: artist.name,
      isEcommerceSeller: Boolean(artist.isEcommerceSeller),
      paymentLink: artist.ecommercePayment?.paymentLink || '',
      upiId: artist.ecommercePayment?.upiId || '',
      paymentDetails: artist.ecommercePayment || {}
    });
  } catch (error) {
    console.error('Fetch artist payment info error:', error);
    res.status(500).json({ error: 'Failed to fetch artist payment settings.' });
  }
});

/**
 * @route   PUT /api/ecommerce/sellers/:artistId
 * @desc    Admin selects artist for e-commerce and sets their payment information
 * @access  Admin
 */
router.put('/sellers/:artistId', adminAuth, async (req, res) => {
  try {
    const { isEcommerceSeller, payment, syncProducts = true } = req.body;

    const artist = await ArtistProfile.findById(req.params.artistId);
    if (!artist) {
      return res.status(404).json({ error: 'Artist not found.' });
    }

    if (isEcommerceSeller !== undefined) {
      artist.isEcommerceSeller = Boolean(isEcommerceSeller);
    }

    if (payment) {
      artist.ecommercePayment = {
        paymentLink: payment.paymentLink !== undefined ? payment.paymentLink.trim() : (artist.ecommercePayment?.paymentLink || ''),
        upiId: payment.upiId !== undefined ? payment.upiId.trim() : (artist.ecommercePayment?.upiId || ''),
        accountHolder: payment.accountHolder !== undefined ? payment.accountHolder.trim() : (artist.ecommercePayment?.accountHolder || ''),
        accountNumber: payment.accountNumber !== undefined ? payment.accountNumber.trim() : (artist.ecommercePayment?.accountNumber || ''),
        ifscCode: payment.ifscCode !== undefined ? payment.ifscCode.trim() : (artist.ecommercePayment?.ifscCode || ''),
        bankName: payment.bankName !== undefined ? payment.bankName.trim() : (artist.ecommercePayment?.bankName || ''),
        commissionRate: payment.commissionRate !== undefined ? Number(payment.commissionRate) || 0 : (artist.ecommercePayment?.commissionRate || 0),
        payoutMethod: payment.payoutMethod || artist.ecommercePayment?.payoutMethod || 'link',
        notes: payment.notes !== undefined ? payment.notes.trim() : (artist.ecommercePayment?.notes || ''),
        updatedAt: new Date()
      };
    }

    await artist.save();

    // Optionally sync the new payment link to all existing products of this artist
    let updatedProductsCount = 0;
    if (syncProducts && artist.ecommercePayment?.paymentLink) {
      const updateResult = await Product.updateMany(
        { artistProfile: artist._id },
        { $set: { paymentLink: artist.ecommercePayment.paymentLink } }
      );
      updatedProductsCount = updateResult.modifiedCount || 0;
    }

    res.json({
      success: true,
      message: `E-commerce settings updated for ${artist.name}.`,
      artist,
      syncedProductsCount: updatedProductsCount
    });
  } catch (error) {
    console.error('Update artist e-commerce seller error:', error);
    res.status(500).json({ error: error.message || 'Failed to update e-commerce seller settings.' });
  }
});

// ─── E-COMMERCE PAYMENTS & ORDERS (DISTINCT FROM /payments) ─────────────────

/**
 * @route   GET /api/ecommerce/payments
 * @desc    Get all e-commerce payments & orders
 * @access  Admin
 */
router.get('/payments', adminAuth, async (req, res) => {
  try {
    const { search, status, artistId } = req.query;

    const query = {};
    if (status && status !== 'all') {
      query.status = status;
    }
    if (artistId) {
      query.artist = artistId;
    }
    if (search) {
      query.$or = [
        { orderId: { $regex: search.trim(), $options: 'i' } },
        { buyerName: { $regex: search.trim(), $options: 'i' } },
        { buyerEmail: { $regex: search.trim(), $options: 'i' } },
        { productName: { $regex: search.trim(), $options: 'i' } },
        { artistName: { $regex: search.trim(), $options: 'i' } }
      ];
    }

    const payments = await EcommercePayment.find(query).sort({ createdAt: -1 }).lean();

    // Stats
    const all = await EcommercePayment.find({}).lean();
    let totalRevenue = 0;
    let completedRevenue = 0;
    let completedCount = 0;
    let pendingCount = 0;
    let totalCommission = 0;
    let totalPayout = 0;

    all.forEach(p => {
      totalRevenue += (p.amount || 0);
      totalCommission += (p.commissionAmount || 0);
      totalPayout += (p.artistPayoutAmount || p.amount || 0);
      if (p.status === 'completed' || p.status === 'paid') {
        completedRevenue += (p.amount || 0);
        completedCount++;
      } else if (p.status === 'pending') {
        pendingCount++;
      }
    });

    res.json({
      success: true,
      payments,
      stats: {
        totalOrders: all.length,
        totalAmount: Math.round(totalRevenue * 100) / 100,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        completedRevenue: Math.round(completedRevenue * 100) / 100,
        completedCount,
        totalPaid: completedCount,
        pendingCount,
        totalCommission: Math.round(totalCommission * 100) / 100,
        totalPayout: Math.round(totalPayout * 100) / 100
      }
    });
  } catch (error) {
    console.error('Fetch e-commerce payments error:', error);
    res.status(500).json({ error: 'Failed to fetch e-commerce payments.' });
  }
});

/**
 * @route   POST /api/ecommerce/payments
 * @desc    Record a new e-commerce artwork purchase / order
 * @access  Admin / Public
 */
router.post('/payments', async (req, res) => {
  try {
    const {
      artistId,
      productId,
      buyerName,
      buyerEmail,
      buyerPhone,
      shippingAddress,
      amount,
      paymentMethod = 'Payment Link',
      transactionId = '',
      status = 'pending',
      notes = ''
    } = req.body;

    if (!buyerName || !buyerEmail || amount === undefined) {
      return res.status(400).json({ error: 'Buyer name, email, and amount are required.' });
    }

    let artistName = '';
    let paymentLinkUsed = '';
    if (artistId) {
      const artist = await ArtistProfile.findById(artistId);
      if (artist) {
        artistName = artist.name;
        paymentLinkUsed = artist.ecommercePayment?.paymentLink || '';
      }
    }

    let productName = '';
    if (productId) {
      const product = await Product.findById(productId);
      if (product) {
        productName = product.name;
        if (!paymentLinkUsed && product.paymentLink) {
          paymentLinkUsed = product.paymentLink;
        }
      }
    }

    const orderId = `ECOM_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;

    const payment = new EcommercePayment({
      orderId,
      artist: artistId || null,
      artistName,
      product: productId || null,
      productName,
      buyerName: buyerName.trim(),
      buyerEmail: buyerEmail.trim().toLowerCase(),
      buyerPhone: buyerPhone ? buyerPhone.trim() : '',
      shippingAddress: shippingAddress || {},
      amount: Number(amount) || 0,
      paymentMethod,
      paymentLinkUsed,
      status,
      transactionId,
      notes
    });

    await payment.save();

    res.status(201).json({
      success: true,
      message: 'E-commerce payment record created successfully.',
      payment
    });
  } catch (error) {
    console.error('Create e-commerce payment error:', error);
    res.status(500).json({ error: error.message || 'Failed to create e-commerce payment record.' });
  }
});

/**
 * @route   PUT /api/ecommerce/payments/:id
 * @desc    Update e-commerce payment status or notes
 * @access  Admin
 */
router.put('/payments/:id', adminAuth, async (req, res) => {
  try {
    const { status, notes, transactionId } = req.body;

    const payment = await EcommercePayment.findById(req.params.id);
    if (!payment) {
      return res.status(404).json({ error: 'E-commerce payment record not found.' });
    }

    if (status) payment.status = status;
    if (notes !== undefined) payment.notes = notes;
    if (transactionId !== undefined) payment.transactionId = transactionId;

    await payment.save();

    res.json({
      success: true,
      message: 'Payment updated successfully.',
      payment
    });
  } catch (error) {
    console.error('Update e-commerce payment error:', error);
    res.status(500).json({ error: 'Failed to update payment record.' });
  }
});

/**
 * @route   DELETE /api/ecommerce/payments/:id
 * @desc    Delete e-commerce payment record
 * @access  Admin
 */
router.delete('/payments/:id', adminAuth, async (req, res) => {
  try {
    const payment = await EcommercePayment.findByIdAndDelete(req.params.id);
    if (!payment) {
      return res.status(404).json({ error: 'Payment record not found.' });
    }

    res.json({
      success: true,
      message: 'E-commerce payment record deleted.'
    });
  } catch (error) {
    console.error('Delete e-commerce payment error:', error);
    res.status(500).json({ error: 'Failed to delete payment record.' });
  }
});


// ─── CASHFREE PURCHASE ENDPOINTS ──────────────────────────────────────────────

/**
 * @route   POST /api/ecommerce/purchase/create-session
 * @desc    Create a Cashfree order session for buying an artwork via E-Commerce
 * @access  Public
 */
const getCashfreeBaseUrl = () => {
  const env = process.env.CASHFREE_ENV || 'TEST';
  return env === 'PRODUCTION' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
};

router.post('/purchase/create-session', async (req, res) => {
  try {
    const {
      productId,
      artistId,
      buyerName,
      buyerEmail,
      buyerPhone,
      shippingAddress
    } = req.body;

    if (!buyerName || !buyerEmail || !buyerPhone) {
      return res.status(400).json({ error: 'Buyer name, email, and phone are required.' });
    }

    // Fetch product and artist
    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    const artist = await ArtistProfile.findById(artistId || product.artistProfile);
    if (!artist) {
      return res.status(404).json({ error: 'Artist not found.' });
    }

    if (!artist.isEcommerceSeller) {
      return res.status(403).json({ error: 'This artist is not approved for e-commerce selling.' });
    }

    if (product.status !== 'available') {
      return res.status(400).json({ error: 'This artwork is not available for purchase.' });
    }

    const amount = product.price || 0;
    if (amount <= 0) {
      return res.status(400).json({ error: 'This artwork does not have a valid price set.' });
    }

    const orderId = `ECOM_CF_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;
    const cashfreeUrl = `${getCashfreeBaseUrl()}/orders`;

    const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host = req.headers.host;
    let returnUrl = `${protocol}://${host}/api/ecommerce/purchase/verify?order_id={order_id}`;
    if (returnUrl.startsWith('http://')) {
      returnUrl = returnUrl.replace('http://', 'https://');
    }

    // Calculate commission
    const commissionRate = artist.ecommercePayment?.commissionRate || 0;
    const commissionAmount = Math.round((amount * commissionRate) / 100 * 100) / 100;
    const artistPayoutAmount = Math.round((amount - commissionAmount) * 100) / 100;

    // Create Cashfree Order
    const cfResponse = await fetch(cashfreeUrl, {
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
          customer_id: buyerEmail.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 50),
          customer_name: buyerName,
          customer_email: buyerEmail,
          customer_phone: buyerPhone || '9999999999'
        },
        order_meta: {
          return_url: returnUrl
        },
        order_note: `E-Commerce: ${product.name} by ${artist.name}`
      })
    });

    if (!cfResponse.ok) {
      const errorData = await cfResponse.json().catch(() => ({}));
      throw new Error(errorData.message || `Cashfree returned status ${cfResponse.status}`);
    }

    const cfData = await cfResponse.json();

    // Save pending EcommercePayment record
    const ecomPayment = new EcommercePayment({
      orderId,
      artist: artist._id,
      artistName: artist.name,
      product: product._id,
      productName: product.name,
      buyerName: buyerName.trim(),
      buyerEmail: buyerEmail.trim().toLowerCase(),
      buyerPhone: buyerPhone ? buyerPhone.trim() : '',
      shippingAddress: shippingAddress || {},
      amount,
      commissionRate,
      commissionAmount,
      artistPayoutAmount,
      paymentMethod: 'Cashfree',
      paymentLinkUsed: artist.ecommercePayment?.paymentLink || '',
      cashfreeOrderId: orderId,
      cashfreePaymentSessionId: cfData.payment_session_id,
      cashfreeOrderStatus: 'PENDING',
      status: 'pending'
    });

    await ecomPayment.save();

    res.status(201).json({
      success: true,
      paymentSessionId: cfData.payment_session_id,
      orderId,
      amount,
      productName: product.name,
      artistName: artist.name,
      environment: process.env.CASHFREE_ENV || 'TEST'
    });

  } catch (error) {
    console.error('E-Commerce create session error:', error);
    res.status(500).json({ error: 'Failed to initiate e-commerce purchase session', details: error.message });
  }
});

/**
 * @route   GET /api/ecommerce/purchase/verify
 * @desc    Verify Cashfree payment for artwork purchase (return URL handler)
 * @access  Public
 */
router.get('/purchase/verify', async (req, res) => {
  try {
    const { order_id } = req.query;
    if (!order_id) {
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-failed?reason=missing_order`);
    }

    const ecomPayment = await EcommercePayment.findOne({ cashfreeOrderId: order_id });
    if (!ecomPayment) {
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-failed?reason=not_found`);
    }

    // Verify with Cashfree
    const cfResponse = await fetch(`${getCashfreeBaseUrl()}/orders/${order_id}`, {
      method: 'GET',
      headers: {
        'x-client-id': process.env.CASHFREE_APP_ID,
        'x-client-secret': process.env.CASHFREE_SECRET_KEY,
        'x-api-version': '2023-08-01',
        'Content-Type': 'application/json'
      }
    });

    const cfOrder = await cfResponse.json();
    console.log(`[ECOM CASHFREE] Order ${order_id} status:`, cfOrder.order_status);

    if (cfOrder.order_status === 'PAID') {
      // Update payment record
      ecomPayment.status = 'paid';
      ecomPayment.cashfreeOrderStatus = 'PAID';
      ecomPayment.transactionId = cfOrder.cf_order_id || order_id;

      // Mark product as sold
      if (ecomPayment.product) {
        await Product.findByIdAndUpdate(ecomPayment.product, { $set: { status: 'sold' } });
      }

      await ecomPayment.save();

      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      return res.redirect(`${frontendUrl}/ecommerce-success?order_id=${order_id}&product=${encodeURIComponent(ecomPayment.productName)}&artist=${encodeURIComponent(ecomPayment.artistName)}`);
    } else {
      ecomPayment.cashfreeOrderStatus = cfOrder.order_status || 'FAILED';
      ecomPayment.status = 'cancelled';
      await ecomPayment.save();

      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      return res.redirect(`${frontendUrl}/payment-failed?order_id=${order_id}`);
    }

  } catch (error) {
    console.error('E-Commerce verify error:', error);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-failed?reason=error`);
  }
});

/**
 * @route   POST /api/ecommerce/purchase/verify-session
 * @desc    Verify Cashfree payment from frontend (alternative to redirect)
 * @access  Public
 */
router.post('/purchase/verify-session', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Order ID required' });

    const ecomPayment = await EcommercePayment.findOne({ cashfreeOrderId: orderId });
    if (!ecomPayment) return res.status(404).json({ error: 'Order not found' });

    if (ecomPayment.status === 'paid') {
      return res.json({ success: true, status: 'PAID', payment: ecomPayment });
    }

    // Check with Cashfree
    const cfResponse = await fetch(`${getCashfreeBaseUrl()}/orders/${orderId}`, {
      method: 'GET',
      headers: {
        'x-client-id': process.env.CASHFREE_APP_ID,
        'x-client-secret': process.env.CASHFREE_SECRET_KEY,
        'x-api-version': '2023-08-01',
        'Content-Type': 'application/json'
      }
    });

    const cfOrder = await cfResponse.json();

    if (cfOrder.order_status === 'PAID') {
      ecomPayment.status = 'paid';
      ecomPayment.cashfreeOrderStatus = 'PAID';
      ecomPayment.transactionId = cfOrder.cf_order_id || orderId;
      if (ecomPayment.product) {
        await Product.findByIdAndUpdate(ecomPayment.product, { $set: { status: 'sold' } });
      }
      await ecomPayment.save();
      return res.json({ success: true, status: 'PAID', payment: ecomPayment });
    }

    res.json({ success: true, status: cfOrder.order_status, payment: ecomPayment });

  } catch (error) {
    console.error('E-Commerce verify-session error:', error);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

/**
 * @route   GET /api/ecommerce/artist/:artistId/sales
 * @desc    Get e-commerce sales for a specific artist (for artist dashboard)
 * @access  Public (artist sees their own)
 */
router.get('/artist/:artistId/sales', async (req, res) => {
  try {
    const { artistId } = req.params;
    const { status, page = 1, limit = 20 } = req.query;

    const query = { artist: artistId };
    if (status && status !== 'all') {
      query.status = status;
    }

    const skip = (Number(page) - 1) * Number(limit);
    const sales = await EcommercePayment.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean();

    const total = await EcommercePayment.countDocuments(query);

    // Stats for this artist
    const allSales = await EcommercePayment.find({ artist: artistId }).lean();
    let totalRevenue = 0;
    let paidCount = 0;
    let pendingCount = 0;
    let totalPayout = 0;

    allSales.forEach(s => {
      totalRevenue += (s.amount || 0);
      totalPayout += (s.artistPayoutAmount || s.amount || 0);
      if (s.status === 'paid' || s.status === 'completed') {
        paidCount++;
      } else if (s.status === 'pending') {
        pendingCount++;
      }
    });

    res.json({
      success: true,
      sales,
      pagination: {
        total,
        page: Number(page),
        pages: Math.ceil(total / Number(limit))
      },
      stats: {
        totalSales: allSales.length,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalPayout: Math.round(totalPayout * 100) / 100,
        paidCount,
        pendingCount
      }
    });

  } catch (error) {
    console.error('Get artist sales error:', error);
    res.status(500).json({ error: 'Failed to fetch artist sales.' });
  }
});

module.exports = router;
