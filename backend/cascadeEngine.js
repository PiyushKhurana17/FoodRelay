/**
 * Cascading Re-Offer Engine
 * 
 * Rules:
 * 1. Automatically re-ranks eligible recipients and re-offers available meals on reject/expiry.
 * 2. Acceptance window = min(10 minutes, 25% of remaining safe-pickup time).
 * 3. Never send the same offer/donation to the same recipient more than once.
 * 4. Prevent recipient capacity from being over-allocated (atomic reservation via projection).
 */

class CascadeEngine {
  constructor(eventStore, projectionEngine, matchingEngine) {
    this.eventStore = eventStore;
    this.projectionEngine = projectionEngine;
    this.matchingEngine = matchingEngine;
    this.donationRecipientHistory = new Map(); // donationId -> Set<recipientId>
  }

  /**
   * Calculates the exact acceptance window specified in the twist:
   * min(10 minutes, 25% of remaining safe-pickup time)
   * 
   * @param {string|Date} safePickupExpiresAt 
   * @returns {number} duration in seconds
   */
  calculateAcceptanceWindowSeconds(safePickupExpiresAt) {
    const now = Date.now();
    const expiryTime = new Date(safePickupExpiresAt).getTime();
    const remainingSafeMinutes = Math.max(1, (expiryTime - now) / 60000);
    
    // Twist rule: min(10 minutes, 25% of safe pickup time)
    const windowMinutes = Math.min(10, 0.25 * remainingSafeMinutes);
    const windowSeconds = Math.max(15, Math.round(windowMinutes * 60));
    
    return {
      windowSeconds,
      windowMinutes: parseFloat(windowMinutes.toFixed(2)),
      remainingSafeMinutes: parseFloat(remainingSafeMinutes.toFixed(1))
    };
  }

  /**
   * Get all recipient IDs that have already received an offer for this donation
   */
  getExcludedRecipientsForDonation(donationId) {
    if (!this.donationRecipientHistory.has(donationId)) {
      this.donationRecipientHistory.set(donationId, new Set());
    }
    const set = this.donationRecipientHistory.get(donationId);

    // Also consult event log history directly
    const offers = this.projectionEngine.getOffersProjection();
    for (const off of offers) {
      if (off.donationId === donationId) {
        set.add(off.recipientId);
      }
    }

    return Array.from(set);
  }

  /**
   * Initiates the first offer for a newly created donation
   */
  initiateOffer(donationId, meals, safePickupExpiresAt, foodType, donorLocation) {
    return this.triggerNextCascade(donationId, meals, safePickupExpiresAt, foodType, donorLocation, null, 1);
  }

  /**
   * Triggers the next cascade round for a donation or remaining meals
   */
  triggerNextCascade(donationId, meals, safePickupExpiresAt, foodType, donorLocation, parentOfferCode = null, cascadeRound = 1) {
    const excludedRecipients = this.getExcludedRecipientsForDonation(donationId);
    
    // Get live capacities from event projection
    const recipientCapacitiesObj = {};
    for (const rec of this.projectionEngine.getRecipientCapacitiesProjection()) {
      recipientCapacitiesObj[rec.recipientId] = rec;
    }

    const remainingSafeMinutes = Math.max(1, (new Date(safePickupExpiresAt).getTime() - Date.now()) / 60000);

    // Re-rank eligible recipients using 5-factor scoring model
    const rankedRecipients = this.matchingEngine.rankRecipients({
      id: donationId,
      mealsAvailable: meals,
      donorLocation,
      foodType,
      safePickupMinutesRemaining: remainingSafeMinutes
    }, excludedRecipients, recipientCapacitiesObj);

    if (rankedRecipients.length === 0) {
      return {
        success: false,
        exhausted: true,
        message: 'No further eligible recipients available. Cascade exhausted for this batch.'
      };
    }

    // Top ranked recipient
    const topMatch = rankedRecipients[0];
    const targetRecipient = topMatch.recipient;

    // Calculate dynamic acceptance window
    const { windowSeconds, windowMinutes } = this.calculateAcceptanceWindowSeconds(safePickupExpiresAt);
    const expiresAt = new Date(Date.now() + (windowSeconds * 1000)).toISOString();

    const offerCode = `RELAY-${Math.floor(100 + Math.random() * 900)}`;

    // Append OFFER_DISPATCHED to immutable log
    const event = this.eventStore.append('OFFER_DISPATCHED', {
      offerCode,
      donationId,
      parentOfferCode,
      recipientId: targetRecipient.id,
      recipientName: targetRecipient.name,
      meals,
      windowDurationSeconds: windowSeconds,
      expiresAt,
      rankScore: topMatch.compositeScore,
      cascadeRound,
      scoringBreakdown: topMatch.scoringBreakdown
    }, {
      source: 'CASCADE_ENGINE',
      reason: parentOfferCode ? 'Cascaded re-offer after rejection/expiry/split' : 'Initial offer dispatch'
    });

    // Mark in history so never offered to same recipient again
    if (!this.donationRecipientHistory.has(donationId)) {
      this.donationRecipientHistory.set(donationId, new Set());
    }
    this.donationRecipientHistory.get(donationId).add(targetRecipient.id);

    return {
      success: true,
      offerCode,
      event,
      targetRecipient,
      meals,
      windowSeconds,
      windowMinutes,
      expiresAt,
      rankScore: topMatch.compositeScore,
      cascadeRound
    };
  }

