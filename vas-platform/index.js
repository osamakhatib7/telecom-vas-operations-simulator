const express = require('express');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const app = express();
const PORT = process.env.PORT || 3002;

const startedAt = Date.now();
const INTERNET_BUNDLE_OFFER_CODE = 'BUNDLE_1GB';
const INTERNET_BUNDLE_NAME = '1GB Internet Bundle';
const INTERNET_BUNDLE_PRICE = 5;
const NEWS_CATEGORY = 'GENERAL_NEWS';
const NEWS_OFFER_NAME = 'General News Alerts';
const NEWS_PRICE = 1;

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
    console.log(`[vas-platform] [correlationId=${correlationId}] ${message}`, extra);
    return;
  }

  console.log(`[vas-platform] [correlationId=${correlationId}] ${message}`);
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
      console.log('[vas-platform] database connection established', { attempt });
      return candidatePool;
    } catch (error) {
      console.log('[vas-platform] waiting for database', { attempt, error: error.message });
      if (attempt === maxAttempts) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}

async function ensureSchema() {
  console.log('[vas-platform] ensuring database schema');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vas_transactions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      correlation_id VARCHAR(100),
      session_id VARCHAR(100),
      msisdn VARCHAR(20),
      ussd_code VARCHAR(50),
      input_text TEXT,
      selected_option VARCHAR(20),
      flow_name VARCHAR(100),
      subscriber_status VARCHAR(50),
      status VARCHAR(50) NOT NULL DEFAULT 'IN_PROGRESS',
      failure_reason VARCHAR(100),
      customer_message TEXT,
      crm_checked BOOLEAN NOT NULL DEFAULT FALSE,
      ocs_checked BOOLEAN NOT NULL DEFAULT FALSE,
      aggregator_checked BOOLEAN NOT NULL DEFAULT FALSE,
      smsc_checked BOOLEAN NOT NULL DEFAULT FALSE,
      charge_reference_id VARCHAR(100),
      refund_reference_id VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_vas_transactions_created_at (created_at),
      INDEX idx_vas_transactions_correlation_id (correlation_id),
      INDEX idx_vas_transactions_session_id (session_id),
      INDEX idx_vas_transactions_msisdn (msisdn),
      INDEX idx_vas_transactions_status_flow (status, flow_name)
    )
  `);
}

function getFlowName(normalizedText) {
  if (normalizedText === null) {
    return 'INVALID_REQUEST';
  }

  const flowNames = {
    '': 'MAIN_MENU',
    '0': 'MAIN_MENU',
    '1': 'BUY_INTERNET_BUNDLE',
    '2': 'CHECK_BALANCE',
    '3': 'SUBSCRIBE_NEWS_ALERTS',
    '4': 'CHECK_ACTIVE_BUNDLES',
    '5': 'EXIT',
  };

  return flowNames[normalizedText] || 'MAIN_MENU';
}

function getAllowedServices(crmData) {
  return Array.isArray(crmData.allowedServices) ? crmData.allowedServices : [];
}

function isServiceAllowed(crmData, serviceCode) {
  return getAllowedServices(crmData).includes(serviceCode);
}

function inferFailureReason(message, transaction) {
  if (!message) {
    return null;
  }

  const normalizedMessage = message.toLowerCase();

  if (normalizedMessage.includes('sms confirmation could not be sent')) {
    return 'SMSC_CONFIRMATION_FAILED';
  }
  if (normalizedMessage.includes('already have an active')) {
    return 'BUNDLE_ALREADY_ACTIVE';
  }
  if (normalizedMessage.includes('already subscribed')) {
    return 'NEWS_ALREADY_SUBSCRIBED';
  }
  if (normalizedMessage.includes('insufficient balance')) {
    return 'INSUFFICIENT_BALANCE';
  }
  if (normalizedMessage.includes('suspended')) {
    return 'SUBSCRIBER_NOT_ACTIVE';
  }
  if (normalizedMessage.includes('subscriber not found')) {
    return 'SUBSCRIBER_NOT_FOUND';
  }
  if (normalizedMessage.includes('balance information not found')) {
    return 'BALANCE_NOT_FOUND';
  }
  if (normalizedMessage.includes('bundle purchase could not be completed')) {
    return transaction.refundReferenceId ? 'BUNDLE_ACTIVATION_FAILED_REVERSED' : 'BUNDLE_ACTIVATION_FAILED';
  }
  if (normalizedMessage.includes('news subscription could not be completed')) {
    return transaction.refundReferenceId ? 'NEWS_SUBSCRIPTION_FAILED_REVERSED' : 'NEWS_SUBSCRIPTION_FAILED';
  }
  if (normalizedMessage.includes('unable to verify news subscription')) {
    return 'AGGREGATOR_PRECHECK_FAILED';
  }
  if (normalizedMessage.includes('unable to retrieve active internet bundles')
    || normalizedMessage.includes('unable to verify active internet bundles')) {
    return 'OCS_ACTIVE_BUNDLES_FAILED';
  }
  if (normalizedMessage.includes('unable to check or charge')
    || normalizedMessage.includes('unable to charge')) {
    return transaction.ocsChecked ? 'OCS_FAILURE' : 'BALANCE_OR_CHARGE_FAILURE';
  }
  if (normalizedMessage.includes('service temporarily unavailable')) {
    return transaction.crmChecked ? 'CRM_FAILURE' : 'SERVICE_UNAVAILABLE';
  }

  return null;
}

function inferFinalStatus(body, transaction) {
  if (transaction.status && transaction.status !== 'IN_PROGRESS') {
    return transaction.status;
  }

  const message = body && body.message ? body.message : null;
  if (message && message.toLowerCase().includes('successful, but sms confirmation could not be sent')) {
    return 'PARTIAL_SUCCESS';
  }

  if ((body && body.error) || (body && body.failureReason) || inferFailureReason(message, transaction)) {
    return 'FAILED';
  }

  return 'SUCCESS';
}

async function createVasTransaction(req, initial) {
  try {
    const [result] = await pool.query(
      `INSERT INTO vas_transactions
        (correlation_id, session_id, msisdn, ussd_code, input_text, selected_option, flow_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req.correlationId,
        initial.sessionId || null,
        initial.msisdn || null,
        initial.ussdCode || null,
        initial.inputText,
        initial.selectedOption,
        initial.flowName,
      ]
    );

    return result.insertId;
  } catch (error) {
    console.error(`[vas-platform] [correlationId=${req.correlationId}] failed to create VAS transaction`, { error: error.message });
    return null;
  }
}

