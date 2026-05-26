const express = require('express');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const app = express();
const PORT = process.env.PORT || 3001;

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
    console.log(`[ussd-gateway] [correlationId=${correlationId}] ${message}`, extra);
    return;
  }

  console.log(`[ussd-gateway] [correlationId=${correlationId}] ${message}`);
}

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
      console.log('[ussd-gateway] database connection established', { attempt });
      return candidatePool;
    } catch (error) {
      console.log('[ussd-gateway] waiting for database', { attempt, error: error.message });
      if (attempt === maxAttempts) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}

async function ensureSchema() {
  console.log('[ussd-gateway] ensuring database schema');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gateway_transactions (
      transaction_id VARCHAR(50) PRIMARY KEY,
      correlation_id VARCHAR(100),
      session_id VARCHAR(100),
      msisdn VARCHAR(20),
      protocol VARCHAR(50),
      event_type VARCHAR(50),
      service_type VARCHAR(50),
      service_code VARCHAR(50),
      ussd_code VARCHAR(50),
      input_text TEXT,
      destination_platform VARCHAR(100),
      status VARCHAR(50) NOT NULL,
      failure_reason VARCHAR(100),
      error_message TEXT,
      response_message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_gateway_transactions_created_at (created_at),
      INDEX idx_gateway_transactions_correlation_id (correlation_id),
      INDEX idx_gateway_transactions_msisdn (msisdn),
      INDEX idx_gateway_transactions_filters (service_type, service_code, status, failure_reason)
    )
  `);
}

async function initializeTransactionCounter() {
  const [rows] = await pool.query(`
    SELECT transaction_id AS transactionId
    FROM gateway_transactions
    WHERE transaction_id LIKE 'TX-%'
    ORDER BY CAST(SUBSTRING(transaction_id, 4) AS UNSIGNED) DESC
    LIMIT 1
  `);

  if (rows.length > 0) {
    const lastNumber = Number(String(rows[0].transactionId).replace('TX-', ''));
    if (Number.isFinite(lastNumber)) {
      nextTransactionNumber = lastNumber + 1;
    }
  }

  console.log('[ussd-gateway] transaction counter initialized', { nextTransactionNumber });
}

const routingRules = [
  {
    id: 'RULE-USSD-123',
    serviceType: 'USSD',
    serviceCode: '*123#',
    destinationPlatform: 'VAS_PLATFORM',
    isActive: true,
    priority: 1,
  },
  {
    id: 'RULE-USSD-456',
    serviceType: 'USSD',
    serviceCode: '*456#',
    destinationPlatform: 'BUNDLE_SERVICE',
    isActive: true,
    priority: 2,
  },
  {
    id: 'RULE-ROAMING-USSD-123',
    serviceType: 'ROAMING_USSD',
    serviceCode: '*123#',
    destinationPlatform: 'ROAMING_GATEWAY_MOCK',
    isActive: true,
    priority: 1,
  },
  {
    id: 'RULE-SMS-DEFAULT',
    serviceType: 'SMS',
    serviceCode: 'DEFAULT',
    destinationPlatform: 'SMSC_MOCK',
    isActive: true,
    priority: 10,
  },
  {
    id: 'RULE-VOICE-INTERNATIONAL',
    serviceType: 'VOICE',
    serviceCode: 'INTERNATIONAL',
    destinationPlatform: 'INTERCONNECT_GATEWAY_MOCK',
    isActive: true,
    priority: 1,
  },
];

let nextTransactionNumber = 10001;
const startedAt = Date.now();

function createTransactionId() {
  const transactionId = `TX-${nextTransactionNumber}`;
  nextTransactionNumber += 1;
  return transactionId;
}

function findRoutingRule(serviceType, serviceCode) {
  return routingRules
    .filter(rule => rule.isActive && rule.serviceType === serviceType && rule.serviceCode === serviceCode)
    .sort((a, b) => a.priority - b.priority)[0];
}

async function createTransactionLog(event, result, correlationId) {
  const transactionLog = {
    transactionId: result.transactionId,
    correlationId,
    sessionId: result.sessionId || result.transactionId,
    msisdn: event.msisdn,
    protocol: event.protocol,
    eventType: event.eventType,
    serviceType: event.serviceType,
    serviceCode: event.serviceCode,
    ussdCode: event.serviceCode,
    inputText: typeof event.text === 'string' ? event.text : null,
    destinationPlatform: result.destinationPlatform || null,
    status: result.status,
    failureReason: result.failureReason || null,
    errorMessage: result.errorMessage || null,
    responseMessage: result.responseMessage || result.message || result.errorMessage || null,
    createdAt: new Date().toISOString(),
  };

  await pool.query(
    `INSERT INTO gateway_transactions
      (transaction_id, correlation_id, session_id, msisdn, protocol, event_type, service_type,
       service_code, ussd_code, input_text, destination_platform, status, failure_reason,
       error_message, response_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      transactionLog.transactionId,
      transactionLog.correlationId,
      transactionLog.sessionId,
      transactionLog.msisdn || null,
      transactionLog.protocol || null,
      transactionLog.eventType || null,
      transactionLog.serviceType || null,
      transactionLog.serviceCode || null,
      transactionLog.ussdCode || null,
      transactionLog.inputText,
      transactionLog.destinationPlatform,
      transactionLog.status,
      transactionLog.failureReason,
      transactionLog.errorMessage,
      transactionLog.responseMessage,
    ]
  );

  logWithCorrelation(correlationId, 'transaction log created', transactionLog);
  return transactionLog;
}

