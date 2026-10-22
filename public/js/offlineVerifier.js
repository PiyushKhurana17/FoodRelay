/**
 * Offline Cryptographic Verifier for FoodRelay Collector Device
 * 
 * Works 100% offline without any internet connection.
 * Uses client-side Web Crypto API / self-contained SHA-256 HMAC.
 * Enforces:
 * - 60s rotating window validation
 * - HMAC-SHA256 cryptographic authenticity
 * - Anti-replay protection (offline cache)
 * - Offline queue storage in localStorage
 */

const PILOT_SECRET = 'FOODRELAY-ZERO-SYNTAX-2026-PILOT-SECRET-KEY-99';

// Self-contained fast HMAC-SHA256 implementation for offline browsers
class OfflineVerifier {
  constructor(secret = PILOT_SECRET) {
    this.secret = secret;
    this.storageKeyScanned = 'foodrelay_offline_scanned_hashes';
    this.storageKeyQueue = 'foodrelay_offline_queue';
  }

  getScannedHashes() {
    try {
      const data = localStorage.getItem(this.storageKeyScanned);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  saveScannedHash(hash) {
    const list = this.getScannedHashes();
    if (!list.includes(hash)) {
      list.push(hash);
      localStorage.setItem(this.storageKeyScanned, JSON.stringify(list));
    }
  }

  getOfflineQueue() {
    try {
      const data = localStorage.getItem(this.storageKeyQueue);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  addToOfflineQueue(record) {
    const queue = this.getOfflineQueue();
    queue.push(record);
    localStorage.setItem(this.storageKeyQueue, JSON.stringify(queue));
  }

  clearOfflineQueue() {
    localStorage.removeItem(this.storageKeyQueue);
  }

  clearScannedHashes() {
    localStorage.removeItem(this.storageKeyScanned);
  }

  /**
   * Fast SHA-256 in browser
   */
  async sha256Hex(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Fast HMAC-SHA256 in browser using Web Crypto API
   */
  async hmacSha256Hex(key, message) {
    const enc = new TextEncoder();
    const cryptoKey = await window.crypto.subtle.importKey(
      'raw',
      enc.encode(key),
      { name: 'HMAC', hash: { name: 'SHA-256' } },
      false,
      ['sign']
    );
    const signature = await window.crypto.subtle.sign(
      'HMAC',
      cryptoKey,
      enc.encode(message)
    );
    const hashArray = Array.from(new Uint8Array(signature));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Fully offline verification method
   */
  async verifyOfflineToken(tokenString, simulatedTimeMs = null) {
    const now = simulatedTimeMs || Date.now();

    if (!tokenString || typeof tokenString !== 'string') {
      return { valid: false, error: 'Empty or invalid token string' };
    }

    const parts = tokenString.trim().split('.');
    if (parts.length !== 6 || parts[0] !== 'FR1') {
      return {
        valid: false,
        error: 'Malformed token structure. Expected FR1.<donationId>.<offerCode>.<meals>.<epochWindow>.<signature>'
      };
    }

    const [prefix, donationId, offerCode, mealsStr, epochWindowStr, signature] = parts;
    const meals = parseInt(mealsStr, 10);
    const tokenEpochWindow = parseInt(epochWindowStr, 10);

    if (isNaN(meals) || isNaN(tokenEpochWindow)) {
      return { valid: false, error: 'Invalid numeric data in token' };
    }

    // 1. Check Rotating 60s Window (allowing +/- 1 window drift)
    const currentEpochWindow = Math.floor(now / 60000);
    const windowDiff = Math.abs(currentEpochWindow - tokenEpochWindow);

    if (windowDiff > 1) {
      return {
        valid: false,
        error: `EXPIRED: Token is from window #${tokenEpochWindow}, current window is #${currentEpochWindow} (time window: 60s). Code expired.`
      };
    }

    // 2. Cryptographic signature check
    const message = `FR1:${donationId}:${offerCode}:${meals}:${tokenEpochWindow}`;
    const calculatedFullSig = await this.hmacSha256Hex(this.secret, message);
    const expectedShortSig = calculatedFullSig.substring(0, 12).toUpperCase();

    if (signature.toUpperCase() !== expectedShortSig) {
      return {
        valid: false,
        error: 'SIGNATURE MISMATCH: Cryptographic verification failed! Counterfeit or altered token.'
      };
    }

    // 3. Compute token hash for anti-replay tracking
    const tokenHash = await this.sha256Hex(tokenString);

    // 4. Anti-Replay Check: Has this code been scanned offline already?
    const alreadyScanned = this.getScannedHashes();
    if (alreadyScanned.includes(tokenHash)) {
      return {
        valid: false,
        error: 'ANTI-REPLAY VIOLATION: This rotating code has ALREADY been used and scanned. Cannot double-collect!'
      };
    }

    // Record in local anti-replay ledger
    this.saveScannedHash(tokenHash);

    // Save into offline collection queue
    const collectionRecord = {
      donationId,
      offerCode,
      meals,
      tokenString,
      tokenHash,
      timestampMs: now,
      verifiedOffline: true,
      scannedAt: new Date(now).toISOString()
    };
    this.addToOfflineQueue(collectionRecord);

    return {
      valid: true,
      donationId,
      offerCode,
      meals,
      tokenEpochWindow,
      tokenHash,
      collectionRecord,
      message: 'Verified Offline Successfully! Code authenticity confirmed via local pre-shared key.'
    };
  }
}

// Export for browser
window.OfflineVerifier = OfflineVerifier;
