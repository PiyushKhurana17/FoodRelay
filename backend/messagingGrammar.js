/**
 * Plain-Text Messaging Grammar Parser & Handler
 * 
 * Enforces strict grammar for two-way SMS / WhatsApp / Telegram:
 * - Y <offer-code> <meals>  — accept specified number of meals
 * - N <offer-code>          — reject offer
 * 
 * Handles Partial Acceptance splits and immediately triggers cascade for remaining meals.
 */

class MessagingGrammar {
  constructor(eventStore, projectionEngine, cascadeEngine) {
    this.eventStore = eventStore;
    this.projectionEngine = projectionEngine;
    this.cascadeEngine = cascadeEngine;
  }

  /**
   * Parse incoming plain text message
   * @param {string} rawText 
   */
  parseMessage(rawText) {
    if (!rawText || typeof rawText !== 'string') {
      return { valid: false, error: 'Empty message text' };
    }

    const trimmed = rawText.trim();

    // Match ACCEPT: Y <offer-code> <meals>
    const acceptMatch = trimmed.match(/^Y\s+([A-Za-z0-9\-]+)\s+(\d+)$/i);
    if (acceptMatch) {
      return {
        valid: true,
        action: 'ACCEPT',
        offerCode: acceptMatch[1].toUpperCase(),
        meals: parseInt(acceptMatch[2], 10),
        raw: trimmed
      };
    }

    // Match REJECT: N <offer-code>
    const rejectMatch = trimmed.match(/^N\s+([A-Za-z0-9\-]+)$/i);
    if (rejectMatch) {
      return {
        valid: true,
        action: 'REJECT',
        offerCode: rejectMatch[1].toUpperCase(),
        raw: trimmed
      };
    }

    // Invalid format
    return {
      valid: false,
      error: 'Invalid format. Strict format required: "Y <offer-code> <meals>" to accept, or "N <offer-code>" to reject. Example: "Y RELAY-101 30"',
      raw: trimmed
    };
  }