async function safeCreateTransactionLog(event, result, correlationId) {
  try {
    return await createTransactionLog(event, result, correlationId);
  } catch (error) {
    console.error(`[ussd-gateway] [correlationId=${correlationId}] failed to persist transaction log`, {
      transactionId: result && result.transactionId,
      error: error.message,
    });
    return null;
  }
}

function incrementCounter(counter, key) {
  const counterKey = key || 'UNKNOWN';
  counter[counterKey] = (counter[counterKey] || 0) + 1;
}

function getTopFailureReason(logs) {
  const failureCounts = {};

  logs.forEach(log => {
    if (log.failureReason) {
      incrementCounter(failureCounts, log.failureReason);
    }
  });

  const topFailure = Object.entries(failureCounts)
    .sort((a, b) => b[1] - a[1])[0];

  return topFailure ? topFailure[0] : null;
}

function mapGatewayTransaction(row) {
  return {
    transactionId: row.transactionId,
    correlationId: row.correlationId,
    sessionId: row.sessionId,
    msisdn: row.msisdn,
    protocol: row.protocol,
    eventType: row.eventType,
    serviceType: row.serviceType,
    serviceCode: row.serviceCode,
    ussdCode: row.ussdCode,
    inputText: row.inputText,
    destinationPlatform: row.destinationPlatform,
    status: row.status,
    failureReason: row.failureReason,
    errorMessage: row.errorMessage,
    responseMessage: row.responseMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function processMockDestination(event, destinationPlatform) {
  if (event.simulateFailure === 'PARTNER_TIMEOUT') {
    return {
      status: 'FAILED',
      failureReason: 'PARTNER_TIMEOUT',
      errorMessage: 'Mock partner platform timed out.',
    };
  }

  if (event.simulateFailure === 'INTERNAL_ERROR') {
    return {
      status: 'FAILED',
      failureReason: 'GATEWAY_INTERNAL_ERROR',
      errorMessage: 'Internal gateway mock processing error.',
    };
  }

  const platformMessages = {
    BUNDLE_SERVICE: 'Bundle service event accepted.',
    SMSC_MOCK: 'SMS event routed to SMSC mock.',
    ROAMING_GATEWAY_MOCK: 'Roaming USSD event routed to roaming gateway mock.',
    INTERCONNECT_GATEWAY_MOCK: 'International voice event routed to interconnect gateway mock.',
  };

  return {
    status: 'SUCCESS',
    message: platformMessages[destinationPlatform] || 'Event accepted by mock destination.',
  };
}

app.use((req, res, next) => {
  req.correlationId = getCorrelationId(req);
  res.setHeader('X-Correlation-ID', req.correlationId);
  logWithCorrelation(req.correlationId, `${req.method} ${req.url}`);
  next();
});

app.use(express.json());

app.get('/health', async (req, res) => {
  let database = 'UP';
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    database = 'DOWN';
    console.error(`[ussd-gateway] [correlationId=${req.correlationId}] health check database error`, { error: error.message });
  }

  res.status(database === 'UP' ? 200 : 500).json({
    correlationId: req.correlationId,
    status: database === 'UP' ? 'UP' : 'DEGRADED',
    service: 'ussd-gateway',
    role: 'USSD Gateway / Service Broker',
    components: {
      gatewayService: 'UP',
      routingModule: routingRules.length > 0 ? 'UP' : 'DOWN',
      transactionLogger: database,
      vasPlatformConnector: 'UP',
      database,
    },
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
});

app.get('/kpi/today', async (req, res) => {
  try {
    const [[counts]] = await pool.query(`
      SELECT
        COUNT(*) AS totalRequests,
        SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) AS successCount,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failedCount
      FROM gateway_transactions
      WHERE DATE(created_at) = UTC_DATE()
    `);
    const [serviceTypeRows] = await pool.query(`
      SELECT COALESCE(service_type, 'UNKNOWN') AS serviceType, COUNT(*) AS count
      FROM gateway_transactions
      WHERE DATE(created_at) = UTC_DATE()
      GROUP BY COALESCE(service_type, 'UNKNOWN')
    `);
    const [destinationRows] = await pool.query(`
      SELECT COALESCE(destination_platform, 'UNKNOWN') AS destinationPlatform, COUNT(*) AS count
      FROM gateway_transactions
      WHERE DATE(created_at) = UTC_DATE()
      GROUP BY COALESCE(destination_platform, 'UNKNOWN')
    `);
    const [failureRows] = await pool.query(`
      SELECT failure_reason AS failureReason, COUNT(*) AS count
      FROM gateway_transactions
      WHERE DATE(created_at) = UTC_DATE() AND failure_reason IS NOT NULL
      GROUP BY failure_reason
      ORDER BY count DESC
      LIMIT 1
    `);

    const totalRequests = Number(counts.totalRequests || 0);
    const successCount = Number(counts.successCount || 0);
    const failedCount = Number(counts.failedCount || 0);
    const successRate = totalRequests === 0 ? '0%' : `${Math.round((successCount / totalRequests) * 100)}%`;
    const requestsByServiceType = {};
    const requestsByDestinationPlatform = {};

    serviceTypeRows.forEach(row => {
      requestsByServiceType[row.serviceType] = Number(row.count);
    });
    destinationRows.forEach(row => {
      requestsByDestinationPlatform[row.destinationPlatform] = Number(row.count);
    });

    return res.json({
      correlationId: req.correlationId,
      totalRequests,
      successCount,
      failedCount,
      successRate,
      topFailureReason: failureRows[0] ? failureRows[0].failureReason : null,
      requestsByServiceType,
      requestsByDestinationPlatform,
    });
  } catch (error) {
    console.error(`[ussd-gateway] [correlationId=${req.correlationId}] KPI query failed`, { error: error.message });
    return res.status(500).json({ correlationId: req.correlationId, error: 'Failed to read gateway KPI' });
  }
});

app.get('/transactions', async (req, res) => {
  const { msisdn, correlationId, serviceType, serviceCode, status, failureReason } = req.query;

  const conditions = [];
  const params = [];

  if (msisdn) {
    conditions.push('msisdn = ?');
    params.push(msisdn);
  }
  if (correlationId) {
    conditions.push('correlation_id = ?');
    params.push(correlationId);
  }
  if (serviceType) {
    conditions.push('service_type = ?');
    params.push(serviceType);
  }
  if (serviceCode) {
    conditions.push('service_code = ?');
    params.push(serviceCode);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (failureReason) {
    conditions.push('failure_reason = ?');
    params.push(failureReason);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const [rows] = await pool.query(
      `SELECT
        transaction_id AS transactionId,
        correlation_id AS correlationId,
        session_id AS sessionId,
        msisdn,
        protocol,
        event_type AS eventType,
        service_type AS serviceType,
        service_code AS serviceCode,
        ussd_code AS ussdCode,
        input_text AS inputText,
        destination_platform AS destinationPlatform,
        status,
        failure_reason AS failureReason,
        error_message AS errorMessage,
        response_message AS responseMessage,
        created_at AS createdAt,
        updated_at AS updatedAt
       FROM gateway_transactions
       ${whereClause}
       ORDER BY created_at DESC, transaction_id DESC`,
      params
    );

    return res.json({
      correlationId: req.correlationId,
      count: rows.length,
      transactions: rows.map(mapGatewayTransaction),
    });
  } catch (error) {
    console.error(`[ussd-gateway] [correlationId=${req.correlationId}] transaction query failed`, { error: error.message });
    return res.status(500).json({ correlationId: req.correlationId, error: 'Failed to read gateway transactions' });
  }
});

app.post('/simulate-ussd', async (req, res) => {
  const { msisdn, sessionId, ussdCode, serviceType, serviceCode, text, simulateFailure } = req.body;
  const transactionId = createTransactionId();
  logWithCorrelation(req.correlationId, 'received simulate-ussd', { msisdn, sessionId, ussdCode, text, simulateFailure });
  const event = {
    protocol: 'DIRECT-USSD-MOCK',
    eventType: 'USSD_REQUEST',
    msisdn,
    serviceType: serviceType || 'USSD',
    serviceCode: serviceCode || ussdCode,
    text,
  };

  const payload = { msisdn, sessionId, ussdCode, text };
  if (simulateFailure) {
    payload.simulateFailure = simulateFailure;
  }

  try {
    logWithCorrelation(req.correlationId, 'forwarding simulate-ussd to vas-platform', { msisdn, sessionId, ussdCode });
    const response = await fetch('http://vas-platform:3002/ussd', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-ID': req.correlationId,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    logWithCorrelation(req.correlationId, 'received response from vas-platform', { status: response.status, response: data });
    const failed = !response.ok || Boolean(data.error) || Boolean(data.failureReason);
    const result = {
      transactionId,
      decision: 'DIRECT_USSD_TO_VAS_PLATFORM',
      destinationPlatform: 'VAS_PLATFORM',
      status: failed ? 'FAILED' : 'SUCCESS',
      failureReason: data.failureReason || (data.error ? 'VAS_PLATFORM_ERROR' : null),
      errorMessage: failed ? data.error || data.message || 'VAS platform returned a failure.' : null,
      responseMessage: data.message || null,
      sessionId: data.sessionId || sessionId || transactionId,
    };
    await safeCreateTransactionLog(event, result, req.correlationId);

    return res.status(response.status).json({ ...data, correlationId: req.correlationId });
  } catch (error) {
    const result = {
      transactionId,
      decision: 'DIRECT_USSD_TO_VAS_PLATFORM',
      destinationPlatform: 'VAS_PLATFORM',
      status: 'FAILED',
      failureReason: 'PARTNER_TIMEOUT',
      errorMessage: 'Failed to forward direct USSD request to VAS platform.',
      sessionId: sessionId || transactionId,
    };
    console.error(`[ussd-gateway] [correlationId=${req.correlationId}] error forwarding to vas-platform`, error);
    await safeCreateTransactionLog(event, result, req.correlationId);
    return res.status(502).json({ correlationId: req.correlationId, error: 'Failed to forward to vas-platform' });
  }
});

app.post('/simulate/signaling-event', async (req, res) => {
  const event = req.body;
  const transactionId = createTransactionId();
  logWithCorrelation(req.correlationId, 'received signaling event', {
    transactionId,
    protocol: event.protocol,
    eventType: event.eventType,
    msisdn: event.msisdn,
    serviceType: event.serviceType,
    serviceCode: event.serviceCode,
    simulateFailure: event.simulateFailure,
  });

  const requiredFields = [
    'protocol',
    'eventType',
    'msisdn',
    'serviceType',
    'serviceCode',
    'originPointCode',
    'destinationPointCode',
    'globalTitle',
    'visitedNetwork',
  ];

  const missingFields = requiredFields.filter(field => !event[field]);

  if (missingFields.length > 0) {
    const result = {
      transactionId,
      decision: 'VALIDATION_FAILED',
      destinationPlatform: null,
      status: 'FAILED',
      failureReason: 'VALIDATION_FAILED',
      errorMessage: `Missing required fields: ${missingFields.join(', ')}`,
    };
    logWithCorrelation(req.correlationId, 'validation failure', { transactionId, missingFields });
    await safeCreateTransactionLog(event, result, req.correlationId);
    return res.status(400).json({ ...result, correlationId: req.correlationId });
  }

  const routingRule = findRoutingRule(event.serviceType, event.serviceCode);

  if (!routingRule) {
    const result = {
      transactionId,
      decision: 'ROUTING_NOT_FOUND',
      destinationPlatform: null,
      status: 'FAILED',
      failureReason: 'ROUTING_NOT_FOUND',
      errorMessage: 'No active routing rule found for serviceType and serviceCode.',
    };
    logWithCorrelation(req.correlationId, 'routing failure', {
      transactionId,
      serviceType: event.serviceType,
      serviceCode: event.serviceCode,
    });
    await safeCreateTransactionLog(event, result, req.correlationId);
    return res.status(404).json({ ...result, correlationId: req.correlationId });
  }

  logWithCorrelation(req.correlationId, 'routing decision', {
    transactionId,
    ruleId: routingRule.id,
    destinationPlatform: routingRule.destinationPlatform,
  });

  if (event.simulateFailure === 'INTERNAL_ERROR') {
    const result = {
      transactionId,
      decision: 'MOCK_PROCESSING_FAILED',
      destinationPlatform: routingRule.destinationPlatform,
      status: 'FAILED',
      failureReason: 'GATEWAY_INTERNAL_ERROR',
      errorMessage: 'Internal gateway mock processing error.',
    };
    logWithCorrelation(req.correlationId, 'gateway internal error simulation', { transactionId });
    await safeCreateTransactionLog(event, result, req.correlationId);
    return res.status(500).json({ ...result, correlationId: req.correlationId });
  }

  if (routingRule.destinationPlatform === 'VAS_PLATFORM') {
    const vasPayload = {
      msisdn: event.msisdn,
      sessionId: transactionId,
      ussdCode: event.serviceCode,
      text: typeof event.text === 'string' ? event.text : '',
      simulateFailure: event.simulateFailure,
    };

    try {
      logWithCorrelation(req.correlationId, 'converted signaling event to /ussd payload', {
        transactionId,
        vasPayload,
      });
      const response = await fetch('http://vas-platform:3002/ussd', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Correlation-ID': req.correlationId,
        },
        body: JSON.stringify(vasPayload),
      });

      const vasResponse = await response.json();
      logWithCorrelation(req.correlationId, 'received response from vas-platform', {
        transactionId,
        status: response.status,
        vasResponse,
      });
      const vasFailed = !response.ok || vasResponse.continueSession === false;
      const businessFailureReason = vasResponse.failureReason || (
        ['SUBSCRIBER_NOT_ACTIVE', 'BILLING_FAILED'].includes(event.simulateFailure)
          ? event.simulateFailure
          : null
      );

      if (vasFailed && businessFailureReason) {
        const result = {
          transactionId,
          decision: `ROUTE_TO_${routingRule.destinationPlatform}`,
          destinationPlatform: routingRule.destinationPlatform,
          status: 'FAILED',
          failureReason: businessFailureReason,
          errorMessage: vasResponse.message || 'VAS platform returned a business failure.',
          responseMessage: vasResponse.message || null,
          sessionId: vasResponse.sessionId,
        };
        await safeCreateTransactionLog(event, result, req.correlationId);
        logWithCorrelation(req.correlationId, 'final response returned', { transactionId, status: response.ok ? 200 : response.status });
        return res.status(response.ok ? 200 : response.status).json({
          ...result,
          correlationId: req.correlationId,
          sessionId: vasResponse.sessionId,
          continueSession: vasResponse.continueSession,
          message: vasResponse.message,
          vasResponse,
        });
      }

      if (!response.ok) {
        const result = {
          transactionId,
          decision: 'MOCK_PROCESSING_FAILED',
          destinationPlatform: routingRule.destinationPlatform,
          status: 'FAILED',
          failureReason: 'VAS_PLATFORM_ERROR',
          errorMessage: 'VAS platform did not accept the converted USSD request.',
          responseMessage: vasResponse.message || null,
          sessionId: vasResponse.sessionId,
        };
        await safeCreateTransactionLog(event, result, req.correlationId);
        logWithCorrelation(req.correlationId, 'final response returned', { transactionId, status: response.status });
        return res.status(response.status).json({
          ...result,
          correlationId: req.correlationId,
          vasResponse,
        });
      }

      const result = {
        transactionId,
        decision: `ROUTE_TO_${routingRule.destinationPlatform}`,
        destinationPlatform: routingRule.destinationPlatform,
        status: 'SUCCESS',
        responseMessage: vasResponse.message || null,
        sessionId: vasResponse.sessionId,
      };
      await safeCreateTransactionLog(event, result, req.correlationId);
      logWithCorrelation(req.correlationId, 'final response returned', { transactionId, status: response.status });
      return res.status(response.status).json({
        ...result,
        correlationId: req.correlationId,
        sessionId: vasResponse.sessionId,
        continueSession: vasResponse.continueSession,
        message: vasResponse.message,
        vasResponse,
      });
    } catch (error) {
      const result = {
        transactionId,
        decision: 'MOCK_PROCESSING_FAILED',
        destinationPlatform: routingRule.destinationPlatform,
        status: 'FAILED',
        failureReason: 'PARTNER_TIMEOUT',
        errorMessage: 'Failed to forward converted USSD request to VAS platform.',
      };
      console.error(`[ussd-gateway] [correlationId=${req.correlationId}] error forwarding converted USSD request to vas-platform`, error);
      await safeCreateTransactionLog(event, result, req.correlationId);
      return res.status(502).json({ ...result, correlationId: req.correlationId });
    }
  }

  const platformResult = processMockDestination(event, routingRule.destinationPlatform);
  logWithCorrelation(req.correlationId, 'mock destination response', {
    transactionId,
    destinationPlatform: routingRule.destinationPlatform,
    platformResult,
  });
  const decision = platformResult.status === 'SUCCESS'
    ? `ROUTE_TO_${routingRule.destinationPlatform}`
    : 'MOCK_PROCESSING_FAILED';

  const result = {
    transactionId,
    decision,
    destinationPlatform: routingRule.destinationPlatform,
    status: platformResult.status,
  };

  if (platformResult.failureReason) {
    result.failureReason = platformResult.failureReason;
  }

  if (platformResult.errorMessage) {
    result.errorMessage = platformResult.errorMessage;
  }

  if (platformResult.message) {
    result.responseMessage = platformResult.message;
  }

  await safeCreateTransactionLog(event, result, req.correlationId);

  const httpStatus = platformResult.status === 'SUCCESS' ? 200 : 500;
  logWithCorrelation(req.correlationId, 'final response returned', { transactionId, status: httpStatus });
  return res.status(httpStatus).json({ ...result, correlationId: req.correlationId });
});

async function start() {
  try {
    pool = await createPoolWithRetry();
    await ensureSchema();
    await initializeTransactionCounter();
    app.listen(PORT, () => {
      console.log(`ussd-gateway listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('[ussd-gateway] failed to start', { error: error.message });
    process.exit(1);
  }
}

start();
