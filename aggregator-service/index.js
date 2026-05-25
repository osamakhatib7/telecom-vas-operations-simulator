const express = require('express');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3006;

const initialContentOffers = [
  {
    category: 'GENERAL_NEWS',
    offerName: 'General News Alerts',
    providerCode: 'NEWS_GENERAL',
    price: 1,
    validityDays: 30,
    isActive: true,
  },
];

const dbConfig = {
  host: process.env.DB_HOST || 'mysql-db',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'vas_user',
  password: process.env.DB_PASSWORD || 'vas_password',
  database: process.env.DB_NAME || 'vas_lab',
  waitForConnections: true,
  connectionLimit: 10,
};

let pool;

function createCorrelationId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getCorrelationId(req) {
  const incomingCorrelationId = req.headers['x-correlation-id'];
  if (Array.isArray(incomingCorrelationId)) {
    return incomingCorrelationId[0] || createCorrelationId();
  }

  return incomingCorrelationId || createCorrelationId();
}

function logWithCorrelation(correlationId, message, extra = {}) {
  if (Object.keys(extra).length > 0) {
    console.log(`[aggregator-service] [correlationId=${correlationId}] ${message}`, extra);
    return;
  }

  console.log(`[aggregator-service] [correlationId=${correlationId}] ${message}`);
}

function addCorrelationToJsonResponse(req, res) {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    const responseBody = body
      && typeof body === 'object'
      && !Array.isArray(body)
      && !Object.prototype.hasOwnProperty.call(body, 'correlationId')
      ? { ...body, correlationId: req.correlationId }
      : body;

    logWithCorrelation(req.correlationId, 'final response returned', { status: res.statusCode });
    return originalJson(responseBody);
  };
}

app.use((req, res, next) => {
  req.correlationId = getCorrelationId(req);
  res.setHeader('X-Correlation-ID', req.correlationId);
  addCorrelationToJsonResponse(req, res);
  logWithCorrelation(req.correlationId, `${req.method} ${req.url}`);
  next();
});

app.use(express.json());

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createProviderReference() {
  return `NEWS-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

async function createPoolWithRetry(maxAttempts = 30, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const candidatePool = mysql.createPool(dbConfig);
      const connection = await candidatePool.getConnection();
      await connection.ping();
      connection.release();
      console.log('[aggregator-service] database connection established', { attempt });
      return candidatePool;
    } catch (error) {
      console.log('[aggregator-service] waiting for database', { attempt, error: error.message });
      if (attempt === maxAttempts) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}

async function ensureSchema() {
  console.log('[aggregator-service] ensuring database schema');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_offers (
      category VARCHAR(50) PRIMARY KEY,
      offer_name VARCHAR(100) NOT NULL,
      provider_code VARCHAR(50) NOT NULL,
      price DECIMAL(10, 2) NOT NULL,
      validity_days INT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_subscriptions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      msisdn VARCHAR(20) NOT NULL,
      category VARCHAR(50) NOT NULL,
      offer_name VARCHAR(100) NOT NULL,
      provider_code VARCHAR(50) NOT NULL,
      provider_reference VARCHAR(100) NOT NULL,
      reference_id VARCHAR(100),
      status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      valid_from DATETIME NOT NULL,
      valid_until DATETIME NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_content_subscriptions_msisdn_category_status (msisdn, category, status),
      INDEX idx_content_subscriptions_validity (valid_until)
    )
  `);

  await seedContentOffers();
}

async function seedContentOffers(connection = pool) {
  for (const offer of initialContentOffers) {
    await connection.query(
      `INSERT INTO content_offers
        (category, offer_name, provider_code, price, validity_days, is_active)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        offer_name = VALUES(offer_name),
        provider_code = VALUES(provider_code),
        price = VALUES(price),
        validity_days = VALUES(validity_days),
        is_active = VALUES(is_active)`,
      [
        offer.category,
        offer.offerName,
        offer.providerCode,
        offer.price,
        offer.validityDays,
        offer.isActive,
      ]
    );
  }
}

async function expireOldSubscriptions(msisdn, connection = pool) {
  await connection.query(
    "UPDATE content_subscriptions SET status = 'EXPIRED' WHERE msisdn = ? AND status = 'ACTIVE' AND valid_until <= NOW()",
    [msisdn]
  );
}

