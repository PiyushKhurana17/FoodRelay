/**
 * FoodRelay Backend Server (Zero Syntax 2026, Team Vayu9)
 * 
 * Features:
 * 1. Append-Only Event Log & Replay Projections (Bubble integration target)
 * 2. Cascading Re-Offer Engine with 5-factor scoring & dynamic window
 * 3. Two-Way Plain-Text Messaging Grammar (SMS / WhatsApp sandbox)
 * 4. 60-Second Rotating Offline Cryptographic Handoff Code & Reconciler
 * 5. Original Standard Workflow Compatibility
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');

const EventStore = require('./eventStore');
const ProjectionEngine = require('./projections');
const { MatchingEngine, VERIFIED_RECIPIENTS } = require('./matchingEngine');
const CascadeEngine = require('./cascadeEngine');
const MessagingGrammar = require('./messagingGrammar');
const { CryptoHandoff, PILOT_SECRET } = require('./cryptoHandoff');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Initialize Core Engines
const eventStore = new EventStore(path.join(__dirname, '../data/event-log.json'));
const projectionEngine = new ProjectionEngine(eventStore);
const matchingEngine = new MatchingEngine();
const cascadeEngine = new CascadeEngine(eventStore, projectionEngine, matchingEngine);
const messagingGrammar = new MessagingGrammar(eventStore, projectionEngine, cascadeEngine);
const cryptoHandoff = new CryptoHandoff(PILOT_SECRET);

// Auto-check for expired offers every 3 seconds
setInterval(() => {
  try {
    cascadeEngine.checkAndExpireOffers();
  } catch (err) {
    console.error('Error during cascade expiry check:', err.message);
  }
}, 3000);

// ==========================================
// API ROUTES FOR BUBBLE & FRONTEND
// ==========================================

// 1. Projections (Bubble reads these instead of database state)
app.get('/api/projections/all', (req, res) => {
  res.json({
    offers: projectionEngine.getOffersProjection(),
    donations: projectionEngine.getDonationsProjection(),
    recipients: projectionEngine.getRecipientCapacitiesProjection(),
    impact: projectionEngine.getImpactMetricsProjection(),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/projections/offers', (req, res) => {
  res.json(projectionEngine.getOffersProjection());
});

app.get('/api/projections/recipients', (req, res) => {
  res.json(projectionEngine.getRecipientCapacitiesProjection());
});

app.get('/api/projections/impact', (req, res) => {
  res.json(projectionEngine.getImpactMetricsProjection());
});

// 2. Append-Only Event Log & Replay
app.get('/api/events', (req, res) => {
  res.json({
    events: eventStore.getAllEvents(),
    total: eventStore.getAllEvents().length
  });
});

app.post('/api/events/replay', (req, res) => {
  const result = projectionEngine.replayAll();
  res.json({
    message: 'Event log replayed successfully from scratch.',
    result,
    currentProjections: {
      offersCount: projectionEngine.getOffersProjection().length,
      donationsCount: projectionEngine.getDonationsProjection().length,
      impact: projectionEngine.getImpactMetricsProjection()
    }
  });
});

app.get('/api/events/integrity', (req, res) => {
  const integrity = eventStore.verifyIntegrity();
  res.json(integrity);
});

// 3. Create Donation (Supports CASCADE and STANDARD workflows)
app.post('/api/donations', (req, res) => {
  try {
    const {
      canteenName = 'North Campus Central Canteen',
      foodName = 'Fresh Paneer Butter Masala & Rice Surplus',
      foodType = 'Veg',
      meals = 50,
      safePickupHours = 2,
      mode = 'CASCADE', // 'CASCADE' (assigned twist) or 'STANDARD' (original workflow)
      targetRecipientId = null // For STANDARD workflow
    } = req.body;

    const donationId = `DON-${Date.now().toString().slice(-6)}`;
    const safePickupExpiresAt = new Date(Date.now() + (safePickupHours * 3600000)).toISOString();

    // 1. Append DONATION_CREATED to immutable log
    const donationEvent = eventStore.append('DONATION_CREATED', {
      donationId,
      canteenName,
      foodName,
      foodType,
      meals: parseInt(meals, 10),
      safePickupHours,
      safePickupExpiresAt,
      mode,
      donorLocation: { lat: 28.5350, lng: 77.3910, address: 'Campus Cafeteria Block 3' }
    }, { source: 'CANTEEN_PORTAL' });

    let initialOfferResult = null;

    if (mode === 'CASCADE') {
      // Trigger cascade matching engine
      initialOfferResult = cascadeEngine.initiateOffer(
        donationId,
        parseInt(meals, 10),
        safePickupExpiresAt,
        foodType,
        { lat: 28.5350, lng: 77.3910 }
      );
    } else {
      // STANDARD WORKFLOW: Direct single assignment
      const recipient = targetRecipientId
        ? matchingEngine.getRecipientById(targetRecipientId)
        : VERIFIED_RECIPIENTS[0];

      const offerCode = `STD-${Math.floor(100 + Math.random() * 900)}`;
      const expiresAt = safePickupExpiresAt; // Standard uses full safe window

      eventStore.append('OFFER_DISPATCHED', {
        offerCode,
        donationId,
        recipientId: recipient.id,
        recipientName: recipient.name,
        meals: parseInt(meals, 10),
        windowDurationSeconds: safePickupHours * 3600,
        expiresAt,
        rankScore: 1.0,
        cascadeRound: 1,
        standardWorkflow: true
      }, { source: 'STANDARD_WORKFLOW' });

      initialOfferResult = {
        success: true,
        offerCode,
        targetRecipient: recipient,
        standardWorkflow: true
      };
    }

    res.json({
      success: true,
      donationId,
      donationEvent,
      initialOfferResult,
      mode
    });
  } catch (err) {
    console.error('Error creating donation:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Two-Way Plain-Text Messaging Sandbox Bot (SMS / WhatsApp)
app.post('/api/sms/incoming', (req, res) => {
  try {
    const { senderPhone = '+919876500001', messageText = '' } = req.body;
    const result = messagingGrammar.processIncomingMessage(senderPhone, messageText);
    res.json(result);
  } catch (err) {
    console.error('Error processing incoming SMS:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper for UI manual actions
app.post('/api/offers/:offerCode/reject', (req, res) => {
  try {
    const { offerCode } = req.params;
    const { reason = 'Rejected by recipient via portal' } = req.body;
    const result = cascadeEngine.handleRejection(offerCode, reason);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Force expire an offer for testing
app.post('/api/offers/:offerCode/force-expire', (req, res) => {
  try {
    const { offerCode } = req.params;
    const offer = projectionEngine.getOffer(offerCode);
    if (!offer) {
      return res.status(404).json({ success: false, error: 'Offer not found' });
    }
    offer.expiresAt = new Date(Date.now() - 1000).toISOString();
    const result = cascadeEngine.checkAndExpireOffers();
    res.json({ success: true, message: `Offer ${offerCode} expired and cascaded`, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Offline Signed Handoff Code Endpoints
// Donor Phone: Get rotating 60s signed code
app.get('/api/handoff/rotating-code/:donationId/:offerCode', (req, res) => {
  try {
    const { donationId, offerCode } = req.params;
    const offer = projectionEngine.getOffer(offerCode);
    
    const meals = offer ? (offer.acceptedMeals || offer.mealsOffered) : 50;
    const rotatingToken = cryptoHandoff.generateHandoffToken(donationId, offerCode, meals);

    res.json({
      success: true,
      tokenData: rotatingToken,
      pilotSecretPublicMetadata: {
        algorithm: 'HMAC-SHA256',
        windowSeconds: 60,
        antiReplayRequired: true
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Collector Device: Offline verification verification endpoint (also testable via API)
app.post('/api/handoff/verify-offline', (req, res) => {
  try {
    const { tokenString, timestampMs = Date.now() } = req.body;
    const verification = cryptoHandoff.verifyHandoffToken(tokenString, timestampMs);

    if (!verification.valid) {
      return res.status(400).json(verification);
    }

    // Check anti-replay on server projection
    if (projectionEngine.isHandoffCodeConsumed(verification.tokenHash)) {
      return res.status(409).json({
        valid: false,
        error: 'REPLAY ATTACK DETECTED: This handoff token has already been consumed and recorded in the event log!'
      });
    }

    res.json(verification);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reconcile offline-recorded collections with append-only event log
app.post('/api/handoff/reconcile', (req, res) => {
  try {
    const { offlineRecords = [] } = req.body;
    const results = [];

    for (const record of offlineRecords) {
      const { donationId, offerCode, tokenString, timestampMs, recipientId } = record;
      
      // Verify signature
      const verification = cryptoHandoff.verifyHandoffToken(tokenString, timestampMs || Date.now());
      if (!verification.valid) {
        results.push({
          offerCode,
          success: false,
          error: verification.error
        });
        continue;
      }

      // Check anti-replay
      if (projectionEngine.isHandoffCodeConsumed(verification.tokenHash)) {
        results.push({
          offerCode,
          success: false,
          error: 'Replay detected: code already logged in event store.'
        });
        continue;
      }

      const offer = projectionEngine.getOffer(offerCode);
      const meals = offer ? (offer.acceptedMeals || offer.mealsOffered) : verification.meals;

      // Append DONATION_COLLECTED event
      const event = eventStore.append('DONATION_COLLECTED', {
        donationId: verification.donationId,
        offerCode: verification.offerCode,
        recipientId: recipientId || (offer ? offer.recipientId : 'REC-OFFLINE'),
        mealsCollected: meals,
        handoffCodeHash: verification.tokenHash,
        verifiedOffline: true,
        collectedAt: new Date(timestampMs || Date.now()).toISOString()
      }, { source: 'OFFLINE_RECONCILER' });

      results.push({
        offerCode,
        success: true,
        event,
        mealsCollected: meals
      });
    }

    res.json({
      success: true,
      reconciledCount: results.filter(r => r.success).length,
      results,
      currentImpact: projectionEngine.getImpactMetricsProjection()
    });
  } catch (err) {
    console.error('Error reconciling offline handoff records:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Demo Reset & Seed
app.post('/api/demo/reset', (req, res) => {
  eventStore.clear();
  cascadeEngine.donationRecipientHistory.clear();
  projectionEngine.replayAll();
  res.json({ success: true, message: 'Event store cleared and projections reset to pristine state.' });
});

// Seed Initial Realistic Hackathon Demo Scenario
app.post('/api/demo/seed', (req, res) => {
  eventStore.clear();
  cascadeEngine.donationRecipientHistory.clear();
  projectionEngine.replayAll();

  // Create Donation #1: 60 meals, 2 hours remaining
  const d1 = 'DON-9011';
  const safeExpiry = new Date(Date.now() + (2 * 3600000)).toISOString();
  
  eventStore.append('DONATION_CREATED', {
    donationId: d1,
    canteenName: 'Central Campus Canteen Block 4',
    foodName: 'Fresh Rice, Dal Makhani & Roti surplus',
    foodType: 'Veg',
    meals: 60,
    safePickupHours: 2,
    safePickupExpiresAt: safeExpiry,
    mode: 'CASCADE',
    donorLocation: { lat: 28.5350, lng: 77.3910, address: 'Campus Cafeteria Block 4' }
  }, { source: 'SEED' });

  // Initiate cascade
  cascadeEngine.initiateOffer(d1, 60, safeExpiry, 'Veg', { lat: 28.5350, lng: 77.3910 });

  res.json({
    success: true,
    message: 'Demo seeded with realistic active cascade!',
    projections: {
      offers: projectionEngine.getOffersProjection(),
      impact: projectionEngine.getImpactMetricsProjection()
    }
  });
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`FoodRelay (Team Vayu9) Hackathon Server Running`);
  console.log(`Port: http://localhost:${PORT}`);
  console.log(`Twist: "The Cascade & Offline Handoff" Engine Active`);
  console.log(`=======================================================`);
});