async function updateVasTransaction(req, transaction) {
  if (!transaction.id) {
    return;
  }

  try {
    await pool.query(
      `UPDATE vas_transactions
       SET
        selected_option = ?,
        flow_name = ?,
        subscriber_status = ?,
        status = ?,
        failure_reason = ?,
        customer_message = ?,
        crm_checked = ?,
        ocs_checked = ?,
        aggregator_checked = ?,
        smsc_checked = ?,
        charge_reference_id = ?,
        refund_reference_id = ?
       WHERE id = ?`,
      [
        transaction.selectedOption,
        transaction.flowName,
        transaction.subscriberStatus,
        transaction.status,
        transaction.failureReason,
        transaction.customerMessage,
        transaction.crmChecked,
        transaction.ocsChecked,
        transaction.aggregatorChecked,
        transaction.smscChecked,
        transaction.chargeReferenceId,
        transaction.refundReferenceId,
        transaction.id,
      ]
    );
  } catch (error) {
    console.error(`[vas-platform] [correlationId=${req.correlationId}] failed to update VAS transaction`, {
      transactionId: transaction.id,
      error: error.message,
    });
  }
}

function attachVasTransactionFinalizer(req, res, transaction) {
  const originalJson = res.json.bind(res);
  res.json = async (body) => {
    const message = body && body.message ? body.message : null;
    transaction.customerMessage = message || body && body.error || null;
    transaction.status = inferFinalStatus(body, transaction);
    transaction.failureReason = body && body.failureReason
      ? body.failureReason
      : transaction.failureReason || inferFailureReason(message, transaction);

    await updateVasTransaction(req, transaction);
    return originalJson(body);
  };
}

function mapVasTransaction(row) {
  return {
    id: row.id,
    correlationId: row.correlationId,
    sessionId: row.sessionId,
    msisdn: row.msisdn,
    ussdCode: row.ussdCode,
    inputText: row.inputText,
    selectedOption: row.selectedOption,
    flowName: row.flowName,
    subscriberStatus: row.subscriberStatus,
    status: row.status,
    failureReason: row.failureReason,
    customerMessage: row.customerMessage,
    crmChecked: Boolean(row.crmChecked),
    ocsChecked: Boolean(row.ocsChecked),
    aggregatorChecked: Boolean(row.aggregatorChecked),
    smscChecked: Boolean(row.smscChecked),
    chargeReferenceId: row.chargeReferenceId,
    refundReferenceId: row.refundReferenceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMessage = 'Request timeout') {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutMessage)), 5000)),
  ]);
}

