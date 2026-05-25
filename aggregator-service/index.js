const express = require('express');
const app = express();
const PORT = process.env.PORT || 3006;

app.use(express.json());

const contentOffers = {
  GENERAL_NEWS: {
    category: 'GENERAL_NEWS',
    offerName: 'General News Alerts',
    providerCode: 'NEWS_GENERAL',
    validityDays: 30,
  },
};

const subscriptions = [];

app.use((req, res, next) => {
  console.log(`[aggregator-service] ${req.method} ${req.url}`);
  next();
});

function createProviderReference() {
  return `NEWS-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function expireOldSubscriptions(msisdn) {
  const now = Date.now();
  subscriptions
    .filter(subscription => subscription.msisdn === msisdn && subscription.status === 'ACTIVE')
    .forEach(subscription => {
      if (new Date(subscription.validUntil).getTime() <= now) {
        subscription.status = 'EXPIRED';
      }
    });
}

function getActiveSubscriptions(msisdn, category) {
  expireOldSubscriptions(msisdn);
  return subscriptions.filter(subscription => (
    subscription.msisdn === msisdn
    && subscription.status === 'ACTIVE'
    && (!category || subscription.category === category)
  ));
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'aggregator-service' });
});

app.get('/subscriptions/:msisdn', (req, res) => {
  const { msisdn } = req.params;
  const { category } = req.query;
  console.log('[aggregator-service] subscription lookup', { msisdn, category });

  const activeSubscriptions = getActiveSubscriptions(msisdn, category);
  return res.json({
    msisdn,
    count: activeSubscriptions.length,
    subscriptions: activeSubscriptions,
  });
});

app.post('/subscriptions', (req, res) => {
  const { msisdn, category = 'GENERAL_NEWS', referenceId, simulateFailure } = req.body;
  console.log('[aggregator-service] subscription request', { msisdn, category, referenceId, simulateFailure });

  if (simulateFailure === 'aggregator-timeout') {
    console.log('[aggregator-service] simulating subscription timeout', { msisdn, category });
    return;
  }

  if (simulateFailure === 'aggregator-500') {
    console.log('[aggregator-service] simulating subscription error', { msisdn, category });
    return res.status(500).json({ error: 'Aggregator subscription error' });
  }

  if (!msisdn || !category || !contentOffers[category]) {
    return res.status(400).json({ error: 'Invalid subscription request' });
  }

  const existingSubscriptions = getActiveSubscriptions(msisdn, category);
  if (existingSubscriptions.length > 0) {
    console.log('[aggregator-service] duplicate subscription rejected', { msisdn, category });
    return res.status(409).json({
      providerStatus: 'ALREADY_ACTIVE',
      subscription: existingSubscriptions[0],
    });
  }

  const offer = contentOffers[category];
  const validFrom = new Date();
  const validUntil = new Date(Date.now() + offer.validityDays * 24 * 60 * 60 * 1000);
  const providerReference = createProviderReference();
  const subscription = {
    msisdn,
    category,
    offerName: offer.offerName,
    providerCode: offer.providerCode,
    providerReference,
    referenceId: referenceId || null,
    status: 'ACTIVE',
    validFrom: validFrom.toISOString(),
    validUntil: validUntil.toISOString(),
    createdAt: new Date().toISOString(),
  };

  subscriptions.push(subscription);
  console.log('[aggregator-service] subscription created', {
    msisdn,
    category,
    providerReference,
    status: subscription.status,
  });

  return res.json({
    providerStatus: 'SUCCESS',
    subscription,
  });
});

app.listen(PORT, () => {
  console.log(`aggregator-service listening on port ${PORT}`);
});
