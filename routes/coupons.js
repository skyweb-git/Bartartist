const express = require('express');
const router = express.Router();
const Coupon = require('../models/Coupon');
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

// ─── PUBLIC ENDPOINTS (Customer / User Checkout) ──────────────────────────

/**
 * @route   POST /api/coupons/validate
 * @desc    Validate a coupon code and calculate discount for an order
 * @access  Public
 */
router.post('/validate', async (req, res) => {
  try {
    const { code, amount, category = 'all', email = '', eventId = '' } = req.body;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ valid: false, error: 'Please enter a coupon code.' });
    }

    const orderAmount = Number(amount);
    if (isNaN(orderAmount) || orderAmount < 0) {
      return res.status(400).json({ valid: false, error: 'Invalid order amount.' });
    }

    const cleanCode = code.trim().toUpperCase();
    const coupon = await Coupon.findOne({ code: cleanCode });

    if (!coupon) {
      return res.status(404).json({ valid: false, error: `Coupon "${cleanCode}" does not exist.` });
    }

    const validation = coupon.validateForOrder(orderAmount, category, email, eventId);

    if (!validation.valid) {
      return res.status(400).json({ valid: false, error: validation.reason });
    }

    res.json({
      valid: true,
      message: `Coupon "${cleanCode}" applied successfully!`,
      coupon: validation.coupon,
      discount: validation.discount,
      finalAmount: validation.finalAmount
    });
  } catch (error) {
    console.error('Coupon validation error:', error);
    res.status(500).json({ valid: false, error: 'Failed to validate coupon code.' });
  }
});

/**
 * @route   POST /api/coupons/apply
 * @desc    Record usage of a coupon code upon order placement
 * @access  Public / Internal
 */
router.post('/apply', async (req, res) => {
  try {
    const { code, email = '', orderId = '', orderAmount = 0, discountApplied = 0 } = req.body;

    if (!code) {
      return res.status(400).json({ error: 'Coupon code is required.' });
    }

    const cleanCode = code.trim().toUpperCase();
    const coupon = await Coupon.findOne({ code: cleanCode });

    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found.' });
    }

    // Increment usage
    coupon.timesUsed += 1;
    coupon.usedBy.push({
      email: email.trim().toLowerCase(),
      orderId: orderId.trim(),
      orderAmount: Number(orderAmount) || 0,
      discountApplied: Number(discountApplied) || 0,
      usedAt: new Date()
    });

    await coupon.save();

    res.json({
      success: true,
      message: 'Coupon usage recorded.',
      timesUsed: coupon.timesUsed
    });
  } catch (error) {
    console.error('Coupon apply error:', error);
    res.status(500).json({ error: 'Failed to record coupon usage.' });
  }
});

// ─── ADMIN ENDPOINTS ───────────────────────────────────────────────────────

/**
 * @route   GET /api/coupons
 * @desc    Get all coupons with stats & filters
 * @access  Admin
 */
router.get('/', adminAuth, async (req, res) => {
  try {
    const { search, status, category, sort = '-createdAt' } = req.query;

    const query = {};

    if (search) {
      query.$or = [
        { code: { $regex: search.trim(), $options: 'i' } },
        { description: { $regex: search.trim(), $options: 'i' } }
      ];
    }

    const now = new Date();

    if (status === 'active') {
      query.isActive = true;
      query.$or = [
        { expiryDate: null },
        { expiryDate: { $gt: now } }
      ];
    } else if (status === 'inactive') {
      query.isActive = false;
    } else if (status === 'expired') {
      query.expiryDate = { $lt: now };
    }

    if (category && category !== 'all') {
      query.applicableTo = { $in: ['all', category] };
    }

    const coupons = await Coupon.find(query).sort(sort).lean();

    // Calculate aggregated statistics
    const allCoupons = await Coupon.find({}).lean();
    let totalRedemptions = 0;
    let totalDiscountGiven = 0;
    let activeCount = 0;
    let expiredCount = 0;

    allCoupons.forEach(c => {
      totalRedemptions += (c.timesUsed || 0);
      if (Array.isArray(c.usedBy)) {
        totalDiscountGiven += c.usedBy.reduce((sum, u) => sum + (u.discountApplied || 0), 0);
      }
      const isExpired = c.expiryDate && new Date(c.expiryDate) < now;
      if (isExpired) {
        expiredCount += 1;
      } else if (c.isActive) {
        activeCount += 1;
      }
    });

    res.json({
      success: true,
      count: coupons.length,
      coupons,
      stats: {
        totalCoupons: allCoupons.length,
        activeCoupons: activeCount,
        expiredCoupons: expiredCount,
        totalRedemptions,
        totalDiscountGiven: Math.round(totalDiscountGiven * 100) / 100
      }
    });
  } catch (error) {
    console.error('Fetch coupons error:', error);
    res.status(500).json({ error: 'Failed to fetch coupons.' });
  }
});

