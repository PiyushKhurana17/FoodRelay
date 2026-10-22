/**
 * Projection Engine for FoodRelay (Zero Syntax 2026, Team Vayu9)
 * 
 * Replays the append-only event log to derive:
 * - Current Offer Statuses
 * - Recipient Capacities (Anti-Double-Allocation across concurrent donations)
 * - Impact Metrics (UNEP pilot targets: meals, acceptance rate, collection rate, CO2, speed)
 * - Cryptographic Anti-Replay Ledger
 */

const { VERIFIED_RECIPIENTS } = require('./matchingEngine');

class ProjectionEngine {
  constructor(eventStore) {
    this.eventStore = eventStore;
    this.offers = new Map();
    this.donations = new Map();
    this.recipientCapacities = new Map();
    this.usedHandoffCodes = new Set();
    this.impactMetrics = {
      totalDonationsCreated: 0,
      totalMealsListed: 0,
      totalMealsAccepted: 0,
      totalMealsCollected: 0,
      totalOffersDispatched: 0,
      totalOffersRejected: 0,
      totalOffersExpired: 0,
      totalCascadesTriggered: 0,
      partialAcceptanceSplits: 0,
      acceptanceTimesMinutes: [],
      medianTimeToAcceptMinutes: 0,
      co2SavedKg: 0, // 1.9 kg CO2e per meal rescued (UNEP baseline)
      acceptanceRatePercent: 0,
      collectionRatePercent: 0
    };

    this.initRecipients();

    // Subscribe to live events
    if (this.eventStore) {
      this.eventStore.subscribe(event => this.applyEvent(event));
      // Replay existing events on startup
      this.replayAll();
    }
  }

  initRecipients() {
    this.recipientCapacities.clear();
    for (const r of VERIFIED_RECIPIENTS) {
      this.recipientCapacities.set(r.id, {
        recipientId: r.id,
        name: r.name,
        contactPhone: r.contactPhone,
        type: r.type,
        maxCapacity: r.maxCapacity,
        allocatedMeals: 0,         // meals accepted/committed
        reservedPendingMeals: 0,   // meals in active pending offers
        availableCapacity: r.maxCapacity,
        offersReceivedHistory: []  // offer codes / donation IDs offered to this recipient
      });
    }
  }

  /**
   * Complete Replay from Scratch.
   * Derives all projections exclusively from the immutable log.
   */
  replayAll() {
    const startTime = process.hrtime.bigint();
    
    this.offers.clear();
    this.donations.clear();
    this.usedHandoffCodes.clear();
    this.initRecipients();

    this.impactMetrics = {
      totalDonationsCreated: 0,
      totalMealsListed: 0,
      totalMealsAccepted: 0,
      totalMealsCollected: 0,
      totalOffersDispatched: 0,
      totalOffersRejected: 0,
      totalOffersExpired: 0,
      totalCascadesTriggered: 0,
      partialAcceptanceSplits: 0,
      acceptanceTimesMinutes: [],
      medianTimeToAcceptMinutes: 0,
      co2SavedKg: 0,
      acceptanceRatePercent: 0,
      collectionRatePercent: 0
    };

    const allEvents = this.eventStore ? this.eventStore.getAllEvents() : [];
    for (const evt of allEvents) {
      this.applyEvent(evt);
    }

    const endTime = process.hrtime.bigint();
    const replayDurationMs = Number(endTime - startTime) / 1000000;

    return {
      success: true,
      eventsReplayed: allEvents.length,
      durationMs: parseFloat(replayDurationMs.toFixed(3)),
      timestamp: new Date().toISOString()
    };
  }

