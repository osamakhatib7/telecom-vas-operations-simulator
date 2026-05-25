const express = require('express');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3005;

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
    console.log(`[smsc-service] [correlationId=${correlationId}] ${message}`, extra);
    return;
  }

  console.log(`[smsc-service] [correlationId=${correlationId}] ${message}`);
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
      console.log('[smsc-service] database connection established', { attempt });
      return candidatePool;
    } catch (error) {
      console.log('[smsc-service] waiting for database', { attempt, error: error.message });
      if (attempt === maxAttempts) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}

async function ensureSchema() {
  console.log('[smsc-service] ensuring database schema');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sms_attempts (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      msisdn VARCHAR(20),
      message TEXT,
      delivery_status VARCHAR(50) NOT NULL,
      error_message VARCHAR(255),
      reference_id VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_sms_attempts_msisdn_created_at (msisdn, created_at)
    )
  `);
}

async function recordSmsAttempt({ msisdn, message, deliveryStatus, errorMessage = null, referenceId = null }) {
  await pool.query(
    'INSERT INTO sms_attempts (msisdn, message, delivery_status, error_message, reference_id) VALUES (?, ?, ?, ?, ?)',
    [msisdn || null, message || null, deliveryStatus, errorMessage, referenceId || null]
  );
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.json({ status: 'ok', service: 'smsc-service', database: 'UP' });
  } catch (error) {
    console.error(`[smsc-service] [correlationId=${req.correlationId}] health check failed`, { error: error.message });
    return res.status(500).json({ status: 'error', service: 'smsc-service', database: 'DOWN' });
  }
});

app.get('/attempts/:msisdn', async (req, res) => {
  const { msisdn } = req.params;
  logWithCorrelation(req.correlationId, 'sms attempts lookup', { msisdn });

  try {
    const [attempts] = await pool.query(
      `SELECT
        id,
        msisdn,
        message,
        delivery_status AS deliveryStatus,
        error_message AS errorMessage,
        reference_id AS referenceId,
        created_at AS createdAt
       FROM sms_attempts
       WHERE msisdn = ?
       ORDER BY created_at DESC, id DESC`,
      [msisdn]
    );

    return res.json({
      msisdn,
      count: attempts.length,
      attempts,
    });
  } catch (error) {
    console.error(`[smsc-service] [correlationId=${req.correlationId}] sms attempts lookup failed`, { msisdn, error: error.message });
    return res.status(500).json({ error: 'SMSC attempts lookup error' });
  }
});

app.post('/send-sms', async (req, res) => {
  const { msisdn, message, simulateFailure, referenceId } = req.body;
  logWithCorrelation(req.correlationId, 'send sms', { msisdn, message, simulateFailure, referenceId });

  try {
    if (!msisdn || !message) {
      await recordSmsAttempt({
        msisdn,
        message,
        deliveryStatus: 'INVALID_REQUEST',
        errorMessage: 'Invalid SMS request',
        referenceId,
      });
      return res.status(400).json({ error: 'Invalid SMS request' });
    }

    if (simulateFailure === 'smsc-down') {
      logWithCorrelation(req.correlationId, 'simulating service down (500)', { msisdn });
      await recordSmsAttempt({
        msisdn,
        message,
        deliveryStatus: 'FAILED',
        errorMessage: 'SMSC service unavailable',
        referenceId,
      });
      return res.status(500).json({ error: 'SMSC service unavailable' });
    }

    if (simulateFailure === 'smsc-failed') {
      logWithCorrelation(req.correlationId, 'simulating delivery failure', { msisdn });
      await recordSmsAttempt({
        msisdn,
        message,
        deliveryStatus: 'FAILED',
        errorMessage: 'SMS delivery failed',
        referenceId,
      });
      return res.json({ deliveryStatus: 'FAILED', error: 'SMS delivery failed' });
    }

    await recordSmsAttempt({
      msisdn,
      message,
      deliveryStatus: 'DELIVERED',
      referenceId,
    });
    logWithCorrelation(req.correlationId, 'SMS delivery successful', { msisdn, referenceId });
    return res.json({ deliveryStatus: 'DELIVERED' });
  } catch (error) {
    console.error(`[smsc-service] [correlationId=${req.correlationId}] send sms failed`, { msisdn, error: error.message });
    return res.status(500).json({ error: 'SMSC service error' });
  }
});

async function start() {
  try {
    pool = await createPoolWithRetry();
    await ensureSchema();
    app.listen(PORT, () => {
      console.log(`smsc-service listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('[smsc-service] failed to start', { error: error.message });
    process.exit(1);
  }
}

start();
