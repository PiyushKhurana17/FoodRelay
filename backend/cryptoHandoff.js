/**
 * Cryptographic Handoff Code Generator & Verifier
 * 
 * Generates rotating, cryptographically signed handoff tokens with 60-second validity.
 * Supports 100% offline verification on collector devices.
 */

const crypto = require('crypto');

// Pre-shared pilot secret key provisioned during recipient onboarding
const PILOT_SECRET = process.env.HANDOFF_SECRET || 'FOODRELAY-ZERO-SYNTAX-2026-PILOT-SECRET-KEY-99';

class CryptoHandoff {
  constructor(secret = PILOT_SECRET) {
    this.secret = secret;
  }

  /**
   * Generates a rotating 60-second signed handoff token.
   * 
   * @param {string} donationId 
   * @param {string} offerCode 
   * @param {number} meals 
   * @param {number} timestampMs 
   */
  generateHandoffToken(donationId, offerCode, meals, timestampMs = Date.now()) {
    const epochWindow = Math.floor(timestampMs / 60000); // 60s windows
    const secondsRemaining = 60 - Math.floor((timestampMs % 60000) / 1000);

    const message = `FR1:${donationId}:${offerCode}:${meals}:${epochWindow}`;
    const fullSignature = crypto.createHmac('sha256', this.secret).update(message).digest('hex');
    const shortSignature = fullSignature.substring(0, 12).toUpperCase();

    // Generate 6-digit display PIN for voice or human confirmation
    const pinNumber = parseInt(fullSignature.substring(0, 8), 16) % 1000000;
    const pin = pinNumber.toString().padStart(6, '0');
    const formattedPin = `${pin.substring(0, 3)}-${pin.substring(3, 6)}`;

    const token = `FR1.${donationId}.${offerCode}.${meals}.${epochWindow}.${shortSignature}`;

    return {
      token,
      pin: formattedPin,
      epochWindow,
      secondsRemaining,
      windowDurationSeconds: 60,
      donationId,
      offerCode,
      meals,
      tokenHash: crypto.createHash('sha256').update(token).digest('hex')
    };
  }

  /**
   * Verifies a handoff token.
   * 
   * @param {string} tokenString 
   * @param {number} timestampMs 
   */
  verifyHandoffToken(tokenString, timestampMs = Date.now()) {
    if (!tokenString || typeof tokenString !== 'string') {
      return { valid: false, error: 'Token string missing or invalid format' };
    }

    const parts = tokenString.trim().split('.');
    if (parts.length !== 6 || parts[0] !== 'FR1') {
      return { valid: false, error: 'Invalid token structure. Expected FR1.<donationId>.<offerCode>.<meals>.<epochWindow>.<sig>' };
    }

    const [prefix, donationId, offerCode, mealsStr, epochWindowStr, signature] = parts;
    const meals = parseInt(mealsStr, 10);
    const tokenEpochWindow = parseInt(epochWindowStr, 10);

    if (isNaN(meals) || isNaN(tokenEpochWindow)) {
      return { valid: false, error: 'Malformed numeric values in token' };
    }

    const currentEpochWindow = Math.floor(timestampMs / 60000);
    const windowDiff = Math.abs(currentEpochWindow - tokenEpochWindow);

    // Strict 60-second window: allow current window or immediately preceding window (clock drift tolerance <= 1 window)
    if (windowDiff > 1) {
      return {
        valid: false,
        error: `Token expired. Window difference is ${windowDiff} minutes (allowed: <= 1 min). Please request a fresh rotating code.`
      };
    }

    // Verify HMAC-SHA256 signature
    const message = `FR1:${donationId}:${offerCode}:${meals}:${tokenEpochWindow}`;
    const expectedFullSig = crypto.createHmac('sha256', this.secret).update(message).digest('hex');
    const expectedShortSig = expectedFullSig.substring(0, 12).toUpperCase();

    if (signature.toUpperCase() !== expectedShortSig) {
      return { valid: false, error: 'Cryptographic signature mismatch! Tampered or counterfeit code.' };
    }

    const tokenHash = crypto.createHash('sha256').update(tokenString).digest('hex');

    return {
      valid: true,
      donationId,
      offerCode,
      meals,
      epochWindow: tokenEpochWindow,
      tokenHash,
      verifiedOfflineCapable: true
    };
  }
}

module.exports = {
  CryptoHandoff,
  PILOT_SECRET
};
