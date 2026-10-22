const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class EventStore {
  constructor(filePath) {
    this.filePath = filePath || path.join(__dirname, '../data/event-log.json');
    this.events = [];
    this.subscribers = [];
    this.ensureDirectory();
    this.loadFromFile();
  }

  ensureDirectory() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  loadFromFile() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf8');
        this.events = JSON.parse(data);
      } else {
        this.events = [];
        this.saveToFile();
      }
    } catch (err) {
      console.error('Error loading event store, initializing empty store:', err.message);
      this.events = [];
    }
  }

  saveToFile() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.events, null, 2), 'utf8');
    } catch (err) {
      console.error('Error saving event store:', err.message);
    }
  }

  /**
   * Append an event to the immutable log.
   * Enforces cryptographic hash chaining (blockchain/git style)
   */
  append(eventType, payload, metadata = {}) {
    const previousEvent = this.events.length > 0 ? this.events[this.events.length - 1] : null;
    const prevHash = previousEvent ? previousEvent.hash : '0000000000000000000000000000000000000000000000000000000000000000';
    
    const timestamp = new Date().toISOString();
    const eventId = `EVT-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    const rawDataToHash = JSON.stringify({
      id: eventId,
      sequence: this.events.length + 1,
      prevHash,
      type: eventType,
      payload,
      timestamp
    });

    const hash = crypto.createHash('sha256').update(rawDataToHash).digest('hex');

    const event = {
      id: eventId,
      sequence: this.events.length + 1,
      prevHash,
      hash,
      type: eventType,
      payload,
      metadata: {
        ...metadata,
        recordedAt: timestamp
      }
    };

    // Immutable append only
    this.events.push(event);
    this.saveToFile();

    // Notify all real-time projection subscribers
    this.notifySubscribers(event);

    return event;
  }

  subscribe(callback) {
    this.subscribers.push(callback);
    return () => {
      this.subscribers = this.subscribers.filter(sub => sub !== callback);
    };
  }

  notifySubscribers(event) {
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch (err) {
        console.error('Error in event subscriber:', err);
      }
    }
  }

  getAllEvents() {
    return [...this.events];
  }

  clear() {
    this.events = [];
    this.saveToFile();
  }

  /**
   * Cryptographically verify integrity of the entire append-only log
   */
  verifyIntegrity() {
    let prevHash = '0000000000000000000000000000000000000000000000000000000000000000';
    for (let i = 0; i < this.events.length; i++) {
      const evt = this.events[i];
      if (evt.prevHash !== prevHash) {
        return {
          valid: false,
          errorIndex: i,
          reason: `Hash chain broken at event #${evt.sequence}. Expected prevHash ${prevHash}, got ${evt.prevHash}`
        };
      }
      const rawDataToHash = JSON.stringify({
        id: evt.id,
        sequence: evt.sequence,
        prevHash: evt.prevHash,
        type: evt.type,
        payload: evt.payload,
        timestamp: evt.metadata.recordedAt
      });
      const calculatedHash = crypto.createHash('sha256').update(rawDataToHash).digest('hex');
      if (calculatedHash !== evt.hash) {
        return {
          valid: false,
          errorIndex: i,
          reason: `Event #${evt.sequence} tampered. Hash mismatch.`
        };
      }
      prevHash = evt.hash;
    }
    return { valid: true, totalEvents: this.events.length };
  }
}

module.exports = EventStore;
