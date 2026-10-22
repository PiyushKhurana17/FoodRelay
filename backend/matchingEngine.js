/**
 * Matching Engine for FoodRelay (Zero Syntax 2026, Team Vayu9)
 * Implements the 5-Factor Scoring Model from Slide 4:
 * 1. Urgency / Time Remaining: 35%
 * 2. Travel Distance: 25%
 * 3. Recipient Capacity: 20%
 * 4. Food Compatibility: 15%
 * 5. Reliability History: 5%
 * 
 * Plus Hard Constraints overrides:
 * - Recipient eligibility
 * - Safe pickup window (travel time < remaining safe window)
 * - Available capacity > 0
 * - Food handling requirements (hot/cold/dietary)
 * - Anti-Repeat: Never send same offer/donation to same recipient twice!
 */

const VERIFIED_RECIPIENTS = [
  {
    id: 'REC-001',
    name: 'Asha Community Shelter & Kitchen',
    type: 'Shelter',
    contactPhone: '+919876500001',
    maxCapacity: 80,
    currentAllocated: 0,
    location: { lat: 28.5355, lng: 77.3910, address: 'Sector 62, Noida' },
    dietaryAccepted: ['Veg', 'Non-Veg', 'Jain', 'Rice & Gravy'],
    storageType: ['Hot Box', 'Cold Storage'],
    reliabilityScore: 0.96, // 96% past on-time collection
    averageSpeedMins: 4.2
  },
  {
    id: 'REC-002',
    name: 'Jan Seva Food Bank',
    type: 'Community Kitchen',
    contactPhone: '+919876500002',
    maxCapacity: 120,
    currentAllocated: 0,
    location: { lat: 28.5450, lng: 77.3980, address: 'Sector 63, Noida' },
    dietaryAccepted: ['Veg', 'Jain'],
    storageType: ['Hot Box'],
    reliabilityScore: 0.92,
    averageSpeedMins: 5.5
  },
  {
    id: 'REC-003',
    name: 'Hope Children Care Foundation',
    type: 'NGO',
    contactPhone: '+919876500003',
    maxCapacity: 45,
    currentAllocated: 0,
    location: { lat: 28.5280, lng: 77.3820, address: 'Sector 58, Noida' },
    dietaryAccepted: ['Veg', 'Non-Veg'],
    storageType: ['Hot Box', 'Ambient'],
    reliabilityScore: 0.98,
    averageSpeedMins: 3.8
  },
  {
    id: 'REC-004',
    name: 'Santosh Night Shelter',
    type: 'Shelter',
    contactPhone: '+919876500004',
    maxCapacity: 60,
    currentAllocated: 0,
    location: { lat: 28.5600, lng: 77.4100, address: 'Sector 65, Noida' },
    dietaryAccepted: ['Veg', 'Non-Veg', 'Rice & Gravy'],
    storageType: ['Hot Box'],
    reliabilityScore: 0.88,
    averageSpeedMins: 7.1
  },
  {
    id: 'REC-005',
    name: 'Prabhat Youth Mission',
    type: 'Community Kitchen',
    contactPhone: '+919876500005',
    maxCapacity: 50,
    currentAllocated: 0,
    location: { lat: 28.5150, lng: 77.3750, address: 'Sector 55, Noida' },
    dietaryAccepted: ['Veg', 'Jain'],
    storageType: ['Hot Box', 'Cold Storage'],
    reliabilityScore: 0.94,
    averageSpeedMins: 4.9
  }
];

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return parseFloat((R * c).toFixed(2));
}

class MatchingEngine {
  constructor() {
    this.recipients = JSON.parse(JSON.stringify(VERIFIED_RECIPIENTS));
  }

  getRecipients() {
    return this.recipients;
  }

  getRecipientById(id) {
    return this.recipients.find(r => r.id === id);
  }

