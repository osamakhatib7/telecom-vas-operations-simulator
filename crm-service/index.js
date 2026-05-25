const express = require('express');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3003;

const initialSubscribers = [
  {
    msisdn: '0599123456',
    status: 'ACTIVE',
    subscriberType: 'PREPAID',
    segment: 'MASS_MARKET',
    campaignEligible: true,
    allowedServices: ['*123#', 'INTERNET_BUNDLE', 'GENERAL_NEWS'],
  },
  {
    msisdn: '970599123456',
    status: 'ACTIVE',
    subscriberType: 'PREPAID',
    segment: 'MASS_MARKET',
    campaignEligible: true,
    allowedServices: ['*123#', 'INTERNET_BUNDLE', 'GENERAL_NEWS'],
  },
  {
    msisdn: '0599000000',
    status: 'SUSPENDED',
    subscriberType: 'PREPAID',
    segment: 'MASS_MARKET',
    campaignEligible: false,
    allowedServices: ['*123#'],
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
    console.log(`[crm-service] [correlationId=${correlationId}] ${message}`, extra);
    return;
  }

  console.log(`[crm-service] [correlationId=${correlationId}] ${message}`);
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

async function createPoolWithRetry(maxAttempts = 30, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const candidatePool = mysql.createPool(dbConfig);
      const connection = await candidatePool.getConnection();
      await connection.ping();
      connection.release();
      console.log('[crm-service] database connection established', { attempt });
      return candidatePool;
    } catch (error) {
      console.log('[crm-service] waiting for database', { attempt, error: error.message });
      if (attempt === maxAttempts) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}

async function ensureSchema() {
  console.log('[crm-service] ensuring database schema');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      msisdn VARCHAR(20) PRIMARY KEY,
      status VARCHAR(20) NOT NULL,
      subscriber_type VARCHAR(20) NOT NULL,
      segment VARCHAR(50) NOT NULL,
      campaign_eligible BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriber_allowed_services (
      msisdn VARCHAR(20) NOT NULL,
      service_code VARCHAR(50) NOT NULL,
      PRIMARY KEY (msisdn, service_code),
      CONSTRAINT fk_allowed_services_subscriber
        FOREIGN KEY (msisdn) REFERENCES subscribers(msisdn)
        ON DELETE CASCADE
    )
  `);

  await seedSubscribers();
}

async function seedSubscribers() {
  for (const subscriber of initialSubscribers) {
    await pool.query(
      `INSERT INTO subscribers
        (msisdn, status, subscriber_type, segment, campaign_eligible)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        subscriber_type = VALUES(subscriber_type),
        segment = VALUES(segment),
        campaign_eligible = VALUES(campaign_eligible)`,
      [
        subscriber.msisdn,
        subscriber.status,
        subscriber.subscriberType,
        subscriber.segment,
        subscriber.campaignEligible,
      ]
    );

    for (const serviceCode of subscriber.allowedServices) {
      await pool.query(
        'INSERT INTO subscriber_allowed_services (msisdn, service_code) VALUES (?, ?) ON DUPLICATE KEY UPDATE service_code = VALUES(service_code)',
        [subscriber.msisdn, serviceCode]
      );
    }
  }
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.json({ status: 'ok', service: 'crm-service', database: 'UP' });
  } catch (error) {
    console.error(`[crm-service] [correlationId=${req.correlationId}] health check failed`, { error: error.message });
    return res.status(500).json({ status: 'error', service: 'crm-service', database: 'DOWN' });
  }
});

app.get('/subscribers/:msisdn', async (req, res) => {
  const { msisdn } = req.params;
  const { simulateFailure } = req.query;
  logWithCorrelation(req.correlationId, 'lookup subscriber', { msisdn, simulateFailure });

  if (simulateFailure === 'crm-500') {
    logWithCorrelation(req.correlationId, 'simulating 500 error', { msisdn });
    return res.status(500).json({ error: 'CRM service error' });
  }

  try {
    const [subscriberRows] = await pool.query(
      `SELECT
        msisdn,
        status,
        subscriber_type AS subscriberType,
        segment,
        campaign_eligible AS campaignEligible
       FROM subscribers
       WHERE msisdn = ?`,
      [msisdn]
    );

    if (subscriberRows.length === 0) {
      return res.status(404).json({ error: 'Subscriber not found' });
    }

    const [allowedServiceRows] = await pool.query(
      'SELECT service_code AS serviceCode FROM subscriber_allowed_services WHERE msisdn = ? ORDER BY service_code',
      [msisdn]
    );

    const subscriber = subscriberRows[0];
    const result = {
      msisdn: subscriber.msisdn,
      status: subscriber.status,
      subscriberType: subscriber.subscriberType,
      segment: subscriber.segment,
      campaignEligible: Boolean(subscriber.campaignEligible),
      allowedServices: allowedServiceRows.map(row => row.serviceCode),
    };

    logWithCorrelation(req.correlationId, 'lookup result', {
      msisdn,
      status: result.status,
      segment: result.segment,
      allowedServices: result.allowedServices,
    });
    return res.json(result);
  } catch (error) {
    console.error(`[crm-service] [correlationId=${req.correlationId}] subscriber lookup failed`, { msisdn, error: error.message });
    return res.status(500).json({ error: 'CRM service error' });
  }
});

async function start() {
  try {
    pool = await createPoolWithRetry();
    await ensureSchema();
    app.listen(PORT, () => {
      console.log(`crm-service listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('[crm-service] failed to start', { error: error.message });
    process.exit(1);
  }
}

start();