  applyEvent(event) {
    const { type, payload, metadata } = event;
    const recordedAt = metadata?.recordedAt || new Date().toISOString();

    switch (type) {
      case 'DONATION_CREATED': {
        const { donationId, canteenName, foodName, foodType, meals, safePickupExpiresAt, donorLocation, mode } = payload;
        this.donations.set(donationId, {
          donationId,
          canteenName: canteenName || 'North Campus Central Canteen',
          foodName: foodName || 'Fresh Rice & Dal Surplus',
          foodType: foodType || 'Veg',
          initialMeals: meals,
          remainingMeals: meals,
          safePickupExpiresAt,
          donorLocation: donorLocation || { lat: 28.5350, lng: 77.3910, address: 'Campus Cafeteria Block 3' },
          status: 'ACTIVE',
          mode: mode || 'CASCADE', // 'CASCADE' or 'STANDARD'
          createdAt: recordedAt,
          activeOffers: [],
          acceptedOffers: []
        });

        this.impactMetrics.totalDonationsCreated++;
        this.impactMetrics.totalMealsListed += meals;
        break;
      }

      case 'OFFER_DISPATCHED': {
        const { offerCode, donationId, parentOfferCode, recipientId, meals, windowDurationSeconds, expiresAt, rankScore, cascadeRound } = payload;
        
        const recCap = this.recipientCapacities.get(recipientId);
        const recipientName = recCap ? recCap.name : recipientId;
        const recipientPhone = recCap ? recCap.contactPhone : '';

        this.offers.set(offerCode, {
          offerCode,
          donationId,
          parentOfferCode: parentOfferCode || null,
          recipientId,
          recipientName,
          recipientPhone,
          mealsOffered: meals,
          status: 'OFFERED',
          windowDurationSeconds,
          offeredAt: recordedAt,
          expiresAt,
          rankScore,
          cascadeRound: cascadeRound || 1,
          acceptedMeals: 0
        });

        // Reserve recipient capacity atomically
        if (recCap) {
          recCap.reservedPendingMeals += meals;
          recCap.availableCapacity = Math.max(0, recCap.maxCapacity - (recCap.allocatedMeals + recCap.reservedPendingMeals));
          if (!recCap.offersReceivedHistory.includes(offerCode)) {
            recCap.offersReceivedHistory.push(offerCode);
          }
        }

        const donation = this.donations.get(donationId);
        if (donation && !donation.activeOffers.includes(offerCode)) {
          donation.activeOffers.push(offerCode);
        }

        this.impactMetrics.totalOffersDispatched++;
        break;
      }

      case 'OFFER_ACCEPTED': {
        const { offerCode, recipientId, mealsAccepted, acceptedAt } = payload;
        const offer = this.offers.get(offerCode);
        if (offer) {
          offer.status = 'ACCEPTED';
          offer.acceptedMeals = mealsAccepted;
          offer.acceptedAt = acceptedAt || recordedAt;

          // Compute acceptance latency
          const offeredMs = new Date(offer.offeredAt).getTime();
          const acceptedMs = new Date(offer.acceptedAt).getTime();
          const latencyMins = Math.max(0.1, (acceptedMs - offeredMs) / 60000);
          this.impactMetrics.acceptanceTimesMinutes.push(latencyMins);
        }

        // Adjust recipient capacity: move from reserved pending to committed allocated
        const recCap = this.recipientCapacities.get(recipientId);
        if (recCap) {
          const originalReserved = offer ? offer.mealsOffered : mealsAccepted;
          recCap.reservedPendingMeals = Math.max(0, recCap.reservedPendingMeals - originalReserved);
          recCap.allocatedMeals += mealsAccepted;
          recCap.availableCapacity = Math.max(0, recCap.maxCapacity - (recCap.allocatedMeals + recCap.reservedPendingMeals));
        }

        this.impactMetrics.totalMealsAccepted += mealsAccepted;
        this.recalculateImpactKPIs();
        break;
      }

      case 'OFFER_REJECTED': {
        const { offerCode, recipientId, reason } = payload;
        const offer = this.offers.get(offerCode);
        if (offer) {
          offer.status = 'REJECTED';
          offer.rejectedAt = recordedAt;
          offer.rejectionReason = reason || 'Declined via SMS grammar';
        }

        // Release reserved capacity
        const recCap = this.recipientCapacities.get(recipientId);
        if (recCap && offer) {
          recCap.reservedPendingMeals = Math.max(0, recCap.reservedPendingMeals - offer.mealsOffered);
          recCap.availableCapacity = Math.max(0, recCap.maxCapacity - (recCap.allocatedMeals + recCap.reservedPendingMeals));
        }

        this.impactMetrics.totalOffersRejected++;
        this.impactMetrics.totalCascadesTriggered++;
        break;
      }

      case 'OFFER_EXPIRED': {
        const { offerCode, recipientId } = payload;
        const offer = this.offers.get(offerCode);
        if (offer) {
          offer.status = 'EXPIRED';
          offer.expiredAt = recordedAt;
        }

        // Release reserved capacity
        const recCap = this.recipientCapacities.get(recipientId);
        if (recCap && offer) {
          recCap.reservedPendingMeals = Math.max(0, recCap.reservedPendingMeals - offer.mealsOffered);
          recCap.availableCapacity = Math.max(0, recCap.maxCapacity - (recCap.allocatedMeals + recCap.reservedPendingMeals));
        }

        this.impactMetrics.totalOffersExpired++;
        this.impactMetrics.totalCascadesTriggered++;
        break;
      }

      case 'OFFER_SPLIT': {
        const { originalOfferCode, acceptedOfferCode, remainingOfferCode, acceptedMeals, remainingMeals } = payload;
        this.impactMetrics.partialAcceptanceSplits++;
        break;
      }

      case 'DONATION_COLLECTED': {
        const { donationId, offerCode, recipientId, mealsCollected, handoffCodeHash, verifiedOffline, collectedAt } = payload;
        
        const offer = this.offers.get(offerCode);
        if (offer) {
          offer.status = 'COLLECTED';
          offer.collectedAt = collectedAt || recordedAt;
          offer.verifiedOffline = !!verifiedOffline;
        }

        if (handoffCodeHash) {
          this.usedHandoffCodes.add(handoffCodeHash);
        }

        const donation = this.donations.get(donationId);
        if (donation) {
          donation.status = 'COLLECTED';
        }

        this.impactMetrics.totalMealsCollected += mealsCollected;
        this.impactMetrics.co2SavedKg = parseFloat((this.impactMetrics.totalMealsCollected * 1.9).toFixed(1));
        this.recalculateImpactKPIs();
        break;
      }

      default:
        // Ignore unhandled custom event types
        break;
    }
  }