/**
 * @route   GET /api/coupons/:id
 * @desc    Get coupon by ID with full usage logs
 * @access  Admin
 */
router.get('/:id', adminAuth, async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found.' });
    }
    res.json({ success: true, coupon });
  } catch (error) {
    console.error('Get coupon error:', error);
    res.status(500).json({ error: 'Failed to fetch coupon details.' });
  }
});

/**
 * @route   POST /api/coupons
 * @desc    Create a new coupon code
 * @access  Admin
 */
router.post('/', adminAuth, async (req, res) => {
  try {
    const {
      code,
      description,
      discountType = 'percentage',
      discountAmount,
      minPurchaseAmount = 0,
      maxDiscountAmount,
      startDate,
      expiryDate,
      usageLimit,
      userUsageLimit = 1,
      applicableTo = 'all',
      applicableEventId,
      applicableEventTitle,
      isActive = true
    } = req.body;

    if (!code || !code.trim()) {
      return res.status(400).json({ error: 'Coupon code is required.' });
    }

    const cleanCode = code.trim().toUpperCase();

    // Check uniqueness
    const existing = await Coupon.findOne({ code: cleanCode });
    if (existing) {
      return res.status(400).json({ error: `Coupon code "${cleanCode}" already exists.` });
    }

    const numDiscount = Number(discountAmount);
    if (isNaN(numDiscount) || numDiscount <= 0) {
      return res.status(400).json({ error: 'Discount amount must be a number greater than 0.' });
    }

    if (discountType === 'percentage' && numDiscount > 100) {
      return res.status(400).json({ error: 'Percentage discount cannot exceed 100%.' });
    }

    const coupon = new Coupon({
      code: cleanCode,
      description: description ? description.trim() : '',
      discountType,
      discountAmount: numDiscount,
      minPurchaseAmount: Number(minPurchaseAmount) || 0,
      maxDiscountAmount: maxDiscountAmount ? Number(maxDiscountAmount) : null,
      startDate: startDate ? new Date(startDate) : new Date(),
      expiryDate: expiryDate ? new Date(expiryDate) : null,
      usageLimit: usageLimit ? Number(usageLimit) : null,
      userUsageLimit: userUsageLimit ? Number(userUsageLimit) : 1,
      applicableTo,
      applicableEventId: applicableTo === 'events' && applicableEventId ? applicableEventId : null,
      applicableEventTitle: applicableTo === 'events' && applicableEventTitle ? applicableEventTitle.trim() : '',
      isActive: Boolean(isActive)
    });

    await coupon.save();

    res.status(201).json({
      success: true,
      message: `Coupon "${coupon.code}" created successfully!`,
      coupon
    });
  } catch (error) {
    console.error('Create coupon error:', error);
    res.status(500).json({ error: error.message || 'Failed to create coupon.' });
  }
});

/**
 * @route   PUT /api/coupons/:id
 * @desc    Update a coupon
 * @access  Admin
 */