  /**
   * Process incoming SMS message from recipient
   * 
   * @param {string} senderPhone 
   * @param {string} messageText 
   */
  processIncomingMessage(senderPhone, messageText) {
    const parsed = this.parseMessage(messageText);

    if (!parsed.valid) {
      return {
        success: false,
        status: 'GRAMMAR_ERROR',
        replyMessage: `[FoodRelay Error] ${parsed.error}`,
        parsed
      };
    }

    const { action, offerCode } = parsed;
    const offer = this.projectionEngine.getOffer(offerCode);

    if (!offer) {
      return {
        success: false,
        status: 'OFFER_NOT_FOUND',
        replyMessage: `[FoodRelay Error] Offer code "${offerCode}" was not found or has expired.`,
        parsed
      };
    }

    if (offer.status !== 'OFFERED') {
      return {
        success: false,
        status: 'OFFER_NOT_ACTIVE',
        replyMessage: `[FoodRelay Notice] Offer "${offerCode}" is no longer active (current status: ${offer.status}).`,
        parsed
      };
    }

    // Check expiration time
    if (Date.now() >= new Date(offer.expiresAt).getTime()) {
      // Trigger expiry if not yet marked
      this.cascadeEngine.checkAndExpireOffers();
      return {
        success: false,
        status: 'OFFER_EXPIRED',
        replyMessage: `[FoodRelay Notice] Acceptance window for offer "${offerCode}" has closed. Meals were cascaded to the next recipient.`,
        parsed
      };
    }

    // Handle REJECTION: N <offer-code>
    if (action === 'REJECT') {
      const rejectResult = this.cascadeEngine.handleRejection(offerCode, 'Rejected via SMS grammar');
      return {
        success: true,
        status: 'REJECTED_AND_CASCADED',
        replyMessage: `[FoodRelay] Offer ${offerCode} declined. Thank you for the quick response! Available meals have cascaded to the next partner.`,
        offerCode,
        cascadeResult: rejectResult.cascadeResult
      };
    }

    // Handle ACCEPTANCE: Y <offer-code> <meals>
    if (action === 'ACCEPT') {
      const requestedMeals = parsed.meals;

      if (requestedMeals <= 0) {
        return {
          success: false,
          status: 'INVALID_MEAL_COUNT',
          replyMessage: `[FoodRelay Error] Meal count must be greater than 0.`,
          parsed
        };
      }

      if (requestedMeals > offer.mealsOffered) {
        return {
          success: false,
          status: 'EXCEEDS_OFFERED',
          replyMessage: `[FoodRelay Error] Requested ${requestedMeals} meals, but only ${offer.mealsOffered} meals are available in offer ${offerCode}.`,
          parsed
        };
      }

      const donation = this.projectionEngine.getDonation(offer.donationId);

      // Check recipient capacity limit from event projection
      const recCap = this.projectionEngine.recipientCapacities.get(offer.recipientId);
      if (recCap) {
        // Since offer is currently reserved, we compare requestedMeals against maxCapacity
        const currentCommitted = recCap.allocatedMeals;
        if (currentCommitted + requestedMeals > recCap.maxCapacity) {
          const maxPossible = Math.max(0, recCap.maxCapacity - currentCommitted);
          return {
            success: false,
            status: 'CAPACITY_EXCEEDED',
            replyMessage: `[FoodRelay Error] Capacity limit reached. You can currently accept a maximum of ${maxPossible} meals.`,
            parsed
          };
        }
      }

      // Check whether this is a full acceptance or a partial acceptance split
      const isPartial = requestedMeals < offer.mealsOffered;
      const remainingMeals = offer.mealsOffered - requestedMeals;

      // 1. Append OFFER_ACCEPTED
      this.eventStore.append('OFFER_ACCEPTED', {
        offerCode,
        donationId: offer.donationId,
        recipientId: offer.recipientId,
        recipientName: offer.recipientName,
        mealsAccepted: requestedMeals,
        acceptedAt: new Date().toISOString()
      }, { source: 'SMS_GATEWAY' });

      let cascadeResult = null;

      // 2. If partial acceptance, split offer and cascade the remainder immediately!
      if (isPartial) {
        const remainingOfferCode = `${offerCode}-B`;
        this.eventStore.append('OFFER_SPLIT', {
          originalOfferCode: offerCode,
          acceptedOfferCode: offerCode,
          remainingOfferCode,
          donationId: offer.donationId,
          acceptedMeals: requestedMeals,
          remainingMeals,
          splitAt: new Date().toISOString()
        }, { source: 'MESSAGING_GRAMMAR' });

        // Cascade the remaining meals immediately to next ranked recipient!
        const safePickupExpiresAt = donation ? donation.safePickupExpiresAt : new Date(Date.now() + 3600000).toISOString();
        const foodType = donation ? donation.foodType : 'Veg';
        const donorLocation = donation ? donation.donorLocation : null;

        cascadeResult = this.cascadeEngine.triggerNextCascade(
          offer.donationId,
          remainingMeals,
          safePickupExpiresAt,
          foodType,
          donorLocation,
          offerCode,
          offer.cascadeRound + 1
        );
      }

      const splitNotice = isPartial
        ? `\nPartial acceptance recorded! Remaining ${remainingMeals} meals returned to cascade engine.`
        : '';

      return {
        success: true,
        status: isPartial ? 'PARTIALLY_ACCEPTED_AND_CASCADED' : 'FULLY_ACCEPTED',
        replyMessage: `[FoodRelay Confirmed] Successfully reserved ${requestedMeals} meals for ${offer.recipientName}!${splitNotice}\nPickup at ${donation ? donation.canteenName : 'Canteen'}. Present rotating handoff code upon arrival.`,
        offerCode,
        mealsAccepted: requestedMeals,
        remainingMeals: isPartial ? remainingMeals : 0,
        cascadeResult
      };
    }

    return { success: false, status: 'UNHANDLED_ACTION' };
  }
}

module.exports = MessagingGrammar;