async function getActiveSubscriptions(msisdn, category, connection = pool) {
  await expireOldSubscriptions(msisdn, connection);

  const params = [msisdn];
  let categoryFilter = '';
  if (category) {
    categoryFilter = 'AND category = ?';
    params.push(category);
  }

  const [subscriptions] = await connection.query(
    `SELECT
      id,
      msisdn,
      category,
      offer_name AS offerName,
      provider_code AS providerCode,
      provider_reference AS providerReference,
      reference_id AS referenceId,
      status,
      valid_from AS validFrom,
      valid_until AS validUntil,
      created_at AS createdAt
     FROM content_subscriptions
     WHERE msisdn = ? AND status = 'ACTIVE' AND valid_until > NOW() ${categoryFilter}
     ORDER BY valid_until ASC`,
    params
  );

  return subscriptions;
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.json({ status: 'ok', service: 'aggregator-service', database: 'UP' });
  } catch (error) {
    console.error(`[aggregator-service] [correlationId=${req.correlationId}] health check failed`, { error: error.message });
    return res.status(500).json({ status: 'error', service: 'aggregator-service', database: 'DOWN' });
  }
});

app.get('/subscriptions/:msisdn', async (req, res) => {
  const { msisdn } = req.params;
  const { category } = req.query;
  logWithCorrelation(req.correlationId, 'subscription lookup', { msisdn, category });

  try {
    const activeSubscriptions = await getActiveSubscriptions(msisdn, category);
    return res.json({
      msisdn,
      count: activeSubscriptions.length,
      subscriptions: activeSubscriptions,
    });
  } catch (error) {
    console.error(`[aggregator-service] [correlationId=${req.correlationId}] subscription lookup failed`, { msisdn, category, error: error.message });
    return res.status(500).json({ error: 'Aggregator subscription lookup error' });
  }
});

app.post('/subscriptions', async (req, res) => {
  const { msisdn, category = 'GENERAL_NEWS', referenceId, simulateFailure } = req.body;
  logWithCorrelation(req.correlationId, 'subscription request', { msisdn, category, referenceId, simulateFailure });

  if (simulateFailure === 'aggregator-timeout') {
    logWithCorrelation(req.correlationId, 'simulating subscription timeout', { msisdn, category });
    return;
  }

  if (simulateFailure === 'aggregator-500') {
    logWithCorrelation(req.correlationId, 'simulating subscription error', { msisdn, category });
    return res.status(500).json({ error: 'Aggregator subscription error' });
  }

  if (!msisdn || !category) {
    return res.status(400).json({ error: 'Invalid subscription request' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [offers] = await connection.query(
      'SELECT category, offer_name, provider_code, price, validity_days, is_active FROM content_offers WHERE category = ?',
      [category]
    );

    if (offers.length === 0 || !offers[0].is_active) {
      await connection.rollback();
      return res.status(400).json({ error: 'Invalid subscription request' });
    }

    await expireOldSubscriptions(msisdn, connection);
    const [existingSubscriptions] = await connection.query(
      "SELECT id, msisdn, category, offer_name AS offerName, provider_code AS providerCode, provider_reference AS providerReference, reference_id AS referenceId, status, valid_from AS validFrom, valid_until AS validUntil, created_at AS createdAt FROM content_subscriptions WHERE msisdn = ? AND category = ? AND status = 'ACTIVE' AND valid_until > NOW() FOR UPDATE",
      [msisdn, category]
    );

    if (existingSubscriptions.length > 0) {
      logWithCorrelation(req.correlationId, 'duplicate subscription rejected', { msisdn, category });
      await connection.commit();
      return res.status(409).json({
        providerStatus: 'ALREADY_ACTIVE',
        subscription: existingSubscriptions[0],
      });
    }

    const offer = offers[0];
    const validFrom = new Date();
    const validUntil = new Date(Date.now() + Number(offer.validity_days) * 24 * 60 * 60 * 1000);
    const providerReference = createProviderReference();

    await connection.query(
      `INSERT INTO content_subscriptions
        (msisdn, category, offer_name, provider_code, provider_reference, reference_id, status, valid_from, valid_until)
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      [
        msisdn,
        offer.category,
        offer.offer_name,
        offer.provider_code,
        providerReference,
        referenceId || null,
        validFrom,
        validUntil,
      ]
    );

    await connection.commit();

    const subscription = {
      msisdn,
      category: offer.category,
      offerName: offer.offer_name,
      providerCode: offer.provider_code,
      providerReference,
      referenceId: referenceId || null,
      status: 'ACTIVE',
      validFrom,
      validUntil,
    };

    logWithCorrelation(req.correlationId, 'subscription created', {
      msisdn,
      category,
      providerReference,
      status: subscription.status,
    });

    return res.json({
      providerStatus: 'SUCCESS',
      subscription,
    });
  } catch (error) {
    await connection.rollback();
    console.error(`[aggregator-service] [correlationId=${req.correlationId}] subscription failed`, { msisdn, category, error: error.message });
    return res.status(500).json({ error: 'Aggregator subscription error' });
  } finally {
    connection.release();
  }
});

async function start() {
  try {
    pool = await createPoolWithRetry();
    await ensureSchema();
    app.listen(PORT, () => {
      console.log(`aggregator-service listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('[aggregator-service] failed to start', { error: error.message });
    process.exit(1);
  }
}

start();