async function checkDependencyHealth(url, correlationId) {
  try {
    const response = await Promise.race([
      fetch(url, { headers: { 'X-Correlation-ID': correlationId } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Health check timeout')), 2000)),
    ]);

    return response.ok ? 'UP' : 'DOWN';
  } catch (error) {
    return 'DOWN';
  }
}

function buildMainMenu(balance) {
  return [
    'Welcome to VAS Platform',
    `Your balance is: ${balance} NIS`,
    '1. Buy internet bundle',
    '2. Check balance',
    '3. Subscribe to news alerts',
    '4. Check active internet bundles',
    '5. Exit',
  ].join('\n');
}

function formatDataAllowance(megabytes) {
  if (megabytes >= 1024 && megabytes % 1024 === 0) {
    return `${megabytes / 1024}GB`;
  }
  return `${megabytes}MB`;
}

function formatBundleExpiry(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toISOString().slice(0, 10);
}

function formatActiveBundles(bundles) {
  if (!bundles.length) {
    return 'You have no active internet bundles.';
  }

  const lines = bundles.map(bundle => {
    const allowance = formatDataAllowance(Number(bundle.remainingDataMb));
    return `${bundle.bundleName}: ${allowance} remaining, valid until ${formatBundleExpiry(bundle.validUntil)}`;
  });

  return ['Active internet bundles:', ...lines].join('\n');
}

app.use((req, res, next) => {
  req.correlationId = getCorrelationId(req);
  res.setHeader('X-Correlation-ID', req.correlationId);
  addCorrelationToJsonResponse(req, res);
  logWithCorrelation(req.correlationId, `${req.method} ${req.url}`);
  next();
});

app.use(express.json());

app.get('/health', async (req, res) => {
  const [crmService, ocsService, aggregatorService, smscService] = await Promise.all([
    checkDependencyHealth('http://crm-service:3003/health', req.correlationId),
    checkDependencyHealth('http://ocs-service:3004/health', req.correlationId),
    checkDependencyHealth('http://aggregator-service:3006/health', req.correlationId),
    checkDependencyHealth('http://smsc-service:3005/health', req.correlationId),
  ]);
  let database = 'UP';
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    database = 'DOWN';
    console.error(`[vas-platform] [correlationId=${req.correlationId}] health check database error`, { error: error.message });
  }

  const components = {
    vasService: 'UP',
    crmService,
    ocsService,
    aggregatorService,
    smscService,
    database,
  };

  const allDependenciesUp = Object.values(components).every(status => status === 'UP');

  res.json({
    status: allDependenciesUp ? 'UP' : 'DEGRADED',
    service: 'vas-platform',
    components,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
});

app.get('/transactions', async (req, res) => {
  const { msisdn, correlationId, sessionId, status, flowName } = req.query;
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
  if (sessionId) {
    conditions.push('session_id = ?');
    params.push(sessionId);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (flowName) {
    conditions.push('flow_name = ?');
    params.push(flowName);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const [rows] = await pool.query(
      `SELECT
        id,
        correlation_id AS correlationId,
        session_id AS sessionId,
        msisdn,
        ussd_code AS ussdCode,
        input_text AS inputText,
        selected_option AS selectedOption,
        flow_name AS flowName,
        subscriber_status AS subscriberStatus,
        status,
        failure_reason AS failureReason,
        customer_message AS customerMessage,
        crm_checked AS crmChecked,
        ocs_checked AS ocsChecked,
        aggregator_checked AS aggregatorChecked,
        smsc_checked AS smscChecked,
        charge_reference_id AS chargeReferenceId,
        refund_reference_id AS refundReferenceId,
        created_at AS createdAt,
        updated_at AS updatedAt
       FROM vas_transactions
       ${whereClause}
       ORDER BY created_at DESC, id DESC`,
      params
    );

    return res.json({
      count: rows.length,
      transactions: rows.map(mapVasTransaction),
    });
  } catch (error) {
    console.error(`[vas-platform] [correlationId=${req.correlationId}] VAS transaction query failed`, { error: error.message });
    return res.status(500).json({ error: 'Failed to read VAS transactions' });
  }
});

app.get('/transactions/:correlationId', async (req, res) => {
  const { correlationId } = req.params;

  try {
    const [rows] = await pool.query(
      `SELECT
        id,
        correlation_id AS correlationId,
        session_id AS sessionId,
        msisdn,
        ussd_code AS ussdCode,
        input_text AS inputText,
        selected_option AS selectedOption,
        flow_name AS flowName,
        subscriber_status AS subscriberStatus,
        status,
        failure_reason AS failureReason,
        customer_message AS customerMessage,
        crm_checked AS crmChecked,
        ocs_checked AS ocsChecked,
        aggregator_checked AS aggregatorChecked,
        smsc_checked AS smscChecked,
        charge_reference_id AS chargeReferenceId,
        refund_reference_id AS refundReferenceId,
        created_at AS createdAt,
        updated_at AS updatedAt
       FROM vas_transactions
       WHERE correlation_id = ?
       ORDER BY created_at DESC, id DESC`,
      [correlationId]
    );

    return res.json({
      count: rows.length,
      transactions: rows.map(mapVasTransaction),
    });
  } catch (error) {
    console.error(`[vas-platform] [correlationId=${req.correlationId}] VAS transaction lookup failed`, {
      requestedCorrelationId: correlationId,
      error: error.message,
    });
    return res.status(500).json({ error: 'Failed to read VAS transactions' });
  }
});

app.post('/ussd', async (req, res) => {
  const { msisdn, sessionId, ussdCode, text, simulateFailure } = req.body;
  logWithCorrelation(req.correlationId, 'received /ussd request', { sessionId, msisdn, ussdCode, text, simulateFailure });

  const inputText = typeof text === 'string' ? text : null;
  const normalizedText = inputText !== null ? inputText.trim() : null;
  const vasTransaction = {
    id: null,
    selectedOption: normalizedText,
    flowName: getFlowName(normalizedText),
    subscriberStatus: null,
    status: 'IN_PROGRESS',
    failureReason: null,
    customerMessage: null,
    crmChecked: false,
    ocsChecked: false,
    aggregatorChecked: false,
    smscChecked: false,
    chargeReferenceId: null,
    refundReferenceId: null,
  };

  vasTransaction.id = await createVasTransaction(req, {
    sessionId,
    msisdn,
    ussdCode,
    inputText,
    selectedOption: vasTransaction.selectedOption,
    flowName: vasTransaction.flowName,
  });
  attachVasTransactionFinalizer(req, res, vasTransaction);

  if (!msisdn || !sessionId || !ussdCode || typeof text !== 'string') {
    logWithCorrelation(req.correlationId, 'invalid /ussd payload', { sessionId });
    vasTransaction.status = 'FAILED';
    vasTransaction.failureReason = 'INVALID_USSD_PAYLOAD';
    return res.status(400).json({ error: 'Invalid ussd request payload' });
  }

  const buildFailureQs = (failure) => failure ? `?simulateFailure=${encodeURIComponent(failure)}` : '';
  const crmFailure = ['SUBSCRIBER_NOT_ACTIVE', 'BILLING_FAILED'].includes(simulateFailure) ? null : simulateFailure;
  const ocsFailure = simulateFailure === 'BILLING_FAILED' ? 'billing-500' : simulateFailure;
  const activationFailure = simulateFailure === 'BUNDLE_ACTIVATION_FAILED' ? 'ocs-activation-500' : null;

  async function fetchActiveBundles() {
    vasTransaction.ocsChecked = true;
    logWithCorrelation(req.correlationId, 'calling OCS active bundles', { sessionId, msisdn });
    const activeBundlesResponse = await fetchWithTimeout(
      `http://ocs-service:3004/bundles/${encodeURIComponent(msisdn)}/active`,
      { headers: { 'X-Correlation-ID': req.correlationId } },
      'OCS active bundles timeout'
    ).catch(err => err);

    if (activeBundlesResponse instanceof Error) {
      logWithCorrelation(req.correlationId, 'OCS active bundles failed', { sessionId, error: activeBundlesResponse.message });
      return { error: activeBundlesResponse };
    }

    if (!activeBundlesResponse.ok) {
      logWithCorrelation(req.correlationId, 'OCS active bundles error', { sessionId, status: activeBundlesResponse.status });
      return { error: new Error('OCS active bundles error') };
    }

    const activeBundlesData = await activeBundlesResponse.json();
    logWithCorrelation(req.correlationId, 'OCS active bundles response', {
      sessionId,
      status: activeBundlesResponse.status,
      count: activeBundlesData.count,
    });
    return { data: activeBundlesData };
  }

  async function refundCharge(chargeData, reason, amount = INTERNET_BUNDLE_PRICE) {
    vasTransaction.ocsChecked = true;
    logWithCorrelation(req.correlationId, 'calling OCS refund', {
      sessionId,
      msisdn,
      amount,
      originalReferenceId: chargeData.referenceId,
      reason,
    });

    const refundResponse = await fetchWithTimeout(
      'http://ocs-service:3004/refund',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Correlation-ID': req.correlationId,
        },
        body: JSON.stringify({
          msisdn,
          amount,
          originalReferenceId: chargeData.referenceId,
          reason,
        }),
      },
      'OCS refund timeout'
    ).catch(err => err);

    if (refundResponse instanceof Error) {
      logWithCorrelation(req.correlationId, 'OCS refund failed', { sessionId, error: refundResponse.message });
      return { status: 'REFUND_FAILED' };
    }

    if (!refundResponse.ok) {
      logWithCorrelation(req.correlationId, 'OCS refund error', { sessionId, status: refundResponse.status });
      return { status: 'REFUND_FAILED' };
    }

    const refundData = await refundResponse.json();
    vasTransaction.refundReferenceId = refundData.refundReferenceId || vasTransaction.refundReferenceId;
    logWithCorrelation(req.correlationId, 'OCS refund response', { sessionId, status: refundResponse.status, refundStatus: refundData.status });
    return refundData;
  }

  async function fetchNewsSubscriptions(category = NEWS_CATEGORY) {
    vasTransaction.aggregatorChecked = true;
    logWithCorrelation(req.correlationId, 'calling Aggregator subscription lookup', { sessionId, msisdn, category });
    const subscriptionsResponse = await fetchWithTimeout(
      `http://aggregator-service:3006/subscriptions/${encodeURIComponent(msisdn)}?category=${encodeURIComponent(category)}`,
      { headers: { 'X-Correlation-ID': req.correlationId } },
      'Aggregator subscription lookup timeout'
    ).catch(err => err);

    if (subscriptionsResponse instanceof Error) {
      logWithCorrelation(req.correlationId, 'Aggregator subscription lookup failed', { sessionId, error: subscriptionsResponse.message });
      return { error: subscriptionsResponse };
    }

    if (!subscriptionsResponse.ok) {
      logWithCorrelation(req.correlationId, 'Aggregator subscription lookup error', { sessionId, status: subscriptionsResponse.status });
      return { error: new Error('Aggregator subscription lookup error') };
    }

    const subscriptionsData = await subscriptionsResponse.json();
    logWithCorrelation(req.correlationId, 'Aggregator subscription lookup response', {
      sessionId,
      status: subscriptionsResponse.status,
      count: subscriptionsData.count,
    });
    return { data: subscriptionsData };
  }

  try {
    vasTransaction.crmChecked = true;
    logWithCorrelation(req.correlationId, 'calling CRM subscriber lookup', { sessionId, msisdn, simulateFailure });
    const crmResponse = await fetchWithTimeout(
      `http://crm-service:3003/subscribers/${encodeURIComponent(msisdn)}${buildFailureQs(crmFailure)}`,
      { headers: { 'X-Correlation-ID': req.correlationId } },
      'CRM timeout'
    ).catch(err => err);

    if (crmResponse instanceof Error) {
      logWithCorrelation(req.correlationId, 'CRM failed', { sessionId, error: crmResponse.message });
      const message = 'Service temporarily unavailable. Please try again later.';
      console.log('[vas-platform] final response', { sessionId, message, reason: 'crm_failure' });
      return res.json({ sessionId, continueSession: false, message });
    }

    if (crmResponse.status === 404) {
      const message = 'Subscriber not found. Please check your number and try again.';
      console.log('[vas-platform] final response', { sessionId, message, status: 404 });
      return res.json({ sessionId, continueSession: false, message });
    }

    if (!crmResponse.ok) {
      logWithCorrelation(req.correlationId, 'CRM error', { sessionId, status: crmResponse.status });
      const message = 'Service temporarily unavailable. Please try again later.';
      console.log('[vas-platform] final response', { sessionId, message, reason: 'crm_error' });
      return res.json({ sessionId, continueSession: false, message });
    }

    const crmData = await crmResponse.json();
    vasTransaction.subscriberStatus = crmData.status || null;
    logWithCorrelation(req.correlationId, 'CRM response', { sessionId, status: crmData.status, crmData });

    if (simulateFailure === 'SUBSCRIBER_NOT_ACTIVE') {
      const message = 'Your subscription is suspended. Please contact support.';
      console.log('[vas-platform] final response', { sessionId, message, reason: 'subscriber_not_active_simulation' });
      return res.json({ sessionId, continueSession: false, message, failureReason: 'SUBSCRIBER_NOT_ACTIVE' });
    }

    if (crmData.status === 'SUSPENDED') {
      const message = 'Your subscription is suspended. Please contact support.';
      console.log('[vas-platform] final response', { sessionId, message });
      return res.json({ sessionId, continueSession: false, message });
    }

    if (crmData.status !== 'ACTIVE') {
      const message = 'Unable to verify subscriber status. Please try again later.';
      console.log('[vas-platform] final response', { sessionId, message });
      return res.json({ sessionId, continueSession: false, message });
    }

    if (normalizedText === '1') {
      logWithCorrelation(req.correlationId, 'allowedServices check started', {
        sessionId,
        msisdn,
        requiredService: 'INTERNET_BUNDLE',
      });

      if (!isServiceAllowed(crmData, 'INTERNET_BUNDLE')) {
        const message = 'You are not eligible for internet bundle service.';
        vasTransaction.status = 'FAILED';
        vasTransaction.failureReason = 'NOT_ELIGIBLE';
        vasTransaction.customerMessage = message;
        logWithCorrelation(req.correlationId, 'subscriber not eligible', {
          sessionId,
          msisdn,
          requiredService: 'INTERNET_BUNDLE',
          allowedServices: getAllowedServices(crmData),
        });
        console.log('[vas-platform] final response', { sessionId, message, reason: 'not_eligible' });
        return res.json({ sessionId, continueSession: false, message });
      }

      logWithCorrelation(req.correlationId, 'subscriber eligible', {
        sessionId,
        msisdn,
        requiredService: 'INTERNET_BUNDLE',
      });
    }

    if (normalizedText === '3') {
      logWithCorrelation(req.correlationId, 'allowedServices check started', {
        sessionId,
        msisdn,
        requiredService: NEWS_CATEGORY,
      });

      if (!isServiceAllowed(crmData, NEWS_CATEGORY)) {
        const message = 'You are not eligible for news alerts service.';
        vasTransaction.flowName = 'SUBSCRIBE_NEWS';
        vasTransaction.status = 'FAILED';
        vasTransaction.failureReason = 'NOT_ELIGIBLE';
        vasTransaction.customerMessage = message;
        logWithCorrelation(req.correlationId, 'subscriber not eligible', {
          sessionId,
          msisdn,
          requiredService: NEWS_CATEGORY,
          allowedServices: getAllowedServices(crmData),
        });
        console.log('[vas-platform] final response', { sessionId, message, reason: 'not_eligible' });
        return res.json({ sessionId, continueSession: false, message });
      }

      logWithCorrelation(req.correlationId, 'subscriber eligible', {
        sessionId,
        msisdn,
        requiredService: NEWS_CATEGORY,
      });
    }

    vasTransaction.ocsChecked = true;
    logWithCorrelation(req.correlationId, 'calling OCS balance', { sessionId, msisdn, simulateFailure });
    const ocsResponse = await fetchWithTimeout(
      `http://ocs-service:3004/balance/${encodeURIComponent(msisdn)}${buildFailureQs(ocsFailure)}`,
      { headers: { 'X-Correlation-ID': req.correlationId } },
      'OCS timeout'
    ).catch(err => err);

    if (ocsResponse instanceof Error) {
      logWithCorrelation(req.correlationId, 'OCS failed', { sessionId, error: ocsResponse.message });
      const message = 'Unable to check or charge your balance right now. Please try again later.';
      console.log('[vas-platform] final response', { sessionId, message, reason: 'ocs_failure' });
      return res.json({ sessionId, continueSession: false, message, failureReason: simulateFailure === 'BILLING_FAILED' ? 'BILLING_FAILED' : undefined });
    }

    if (ocsResponse.status === 404) {
      const message = 'Balance information not found. Please try again later.';
      console.log('[vas-platform] final response', { sessionId, message, status: 404 });
      return res.json({ sessionId, continueSession: false, message });
    }

    if (!ocsResponse.ok) {
      logWithCorrelation(req.correlationId, 'OCS error', { sessionId, status: ocsResponse.status });
      const message = 'Unable to check or charge your balance right now. Please try again later.';
      console.log('[vas-platform] final response', { sessionId, message, reason: 'ocs_error' });
      return res.json({ sessionId, continueSession: false, message, failureReason: simulateFailure === 'BILLING_FAILED' ? 'BILLING_FAILED' : undefined });
    }

    const ocsData = await ocsResponse.json();
    logWithCorrelation(req.correlationId, 'OCS balance response', { sessionId, status: ocsResponse.status, ocsData });

    const balance = ocsData.balance;

    if (normalizedText === '' || normalizedText === '0') {
      const message = buildMainMenu(balance);
      console.log('[vas-platform] final response', { sessionId, message });
      return res.json({ sessionId, continueSession: true, message });
    }

    if (normalizedText === '2') {
      const message = `Your balance is: ${balance} NIS`;
      console.log('[vas-platform] final response', { sessionId, message });
      return res.json({ sessionId, continueSession: false, message });
    }

    if (normalizedText === '3') {
      const subscriptionsResult = await fetchNewsSubscriptions(NEWS_CATEGORY);
      if (subscriptionsResult.error) {
        const message = 'Unable to verify news subscription status. Please try again later.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'news_subscription_precheck_error' });
        return res.json({ sessionId, continueSession: false, message });
      }

      if ((subscriptionsResult.data.subscriptions || []).length > 0) {
        const message = `You are already subscribed to ${NEWS_OFFER_NAME}.`;
        console.log('[vas-platform] final response', { sessionId, message, reason: 'news_subscription_already_active' });
        return res.json({ sessionId, continueSession: false, message });
      }

      if (balance < NEWS_PRICE) {
        const message = 'Insufficient balance to subscribe to news alerts';
        console.log('[vas-platform] final response', { sessionId, message });
        return res.json({ sessionId, continueSession: false, message });
      }

      logWithCorrelation(req.correlationId, 'charging account through OCS for news subscription', {
        sessionId,
        msisdn,
        amount: NEWS_PRICE,
        category: NEWS_CATEGORY,
        simulateFailure,
      });
      const chargeResponse = await fetchWithTimeout(
        'http://ocs-service:3004/charge',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Correlation-ID': req.correlationId,
          },
          body: JSON.stringify({ msisdn, amount: NEWS_PRICE, simulateFailure: ocsFailure }),
        },
        'OCS charge timeout'
      ).catch(err => err);

      if (chargeResponse instanceof Error) {
        logWithCorrelation(req.correlationId, 'News charge failed', { sessionId, error: chargeResponse.message });
        const message = 'Unable to charge your balance right now. Please try again later.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'news_charge_failure' });
        return res.json({ sessionId, continueSession: false, message, failureReason: simulateFailure === 'BILLING_FAILED' ? 'BILLING_FAILED' : undefined });
      }

      if (!chargeResponse.ok || chargeResponse.status >= 400) {
        logWithCorrelation(req.correlationId, 'News charge error', { sessionId, status: chargeResponse.status });
        const message = 'Unable to charge your balance right now. Please try again later.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'news_charge_error' });
        return res.json({ sessionId, continueSession: false, message, failureReason: simulateFailure === 'BILLING_FAILED' ? 'BILLING_FAILED' : undefined });
      }

      const chargeData = await chargeResponse.json();
      vasTransaction.chargeReferenceId = chargeData.referenceId || vasTransaction.chargeReferenceId;
      logWithCorrelation(req.correlationId, 'OCS news charge response', { sessionId, status: chargeResponse.status, chargeData });

      if (chargeData.status !== 'CHARGED') {
        const message = 'Unable to charge your balance right now. Please try again later.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'news_charge_not_successful' });
        return res.json({ sessionId, continueSession: false, message });
      }

      const aggregatorFailure = simulateFailure === 'NEWS_SUBSCRIPTION_FAILED' ? 'aggregator-500' : null;
      vasTransaction.aggregatorChecked = true;
      logWithCorrelation(req.correlationId, 'calling Aggregator subscription', {
        sessionId,
        msisdn,
        category: NEWS_CATEGORY,
        chargeReferenceId: chargeData.referenceId,
      });
      const subscriptionResponse = await fetchWithTimeout(
        'http://aggregator-service:3006/subscriptions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Correlation-ID': req.correlationId,
          },
          body: JSON.stringify({
            msisdn,
            category: NEWS_CATEGORY,
            referenceId: chargeData.referenceId,
            simulateFailure: aggregatorFailure,
          }),
        },
        'Aggregator subscription timeout'
      ).catch(err => err);

      if (subscriptionResponse instanceof Error || !subscriptionResponse.ok || subscriptionResponse.status >= 400) {
        logWithCorrelation(req.correlationId, 'Aggregator subscription failed after charge', {
          sessionId,
          error: subscriptionResponse instanceof Error ? subscriptionResponse.message : subscriptionResponse.status,
        });
        const refundData = await refundCharge(chargeData, 'NEWS_SUBSCRIPTION_FAILED_AFTER_CHARGE', NEWS_PRICE);
        const message = refundData.status === 'REFUNDED'
          ? 'News subscription could not be completed. Charged amount has been reversed.'
          : 'News subscription could not be completed. Your transaction has been flagged for reversal.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'news_subscription_failed_post_charge' });
        return res.json({ sessionId, continueSession: false, message });
      }

      const subscriptionData = await subscriptionResponse.json();
      logWithCorrelation(req.correlationId, 'Aggregator subscription response', {
        sessionId,
        status: subscriptionResponse.status,
        providerStatus: subscriptionData.providerStatus,
        category: subscriptionData.subscription && subscriptionData.subscription.category,
      });

      if (subscriptionData.providerStatus !== 'SUCCESS') {
        const refundData = await refundCharge(chargeData, 'NEWS_SUBSCRIPTION_NOT_SUCCESSFUL_AFTER_CHARGE', NEWS_PRICE);
        const message = refundData.status === 'REFUNDED'
          ? 'News subscription could not be completed. Charged amount has been reversed.'
          : 'News subscription could not be completed. Your transaction has been flagged for reversal.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'news_subscription_not_successful' });
        return res.json({ sessionId, continueSession: false, message });
      }

      vasTransaction.smscChecked = true;
      logWithCorrelation(req.correlationId, 'calling SMSC', { sessionId, msisdn, message: `You have subscribed to ${NEWS_OFFER_NAME}.`, simulateFailure });
      const smsResponse = await fetchWithTimeout(
        'http://smsc-service:3005/send-sms',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Correlation-ID': req.correlationId,
          },
          body: JSON.stringify({ msisdn, message: `You have subscribed to ${NEWS_OFFER_NAME}.`, simulateFailure }),
        },
        'SMSC timeout'
      ).catch(err => err);

      if (smsResponse instanceof Error || !smsResponse.ok || smsResponse.status >= 400) {
        logWithCorrelation(req.correlationId, 'SMSC failed but news subscription succeeded', { sessionId, error: smsResponse instanceof Error ? smsResponse.message : smsResponse.status });
        const message = 'News alerts subscription successful, but SMS confirmation could not be sent.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'smsc_failure_post_news_subscription' });
        return res.json({ sessionId, continueSession: false, message });
      }

      const smsData = await smsResponse.json();
      logWithCorrelation(req.correlationId, 'SMSC response', { sessionId, status: smsResponse.status, smsData });

      if (smsData.deliveryStatus !== 'DELIVERED') {
        logWithCorrelation(req.correlationId, 'SMS not delivered', { sessionId, smsData });
        const message = 'News alerts subscription successful, but SMS confirmation could not be sent.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'sms_not_delivered_post_news_subscription' });
        return res.json({ sessionId, continueSession: false, message });
      }

      const message = 'News alerts subscription successful. Confirmation SMS sent.';
      console.log('[vas-platform] final response', { sessionId, message });
      return res.json({ sessionId, continueSession: false, message });
    }

    if (normalizedText === '4') {
      const activeBundlesResult = await fetchActiveBundles();
      if (activeBundlesResult.error) {
        const message = 'Unable to retrieve active internet bundles. Please try again later.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'active_bundles_error' });
        return res.json({ sessionId, continueSession: false, message });
      }

      const message = formatActiveBundles(activeBundlesResult.data.bundles || []);
      console.log('[vas-platform] final response', { sessionId, message });
      return res.json({ sessionId, continueSession: false, message });
    }

    if (normalizedText === '5') {
      const message = 'Thank you for using VAS Platform.';
      console.log('[vas-platform] final response', { sessionId, message });
      return res.json({ sessionId, continueSession: false, message });
    }

    if (normalizedText === '1') {
      const activeBundlesResult = await fetchActiveBundles();
      if (activeBundlesResult.error) {
        const message = 'Unable to verify active internet bundles. Please try again later.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'active_bundles_precheck_error' });
        return res.json({ sessionId, continueSession: false, message });
      }

      const hasSameActiveBundle = (activeBundlesResult.data.bundles || [])
        .some(bundle => bundle.offerCode === INTERNET_BUNDLE_OFFER_CODE);

      if (hasSameActiveBundle) {
        const message = `You already have an active ${INTERNET_BUNDLE_NAME}.`;
        console.log('[vas-platform] final response', { sessionId, message, reason: 'bundle_already_active_precheck' });
        return res.json({ sessionId, continueSession: false, message });
      }

      if (balance < INTERNET_BUNDLE_PRICE) {
        const message = 'Insufficient balance to buy bundle';
        console.log('[vas-platform] final response', { sessionId, message });
        return res.json({ sessionId, continueSession: false, message });
      }

      logWithCorrelation(req.correlationId, 'charging account through OCS', {
        sessionId,
        msisdn,
        amount: INTERNET_BUNDLE_PRICE,
        simulateFailure,
      });
      const chargeResponse = await fetchWithTimeout(
        'http://ocs-service:3004/charge',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Correlation-ID': req.correlationId,
          },
          body: JSON.stringify({ msisdn, amount: INTERNET_BUNDLE_PRICE, simulateFailure: ocsFailure }),
        },
        'OCS charge timeout'
      ).catch(err => err);

      if (chargeResponse instanceof Error) {
        logWithCorrelation(req.correlationId, 'Charge failed', { sessionId, error: chargeResponse.message });
        const message = 'Unable to check or charge your balance right now. Please try again later.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'charge_failure' });
        return res.json({ sessionId, continueSession: false, message, failureReason: simulateFailure === 'BILLING_FAILED' ? 'BILLING_FAILED' : undefined });
      }

      if (!chargeResponse.ok || chargeResponse.status >= 400) {
        logWithCorrelation(req.correlationId, 'Charge error', { sessionId, status: chargeResponse.status });
        const message = 'Unable to check or charge your balance right now. Please try again later.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'charge_error' });
        return res.json({ sessionId, continueSession: false, message, failureReason: simulateFailure === 'BILLING_FAILED' ? 'BILLING_FAILED' : undefined });
      }

      const chargeData = await chargeResponse.json();
      vasTransaction.chargeReferenceId = chargeData.referenceId || vasTransaction.chargeReferenceId;
      logWithCorrelation(req.correlationId, 'OCS charge response', { sessionId, status: chargeResponse.status, chargeData });

      if (chargeData.status !== 'CHARGED') {
        const message = 'Unable to check or charge your balance right now. Please try again later.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'charge_not_successful' });
        return res.json({ sessionId, continueSession: false, message });
      }

      logWithCorrelation(req.correlationId, 'activating internet bundle through OCS', {
        sessionId,
        msisdn,
        offerCode: INTERNET_BUNDLE_OFFER_CODE,
        chargeReferenceId: chargeData.referenceId,
      });
      const activationResponse = await fetchWithTimeout(
        'http://ocs-service:3004/bundles/activate',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Correlation-ID': req.correlationId,
          },
          body: JSON.stringify({
            msisdn,
            offerCode: INTERNET_BUNDLE_OFFER_CODE,
            referenceId: chargeData.referenceId,
            simulateFailure: activationFailure,
          }),
        },
        'OCS bundle activation timeout'
      ).catch(err => err);

      if (activationResponse instanceof Error || !activationResponse.ok || activationResponse.status >= 400) {
        logWithCorrelation(req.correlationId, 'OCS bundle activation failed after charge', {
          sessionId,
          error: activationResponse instanceof Error ? activationResponse.message : activationResponse.status,
        });
        const refundData = await refundCharge(chargeData, 'BUNDLE_ACTIVATION_FAILED_AFTER_CHARGE');
        const message = refundData.status === 'REFUNDED'
          ? 'Bundle purchase could not be completed. Charged amount has been reversed.'
          : 'Bundle purchase could not be completed. Your transaction has been flagged for reversal.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'bundle_activation_failed_post_charge' });
        return res.json({ sessionId, continueSession: false, message });
      }

      const activationData = await activationResponse.json();
      logWithCorrelation(req.correlationId, 'OCS bundle activation response', {
        sessionId,
        status: activationResponse.status,
        activationStatus: activationData.status,
        bundle: activationData.bundle,
      });

      if (activationData.status !== 'ACTIVATED') {
        const refundData = await refundCharge(chargeData, 'BUNDLE_ACTIVATION_NOT_SUCCESSFUL_AFTER_CHARGE');
        const message = refundData.status === 'REFUNDED'
          ? 'Bundle purchase could not be completed. Charged amount has been reversed.'
          : 'Bundle purchase could not be completed. Your transaction has been flagged for reversal.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'bundle_activation_not_successful' });
        return res.json({ sessionId, continueSession: false, message });
      }

      vasTransaction.smscChecked = true;
      logWithCorrelation(req.correlationId, 'calling SMSC', { sessionId, msisdn, message: 'Your 1GB bundle has been activated.', simulateFailure });
      const smsResponse = await fetchWithTimeout(
        'http://smsc-service:3005/send-sms',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Correlation-ID': req.correlationId,
          },
          body: JSON.stringify({ msisdn, message: 'Your 1GB bundle has been activated.', simulateFailure }),
        },
        'SMSC timeout'
      ).catch(err => err);

      if (smsResponse instanceof Error || !smsResponse.ok || smsResponse.status >= 400) {
        logWithCorrelation(req.correlationId, 'SMSC failed but purchase succeeded', { sessionId, error: smsResponse instanceof Error ? smsResponse.message : smsResponse.status });
        const message = 'Bundle purchase successful, but SMS confirmation could not be sent.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'smsc_failure_post_purchase' });
        return res.json({ sessionId, continueSession: false, message });
      }

      const smsData = await smsResponse.json();
      logWithCorrelation(req.correlationId, 'SMSC response', { sessionId, status: smsResponse.status, smsData });

      if (smsData.deliveryStatus !== 'DELIVERED') {
        logWithCorrelation(req.correlationId, 'SMS not delivered', { sessionId, smsData });
        const message = 'Bundle purchase successful, but SMS confirmation could not be sent.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'sms_not_delivered' });
        return res.json({ sessionId, continueSession: false, message });
      }

      const message = 'Bundle purchase successful. Confirmation SMS sent.';
      console.log('[vas-platform] final response', { sessionId, message });
      return res.json({ sessionId, continueSession: false, message });
    }

    const message = buildMainMenu(balance);
    console.log('[vas-platform] final response', { sessionId, message });
    return res.json({ sessionId, continueSession: true, message });
  } catch (error) {
    console.error(`[vas-platform] [correlationId=${req.correlationId}] error processing ussd`, { sessionId, error: error.message });
    const message = 'Service temporarily unavailable. Please try again later.';
    vasTransaction.status = 'FAILED';
    vasTransaction.failureReason = 'UNEXPECTED_ERROR';
    vasTransaction.customerMessage = message;
    console.log('[vas-platform] final response', { sessionId, message, reason: 'uncaught_error' });
    return res.json({ sessionId, continueSession: false, message });
  }
});

async function start() {
  try {
    pool = await createPoolWithRetry();
    await ensureSchema();
    app.listen(PORT, () => {
      console.log(`vas-platform listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('[vas-platform] failed to start', { error: error.message });
    process.exit(1);
  }
}

start();
