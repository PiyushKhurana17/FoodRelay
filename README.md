# FoodRelay — Urgency-First Food Redistribution
### Zero Syntax 2026 Hackathon | Team Vayu9
**Assigned Twist:** *"The Cascade & Offline Handoff"*

---

## 🌟 Executive Overview
FoodRelay coordinates safe surplus meal redistribution from campus canteens, caterers, and events to verified local shelters, community kitchens, and NGOs before pickup windows close.

In this implementation, offer management has been shifted from conventional database state to an **append-only, event-driven cascading system with offline verification**.

---

## 🚀 Key Twist Architectural Implementations

### 1. Append-Only Event Log
- **Decoupled Source of Truth:** Bubble (and the UI) does **not** store or determine current offer state.
- **Cryptographic Hash Chain:** Every state change (`DONATION_CREATED`, `OFFER_DISPATCHED`, `OFFER_ACCEPTED`, `OFFER_REJECTED`, `OFFER_EXPIRED`, `OFFER_SPLIT`, `DONATION_COLLECTED`) is appended with SHA-256 previous-hash chaining (`prevHash` -> `hash`).
- **Exclusive Projection Replay:** Current offer statuses, recipient capacities, and impact scorecards are derived **exclusively** by replaying the event stream.
- **Bubble Read Projections:** Bubble reads clean read-models via standard REST endpoints:
  - `GET /api/projections/all`
  - `GET /api/projections/offers`
  - `GET /api/projections/recipients`
  - `GET /api/projections/impact`
  - `POST /api/events/replay` (with millisecond benchmarking)

### 2. Cascading Re-Offer Engine
- **Explainable 5-Factor Scoring (Pitch Deck Slide 4):**
  - Urgency / Safe Window: 35%
  - Travel Distance: 25%
  - Recipient Capacity: 20%
  - Food Compatibility: 15%
  - Reliability History: 5%
- **Dynamic Acceptance Window Formula:**
  $$\text{Window} = \min(10\text{ minutes}, 0.25 \times \text{Remaining Safe Pickup Time})$$
  - Example: For a 2-hour window (120m), $0.25 \times 120 = 30\text{m} \implies \mathbf{10\text{ minutes}}$ (capped).
  - Example: For a 20-minute window, $0.25 \times 20 = \mathbf{5\text{ minutes}}$.
- **Anti-Repeat Guarantee:** An offer (or any split child) is never sent to the same recipient more than once.
- **Anti-Double-Allocation Guard:** Atomic reservations in the projection prevent recipient capacity from being over-allocated, including during concurrent batch dispatches.

### 3. Plain-Text Messaging Grammar
- **Two-Way SMS / WhatsApp Sandbox:** Interactive phone interface simulating SMS gateway.
- **Strict Grammar Specification:**
  - `Y <offer-code> <meals>` — Accepts specified meal quantity.
  - `N <offer-code>` — Declines the offer and immediately triggers auto-cascade to the next recipient.
- **Partial Acceptance Splits:**
  - If a recipient accepts 30 out of 50 meals (`Y RELAY-101 30`), the system commits 30 meals to that recipient, records an `OFFER_SPLIT` event, and returns the remaining 20 meals (`RELAY-101-B`) to the cascade engine to re-rank and offer immediately!

### 4. Offline Signed Handoff Code
- **Donor Device Rotating Code:** Generates a cryptographically signed HMAC-SHA256 token with a **60-second rotating window**, short PIN (`XXX-XXX`), and dynamic timer ring.
- **100% Offline Verification:** Collector device verifies the code fully offline using client-side Web Crypto API and pre-shared pilot credentials without contacting any server.
- **Anti-Replay Ledger:** Replay of previously used handoff codes is blocked both offline (local cache) and online (projection ledger).
- **Offline Sync & Reconciliation:** Records offline `COLLECTED` events in a local queue and reconciles them with the event log upon reconnecting via `POST /api/handoff/reconcile`.

### 5. Dual Mode & Standard Workflow Compatibility
- Standard direct offer assignment and Cascade mode can run side-by-side. The original workflow remains completely operational.

---

## 🛠️ Technology Stack
- **Backend:** Node.js (v24), Express, Web Crypto / Node `crypto`, Event Store Engine.
- **Frontend:** Vanilla HTML5, Vanilla CSS3 (glassmorphic dark mode, emerald & neon accents, responsive layout), Vanilla JS (CQRS projection engine, Web Crypto API).
- **Integration Target:** Bubble API Connector endpoints (`/api/projections/*`).

---

## 🧪 Live Verification & Jury Console
The application features a dedicated **Jury Verification Console** (`tab-jury`) with single-click automated live tests:
1. `Test 1:` Append-Only Event Log & Projection Replay (SHA-256 chain verified)
2. `Test 2:` Dynamic Acceptance Window `min(10m, 25% safe time)`
3. `Test 3:` Cascading Re-Offer Engine on Rejection / Expiry
4. `Test 4:` Plain-Text Messaging Grammar & Partial Acceptance Split
5. `Test 5:` Anti-Double-Allocation Across Concurrent Donations
6. `Test 6:` Offline Cryptographic Verification, Anti-Replay & Reconnection Sync

---

## 🏃 Running the Application Locally
```bash
# Install dependencies
npm install

# Start server
node backend/server.js
```
Open **`http://localhost:3000`** in any modern web browser.