  /**
   * Handle an offer rejection:
   * 1. Log OFFER_REJECTED
   * 2. Automatically re-rank and cascade to next recipient
   */
  handleRejection(offerCode, reason = 'Declined by recipient') {
    const offer = this.projectionEngine.getOffer(offerCode);
    if (!offer) {
      return { success: false, error: 'Offer not found' };
    }

    if (offer.status !== 'OFFERED') {
      return { success: false, error: `Offer is already in ${offer.status} status` };
    }

    // Append to immutable log
    const rejectEvent = this.eventStore.append('OFFER_REJECTED', {
      offerCode,
      donationId: offer.donationId,
      recipientId: offer.recipientId,
      meals: offer.mealsOffered,
      reason
    }, { source: 'SMS_GATEWAY' });

    // Auto-cascade to next recipient
    const donation = this.projectionEngine.getDonation(offer.donationId);
    const safePickupExpiresAt = donation ? donation.safePickupExpiresAt : new Date(Date.now() + 3600000).toISOString();
    const foodType = donation ? donation.foodType : 'Veg';
    const donorLocation = donation ? donation.donorLocation : null;

    const cascadeResult = this.triggerNextCascade(
      offer.donationId,
      offer.mealsOffered,
      safePickupExpiresAt,
      foodType,
      donorLocation,
      offerCode,
      offer.cascadeRound + 1
    );

    return {
      success: true,
      rejectedOffer: offer,
      cascadeResult
    };
  }

  /**
   * Check for expired offers and auto-cascade
   */
  checkAndExpireOffers() {
    const now = Date.now();
    const offers = this.projectionEngine.getOffersProjection();
    const expiredResults = [];

    for (const offer of offers) {
      if (offer.status === 'OFFERED') {
        const expiresTime = new Date(offer.expiresAt).getTime();
        if (now >= expiresTime) {
          // Log OFFER_EXPIRED
          this.eventStore.append('OFFER_EXPIRED', {
            offerCode: offer.offerCode,
            donationId: offer.donationId,
            recipientId: offer.recipientId,
            meals: offer.mealsOffered,
            expiredAt: new Date().toISOString()
          }, { source: 'EXPIRY_TICKER' });

          // Auto-cascade to next recipient
          const donation = this.projectionEngine.getDonation(offer.donationId);
          const safePickupExpiresAt = donation ? donation.safePickupExpiresAt : new Date(Date.now() + 3600000).toISOString();
          const foodType = donation ? donation.foodType : 'Veg';
          const donorLocation = donation ? donation.donorLocation : null;

          const cascadeResult = this.triggerNextCascade(
            offer.donationId,
            offer.mealsOffered,
            safePickupExpiresAt,
            foodType,
            donorLocation,
            offer.offerCode,
            offer.cascadeRound + 1
          );

          expiredResults.push({
            offerCode: offer.offerCode,
            cascadeResult
          });
        }
      }
    }

    return expiredResults;
  }
}

module.exports = CascadeEngine;