  recalculateImpactKPIs() {
    // Acceptance Rate
    if (this.impactMetrics.totalMealsListed > 0) {
      this.impactMetrics.acceptanceRatePercent = Math.min(100, parseFloat(
        ((this.impactMetrics.totalMealsAccepted / this.impactMetrics.totalMealsListed) * 100).toFixed(1)
      ));
    }

    // Collection Rate
    if (this.impactMetrics.totalMealsAccepted > 0) {
      this.impactMetrics.collectionRatePercent = Math.min(100, parseFloat(
        ((this.impactMetrics.totalMealsCollected / this.impactMetrics.totalMealsAccepted) * 100).toFixed(1)
      ));
    }

    // Median Acceptance Time
    const latencies = [...this.impactMetrics.acceptanceTimesMinutes].sort((a, b) => a - b);
    if (latencies.length > 0) {
      const mid = Math.floor(latencies.length / 2);
      const median = latencies.length % 2 !== 0 ? latencies[mid] : (latencies[mid - 1] + latencies[mid]) / 2;
      this.impactMetrics.medianTimeToAcceptMinutes = parseFloat(median.toFixed(2));
    }
  }

  // Projections for Bubble and Frontend
  getOffersProjection() {
    return Array.from(this.offers.values()).reverse();
  }

  getDonationsProjection() {
    return Array.from(this.donations.values()).reverse();
  }

  getRecipientCapacitiesProjection() {
    return Array.from(this.recipientCapacities.values());
  }

  getImpactMetricsProjection() {
    return { ...this.impactMetrics };
  }

  getOffer(offerCode) {
    return this.offers.get(offerCode);
  }

  getDonation(donationId) {
    return this.donations.get(donationId);
  }

  isHandoffCodeConsumed(codeHash) {
    return this.usedHandoffCodes.has(codeHash);
  }
}

module.exports = ProjectionEngine;
