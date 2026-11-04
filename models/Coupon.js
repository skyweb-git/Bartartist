const mongoose = require('mongoose');

const usageLogSchema = new mongoose.Schema({
  email: {
    type: String,
    trim: true,
    lowercase: true,
    default: ''
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  orderId: {
    type: String,
    default: ''
  },
  orderAmount: {
    type: Number,
    default: 0
  },
  discountApplied: {
    type: Number,
    required: true
  },
  usedAt: {
    type: Date,
    default: Date.now
  }
}, { _id: true });

const couponSchema = new mongoose.Schema({
  code: {
    type: String,
    required: [true, 'Coupon code is required'],
    unique: true,
    uppercase: true,
    trim: true,
    minlength: [3, 'Coupon code must be at least 3 characters'],
    maxlength: [30, 'Coupon code cannot exceed 30 characters'],
    index: true
  },
  description: {
    type: String,
    trim: true,
    default: ''
  },
  discountType: {
    type: String,
    enum: {
      values: ['percentage', 'fixed'],
      message: 'Discount type must be percentage or fixed'
    },
    default: 'percentage',
    required: true
  },
  discountAmount: {
    type: Number,
    required: [true, 'Discount amount is required'],
    min: [0, 'Discount amount must be non-negative']
  },
  minPurchaseAmount: {
    type: Number,
    default: 0,
    min: [0, 'Minimum purchase amount must be non-negative']
  },
  maxDiscountAmount: {
    type: Number,
    default: null,
    min: [0, 'Maximum discount cap must be non-negative']
  },
  startDate: {
    type: Date,
    default: Date.now
  },
  expiryDate: {
    type: Date,
    default: null
  },
  usageLimit: {
    type: Number,
    default: null,
    min: [0, 'Usage limit must be non-negative']
  },
  timesUsed: {
    type: Number,
    default: 0,
    min: [0, 'Times used cannot be negative']
  },
  userUsageLimit: {
    type: Number,
    default: 1,
    min: [1, 'User usage limit must be at least 1']
  },
  applicableTo: {
    type: String,
    enum: {
      values: ['all', 'products', 'events', 'membership', 'art-district'],
      message: 'Invalid applicability category'
    },
    default: 'all'
  },
  applicableEventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Event',
    default: null
  },
  applicableEventTitle: {
    type: String,
    default: ''
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  usedBy: [usageLogSchema]
}, {
  timestamps: true
});

// Helper method to check if coupon is currently valid
couponSchema.methods.validateForOrder = function(orderAmount = 0, category = 'all', userEmail = '', eventId = '') {
  const now = new Date();

  if (!this.isActive) {
    return { valid: false, reason: 'This coupon is currently inactive.' };
  }

  if (this.startDate && now < this.startDate) {
    return { valid: false, reason: 'This coupon is not active yet.' };
  }

  if (this.expiryDate && now > this.expiryDate) {
    return { valid: false, reason: 'This coupon has expired.' };
  }

  if (this.usageLimit && this.usageLimit > 0 && this.timesUsed >= this.usageLimit) {
    return { valid: false, reason: 'This coupon has reached its maximum total usage limit.' };
  }

  if (this.minPurchaseAmount > 0 && orderAmount < this.minPurchaseAmount) {
    return { 
      valid: false, 
      reason: `Minimum order amount of ₹${this.minPurchaseAmount.toLocaleString()} required to use this coupon.` 
    };
  }

  if (this.applicableTo !== 'all' && category !== 'all' && this.applicableTo !== category) {
    return { 
      valid: false, 
      reason: `This coupon is only applicable for ${this.applicableTo}.` 
    };
  }

  // If coupon is restricted to a specific event
  if (this.applicableTo === 'events' && this.applicableEventId) {
    if (!eventId || String(this.applicableEventId) !== String(eventId)) {
      return {
        valid: false,
        reason: this.applicableEventTitle 
          ? `This coupon is only valid for event: "${this.applicableEventTitle}".` 
          : 'This coupon is not valid for this specific event.'
      };
    }
  }

  if (userEmail && this.userUsageLimit) {
    const userUsages = this.usedBy.filter(u => u.email && u.email.toLowerCase() === userEmail.toLowerCase()).length;
    if (userUsages >= this.userUsageLimit) {
      return { 
        valid: false, 
        reason: `You have already used this coupon the maximum allowed times (${this.userUsageLimit}).` 
      };
    }
  }

  // Calculate discount
  let discount = 0;
  if (this.discountType === 'percentage') {
    discount = (orderAmount * this.discountAmount) / 100;
    if (this.maxDiscountAmount && this.maxDiscountAmount > 0) {
      discount = Math.min(discount, this.maxDiscountAmount);
    }
  } else {
    // Fixed amount
    discount = Math.min(this.discountAmount, orderAmount);
  }

  discount = Math.round(discount * 100) / 100;
  const finalAmount = Math.max(0, Math.round((orderAmount - discount) * 100) / 100);

  return {
    valid: true,
    discount,
    finalAmount,
    coupon: {
      id: this._id,
      code: this.code,
      description: this.description,
      discountType: this.discountType,
      discountAmount: this.discountAmount,
      maxDiscountAmount: this.maxDiscountAmount,
      minPurchaseAmount: this.minPurchaseAmount,
      applicableTo: this.applicableTo,
      applicableEventId: this.applicableEventId,
      applicableEventTitle: this.applicableEventTitle
    }
  };
};

module.exports = mongoose.model('Coupon', couponSchema);
