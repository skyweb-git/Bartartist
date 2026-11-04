const mongoose = require('mongoose');

const ecommercePaymentSchema = new mongoose.Schema(
  {
    orderId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    artist: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ArtistProfile',
      default: null,
      index: true
    },
    artistName: {
      type: String,
      default: '',
      trim: true
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      default: null
    },
    productName: {
      type: String,
      default: '',
      trim: true
    },
    buyerName: {
      type: String,
      required: true,
      trim: true
    },
    buyerEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
    },
    buyerPhone: {
      type: String,
      default: '',
      trim: true
    },
    shippingAddress: {
      street: { type: String, default: '' },
      city: { type: String, default: '' },
      state: { type: String, default: '' },
      pincode: { type: String, default: '' },
      country: { type: String, default: 'India' }
    },
    amount: {
      type: Number,
      required: true,
      min: 0
    },
    currency: {
      type: String,
      default: 'INR'
    },
    paymentMethod: {
      type: String,
      default: 'Payment Link',
      trim: true
    },
    paymentLinkUsed: {
      type: String,
      default: ''
    },
    status: {
      type: String,
      enum: ['pending', 'paid', 'completed', 'cancelled', 'refunded'],
      default: 'pending',
      index: true
    },
    transactionId: {
      type: String,
      default: ''
    },
    cashfreeOrderId: {
      type: String,
      default: ''
    },
    cashfreePaymentSessionId: {
      type: String,
      default: ''
    },
    cashfreeOrderStatus: {
      type: String,
      default: ''
    },
    commissionRate: {
      type: Number,
      default: 0
    },
    commissionAmount: {
      type: Number,
      default: 0
    },
    artistPayoutAmount: {
      type: Number,
      default: 0
    },
    notes: {
      type: String,
      default: ''
    }
  },
  {
    timestamps: true
  }
);

ecommercePaymentSchema.index({ createdAt: -1 });

module.exports = mongoose.model('EcommercePayment', ecommercePaymentSchema);