router.put('/:id', adminAuth, async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found.' });
    }

    const {
      code,
      description,
      discountType,
      discountAmount,
      minPurchaseAmount,
      maxDiscountAmount,
      startDate,
      expiryDate,
      usageLimit,
      userUsageLimit,
      applicableTo,
      applicableEventId,
      applicableEventTitle,
      isActive
    } = req.body;

    if (code) {
      const cleanCode = code.trim().toUpperCase();
      if (cleanCode !== coupon.code) {
        const existing = await Coupon.findOne({ code: cleanCode, _id: { $ne: coupon._id } });
        if (existing) {
          return res.status(400).json({ error: `Coupon code "${cleanCode}" already exists.` });
        }
        coupon.code = cleanCode;
      }
    }

    if (description !== undefined) coupon.description = description.trim();
    if (discountType) coupon.discountType = discountType;
    if (discountAmount !== undefined) {
      const num = Number(discountAmount);
      if (isNaN(num) || num <= 0) {
        return res.status(400).json({ error: 'Discount amount must be a number greater than 0.' });
      }
      if (coupon.discountType === 'percentage' && num > 100) {
        return res.status(400).json({ error: 'Percentage discount cannot exceed 100%.' });
      }
      coupon.discountAmount = num;
    }
    if (minPurchaseAmount !== undefined) coupon.minPurchaseAmount = Number(minPurchaseAmount) || 0;
    if (maxDiscountAmount !== undefined) coupon.maxDiscountAmount = maxDiscountAmount ? Number(maxDiscountAmount) : null;
    if (startDate !== undefined) coupon.startDate = startDate ? new Date(startDate) : coupon.startDate;
    if (expiryDate !== undefined) coupon.expiryDate = expiryDate ? new Date(expiryDate) : null;
    if (usageLimit !== undefined) coupon.usageLimit = usageLimit ? Number(usageLimit) : null;
    if (userUsageLimit !== undefined) coupon.userUsageLimit = userUsageLimit ? Number(userUsageLimit) : 1;
    if (applicableTo !== undefined) {
      coupon.applicableTo = applicableTo;
      if (applicableTo !== 'events') {
        coupon.applicableEventId = null;
        coupon.applicableEventTitle = '';
      }
    }
    if (applicableEventId !== undefined) {
      coupon.applicableEventId = coupon.applicableTo === 'events' && applicableEventId ? applicableEventId : null;
    }
    if (applicableEventTitle !== undefined) {
      coupon.applicableEventTitle = coupon.applicableTo === 'events' && applicableEventTitle ? applicableEventTitle.trim() : '';
    }
    if (isActive !== undefined) coupon.isActive = Boolean(isActive);

    await coupon.save();

    res.json({
      success: true,
      message: `Coupon "${coupon.code}" updated successfully!`,
      coupon
    });
  } catch (error) {
    console.error('Update coupon error:', error);
    res.status(500).json({ error: error.message || 'Failed to update coupon.' });
  }
});

/**
 * @route   PATCH /api/coupons/:id/toggle
 * @desc    Toggle coupon active status
 * @access  Admin
 */
router.patch('/:id/toggle', adminAuth, async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found.' });
    }

    coupon.isActive = !coupon.isActive;
    await coupon.save();

    res.json({
      success: true,
      message: `Coupon "${coupon.code}" is now ${coupon.isActive ? 'Active' : 'Inactive'}.`,
      isActive: coupon.isActive
    });
  } catch (error) {
    console.error('Toggle coupon error:', error);
    res.status(500).json({ error: 'Failed to toggle coupon status.' });
  }
});

/**
 * @route   DELETE /api/coupons/:id
 * @desc    Delete a coupon
 * @access  Admin
 */
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found.' });
    }

    res.json({
      success: true,
      message: `Coupon "${coupon.code}" deleted successfully.`
    });
  } catch (error) {
    console.error('Delete coupon error:', error);
    res.status(500).json({ error: 'Failed to delete coupon.' });
  }
});

module.exports = router;