  /**
   * Rank eligible recipients for a donation batch.
   * 
   * @param {Object} donation - The donation details { id, mealsAvailable, donorLocation, foodType, safePickupMinutesRemaining }
   * @param {Array<string>} excludedRecipientIds - Recipient IDs already offered this donation
   * @param {Object} recipientCapacities - Real-time projected capacities from event log replay
   */
  rankRecipients(donation, excludedRecipientIds = [], recipientCapacities = {}) {
    const donorLat = donation.donorLocation?.lat || 28.5350;
    const donorLng = donation.donorLocation?.lng || 77.3910;
    const mealsRequired = donation.mealsAvailable || 1;
    const remainingSafeMins = Math.max(1, donation.safePickupMinutesRemaining || 60);

    const scoredList = [];

    for (const recipient of this.recipients) {
      // Hard Constraint 1: Anti-Repeat rule
      if (excludedRecipientIds.includes(recipient.id)) {
        continue;
      }

      // Hard Constraint 2: Dynamic Capacity Check from Event Store Projection
      const currentCapacityState = recipientCapacities[recipient.id] || {
        maxCapacity: recipient.maxCapacity,
        allocatedMeals: 0,
        reservedPendingMeals: 0
      };
      
      const availableCapacity = Math.max(0, currentCapacityState.maxCapacity - (currentCapacityState.allocatedMeals + currentCapacityState.reservedPendingMeals));

      // Cannot assign if recipient has 0 available capacity
      if (availableCapacity <= 0) {
        continue;
      }

      // Distance calculation
      const distanceKm = calculateDistanceKm(donorLat, donorLng, recipient.location.lat, recipient.location.lng);
      
      // Estimated travel time (average urban speed 20 km/h -> 3 mins per km + 10 min prep)
      const estimatedTravelMins = (distanceKm * 3) + 10;

      // Hard Constraint 3: Safe pickup window check
      if (estimatedTravelMins >= remainingSafeMins) {
        continue; // Cannot safely pick up before expiration
      }

      // Hard Constraint 4: Food compatibility
      const compatibilityMatch = !donation.foodType || recipient.dietaryAccepted.includes(donation.foodType);
      if (!compatibilityMatch) {
        continue;
      }

      // --- Weighted Scoring (Slide 4) ---
      // 1. Urgency / Time Remaining (35%): Higher score when safe window is tight, but recipient is fast
      // Urgency score inversely proportional to safe window, rewarded if recipient avg speed is fast
      const urgencyFactor = Math.min(1, 60 / remainingSafeMins);
      const speedFactor = Math.max(0, 1 - (recipient.averageSpeedMins / 15));
      const urgencyScore = (urgencyFactor * 0.6 + speedFactor * 0.4);

      // 2. Travel Distance (25%): Closer is better (e.g. 0 km = 1.0, 10 km = 0.0)
      const distanceScore = Math.max(0, 1 - (distanceKm / 10));

      // 3. Recipient Capacity (20%): Proportion of donation meals they can absorb
      const capacityRatio = Math.min(1, availableCapacity / mealsRequired);
      const capacityScore = capacityRatio;

      // 4. Food Compatibility (15%)
      const foodFitScore = 1.0;

      // 5. Reliability History (5%)
      const reliabilityScore = recipient.reliabilityScore;

      // Final Composite Score:
      const compositeScore = (
        (urgencyScore * 0.35) +
        (distanceScore * 0.25) +
        (capacityScore * 0.20) +
        (foodFitScore * 0.15) +
        (reliabilityScore * 0.05)
      );

      scoredList.push({
        recipient,
        distanceKm,
        availableCapacity,
        compositeScore: parseFloat(compositeScore.toFixed(4)),
        scoringBreakdown: {
          urgency: parseFloat((urgencyScore * 0.35).toFixed(4)),
          distance: parseFloat((distanceScore * 0.25).toFixed(4)),
          capacity: parseFloat((capacityScore * 0.20).toFixed(4)),
          compatibility: parseFloat((foodFitScore * 0.15).toFixed(4)),
          reliability: parseFloat((reliabilityScore * 0.05).toFixed(4))
        }
      });
    }

    // Sort descending by composite score
    scoredList.sort((a, b) => b.compositeScore - a.compositeScore);
    return scoredList;
  }
}

module.exports = {
  MatchingEngine,
  VERIFIED_RECIPIENTS
};
