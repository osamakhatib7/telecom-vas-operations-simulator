const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3004;

app.use(express.json());

const initialBalances = {
  '0599123456': 10.5,
  '970599123456': 10.5,
  '0599000000': 0,
};

const initialBundleOffers = [
  {
    offerCode: 'BUNDLE_1GB',
    bundleName: '1GB Internet Bundle',
    price: 5,
    dataAllowanceMb: 1024,
    validityDays: 7,
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

app.use((req, res, next) => {
  console.log(`[ocs-service] ${req.method} ${req.url}`);
  next();
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createReferenceId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

async function createPoolWithRetry(maxAttempts = 30, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const candidatePool = mysql.createPool(dbConfig);
      const connection = await candidatePool.getConnection();
      await connection.ping();
      connection.release();
      console.log('[ocs-service] database connection established', { attempt });
      return candidatePool;
    } catch (error) {
      console.log('[ocs-service] waiting for database', { attempt, error: error.message });
      if (attempt === maxAttempts) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}

async function recordOcsTransaction(connection, transaction) {
  const {
    msisdn,
    transactionType,
    amount,
    status,
    balanceAfter = null,
    referenceId = null,
    details = {},
  } = transaction;

  await connection.query(
    'INSERT INTO ocs_transactions (msisdn, transaction_type, amount, status, balance_after, reference_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [msisdn, transactionType, amount, status, balanceAfter, referenceId, JSON.stringify(details)]
  );
}

async function ensureSchema() {
  console.log('[ocs-service] ensuring database schema');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS balances (
      msisdn VARCHAR(20) PRIMARY KEY,
      balance DECIMAL(10, 2) NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ocs_transactions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      msisdn VARCHAR(20) NOT NULL,
      transaction_type VARCHAR(50) NOT NULL,
      amount DECIMAL(10, 2) NOT NULL,
      status VARCHAR(50) NOT NULL,
      balance_after DECIMAL(10, 2),
      reference_id VARCHAR(100),
      details JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bundle_offers (
      offer_code VARCHAR(50) PRIMARY KEY,
      bundle_name VARCHAR(100) NOT NULL,
      price DECIMAL(10, 2) NOT NULL,
      data_allowance_mb INT NOT NULL,
      validity_days INT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS active_bundles (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      msisdn VARCHAR(20) NOT NULL,
      offer_code VARCHAR(50) NOT NULL,
      bundle_name VARCHAR(100) NOT NULL,
      remaining_data_mb INT NOT NULL,
      valid_from DATETIME NOT NULL,
      valid_until DATETIME NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      activation_reference_id VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_active_bundles_msisdn_status (msisdn, status),
      INDEX idx_active_bundles_validity (valid_until)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS refunds (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      msisdn VARCHAR(20) NOT NULL,
      amount DECIMAL(10, 2) NOT NULL,
      original_reference_id VARCHAR(100),
      refund_reference_id VARCHAR(100) NOT NULL UNIQUE,
      status VARCHAR(50) NOT NULL,
      reason VARCHAR(255),
      balance_after DECIMAL(10, 2),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_refunds_msisdn (msisdn),
      INDEX idx_refunds_original_reference (original_reference_id)
    )
  `);

  await seedInitialBalances();
  await seedBundleOffers();
}

async function getBalance(msisdn, connection = pool) {
  const [rows] = await connection.query('SELECT balance FROM balances WHERE msisdn = ?', [msisdn]);
  if (rows.length === 0) {
    return null;
  }
  return Number(rows[0].balance);
}

async function seedInitialBalances(connection = pool, overwriteExisting = false) {
  const entries = Object.entries(initialBalances);
  for (const [msisdn, balance] of entries) {
    if (overwriteExisting) {
      await connection.query(
        'INSERT INTO balances (msisdn, balance) VALUES (?, ?) ON DUPLICATE KEY UPDATE balance = VALUES(balance)',
        [msisdn, balance]
      );
    } else {
      await connection.query(
        'INSERT INTO balances (msisdn, balance) VALUES (?, ?) ON DUPLICATE KEY UPDATE msisdn = msisdn',
        [msisdn, balance]
      );
    }
  }
}

async function seedBundleOffers(connection = pool) {
  for (const offer of initialBundleOffers) {
    await connection.query(
      `INSERT INTO bundle_offers
        (offer_code, bundle_name, price, data_allowance_mb, validity_days, is_active)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        bundle_name = VALUES(bundle_name),
        price = VALUES(price),
        data_allowance_mb = VALUES(data_allowance_mb),
        validity_days = VALUES(validity_days),
        is_active = VALUES(is_active)`,
      [
        offer.offerCode,
        offer.bundleName,
        offer.price,
        offer.dataAllowanceMb,
        offer.validityDays,
        offer.isActive,
      ]
    );
  }
}

async function expireOldBundles(msisdn, connection = pool) {
  await connection.query(
    "UPDATE active_bundles SET status = 'EXPIRED' WHERE msisdn = ? AND status = 'ACTIVE' AND valid_until <= NOW()",
    [msisdn]
  );
}

async function getActiveBundles(msisdn, connection = pool) {
  await expireOldBundles(msisdn, connection);
  const [bundles] = await connection.query(
    `SELECT
      id,
      msisdn,
      offer_code AS offerCode,
      bundle_name AS bundleName,
      remaining_data_mb AS remainingDataMb,
      valid_from AS validFrom,
      valid_until AS validUntil,
      status,
      activation_reference_id AS activationReferenceId
     FROM active_bundles
     WHERE msisdn = ? AND status = 'ACTIVE' AND valid_until > NOW()
     ORDER BY valid_until ASC`,
    [msisdn]
  );
  return bundles;
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.json({ status: 'ok', service: 'ocs-service', database: 'UP' });
  } catch (error) {
    console.error('[ocs-service] health check failed', { error: error.message });
    return res.status(500).json({ status: 'error', service: 'ocs-service', database: 'DOWN' });
  }
});

app.get('/balance/:msisdn', async (req, res) => {
  const { msisdn } = req.params;
  const { simulateFailure } = req.query;
  console.log('[ocs-service] lookup balance', { msisdn, simulateFailure });

  if (simulateFailure === 'billing-timeout') {
    console.log('[ocs-service] simulating timeout', { msisdn });
    return;
  }

  if (simulateFailure === 'billing-500') {
    console.log('[ocs-service] simulating 500 error', { msisdn });
    return res.status(500).json({ error: 'OCS service error' });
  }

  try {
    const balance = await getBalance(msisdn);
    if (balance !== null) {
      return res.json({ msisdn, balance });
    }

    return res.status(404).json({ error: 'Balance not found' });
  } catch (error) {
    console.error('[ocs-service] balance lookup failed', { msisdn, error: error.message });
    return res.status(500).json({ error: 'OCS service error' });
  }
});

app.post('/charge', async (req, res) => {
  const { msisdn, amount, simulateFailure } = req.body;
  console.log('[ocs-service] charge request', { msisdn, amount, simulateFailure });

  if (simulateFailure === 'billing-timeout') {
    console.log('[ocs-service] simulating timeout on charge', { msisdn });
    return;
  }

  if (simulateFailure === 'billing-500') {
    console.log('[ocs-service] simulating 500 error on charge', { msisdn });
    return res.status(500).json({ error: 'OCS service error' });
  }

  if (!msisdn || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid charge request' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.query('SELECT balance FROM balances WHERE msisdn = ? FOR UPDATE', [msisdn]);
    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Balance not found' });
    }

    const currentBalance = Number(rows[0].balance);
    if (currentBalance < amount) {
      const referenceId = createReferenceId('CHARGE');
      await recordOcsTransaction(connection, {
        msisdn,
        transactionType: 'CHARGE',
        amount,
        status: 'INSUFFICIENT_BALANCE',
        balanceAfter: currentBalance,
        referenceId,
        details: { reason: 'INSUFFICIENT_BALANCE' },
      });
      await connection.commit();
      return res.status(400).json({ status: 'INSUFFICIENT_BALANCE', referenceId });
    }

    const newBalance = Number((currentBalance - amount).toFixed(2));
    const referenceId = createReferenceId('CHARGE');

    await connection.query('UPDATE balances SET balance = ? WHERE msisdn = ?', [newBalance, msisdn]);
    await recordOcsTransaction(connection, {
      msisdn,
      transactionType: 'CHARGE',
      amount,
      status: 'CHARGED',
      balanceAfter: newBalance,
      referenceId,
      details: { source: 'vas-platform' },
    });
    await connection.commit();

    return res.json({ status: 'CHARGED', newBalance, referenceId });
  } catch (error) {
    await connection.rollback();
    console.error('[ocs-service] charge failed', { msisdn, error: error.message });
    return res.status(500).json({ error: 'OCS service error' });
  } finally {
    connection.release();
  }
});

app.post('/refund', async (req, res) => {
  const { msisdn, amount, originalReferenceId, reason } = req.body;
  console.log('[ocs-service] refund request', { msisdn, amount, originalReferenceId, reason });

  if (!msisdn || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid refund request' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    if (originalReferenceId) {
      const [existingRefunds] = await connection.query(
        "SELECT refund_reference_id AS refundReferenceId, balance_after AS balanceAfter FROM refunds WHERE original_reference_id = ? AND status = 'REFUNDED' LIMIT 1",
        [originalReferenceId]
      );

      if (existingRefunds.length > 0) {
        await connection.commit();
        return res.json({
          status: 'REFUNDED',
          alreadyProcessed: true,
          refundReferenceId: existingRefunds[0].refundReferenceId,
          newBalance: Number(existingRefunds[0].balanceAfter),
        });
      }
    }

    const [rows] = await connection.query('SELECT balance FROM balances WHERE msisdn = ? FOR UPDATE', [msisdn]);
    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Balance not found' });
    }

    const currentBalance = Number(rows[0].balance);
    const newBalance = Number((currentBalance + amount).toFixed(2));
    const refundReferenceId = createReferenceId('REFUND');

    await connection.query('UPDATE balances SET balance = ? WHERE msisdn = ?', [newBalance, msisdn]);
    await connection.query(
      'INSERT INTO refunds (msisdn, amount, original_reference_id, refund_reference_id, status, reason, balance_after) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [msisdn, amount, originalReferenceId || null, refundReferenceId, 'REFUNDED', reason || null, newBalance]
    );
    await recordOcsTransaction(connection, {
      msisdn,
      transactionType: 'REFUND',
      amount,
      status: 'REFUNDED',
      balanceAfter: newBalance,
      referenceId: refundReferenceId,
      details: { originalReferenceId, reason },
    });
    await connection.commit();

    return res.json({ status: 'REFUNDED', newBalance, refundReferenceId });
  } catch (error) {
    await connection.rollback();
    console.error('[ocs-service] refund failed', { msisdn, error: error.message });
    return res.status(500).json({ error: 'OCS service error' });
  } finally {
    connection.release();
  }
});

app.post('/bundles/activate', async (req, res) => {
  const { msisdn, offerCode, referenceId, simulateFailure } = req.body;
  console.log('[ocs-service] bundle activation request', { msisdn, offerCode, referenceId, simulateFailure });

  if (simulateFailure === 'ocs-activation-timeout') {
    console.log('[ocs-service] simulating bundle activation timeout', { msisdn, offerCode });
    return;
  }

  if (simulateFailure === 'ocs-activation-500') {
    console.log('[ocs-service] simulating bundle activation error', { msisdn, offerCode });
    return res.status(500).json({ error: 'Bundle activation failed' });
  }

  if (!msisdn || !offerCode) {
    return res.status(400).json({ error: 'Invalid bundle activation request' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [offers] = await connection.query(
      'SELECT offer_code, bundle_name, price, data_allowance_mb, validity_days, is_active FROM bundle_offers WHERE offer_code = ?',
      [offerCode]
    );

    if (offers.length === 0 || !offers[0].is_active) {
      await recordOcsTransaction(connection, {
        msisdn,
        transactionType: 'BUNDLE_ACTIVATION',
        amount: 0,
        status: 'OFFER_NOT_AVAILABLE',
        referenceId,
        details: { offerCode },
      });
      await connection.commit();
      return res.status(404).json({ status: 'OFFER_NOT_AVAILABLE' });
    }

    await expireOldBundles(msisdn, connection);
    const [activeRows] = await connection.query(
      "SELECT id FROM active_bundles WHERE msisdn = ? AND offer_code = ? AND status = 'ACTIVE' AND valid_until > NOW() FOR UPDATE",
      [msisdn, offerCode]
    );

    if (activeRows.length > 0) {
      await recordOcsTransaction(connection, {
        msisdn,
        transactionType: 'BUNDLE_ACTIVATION',
        amount: 0,
        status: 'ALREADY_ACTIVE',
        referenceId,
        details: { offerCode },
      });
      await connection.commit();
      return res.status(409).json({ status: 'ALREADY_ACTIVE' });
    }

    const offer = offers[0];
    const validFrom = new Date();
    const validUntil = new Date(Date.now() + Number(offer.validity_days) * 24 * 60 * 60 * 1000);
    const activationReferenceId = referenceId || createReferenceId('BUNDLE');

    await connection.query(
      `INSERT INTO active_bundles
        (msisdn, offer_code, bundle_name, remaining_data_mb, valid_from, valid_until, status, activation_reference_id)
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      [
        msisdn,
        offer.offer_code,
        offer.bundle_name,
        offer.data_allowance_mb,
        validFrom,
        validUntil,
        activationReferenceId,
      ]
    );
    await recordOcsTransaction(connection, {
      msisdn,
      transactionType: 'BUNDLE_ACTIVATION',
      amount: 0,
      status: 'ACTIVATED',
      referenceId: activationReferenceId,
      details: {
        offerCode: offer.offer_code,
        bundleName: offer.bundle_name,
        dataAllowanceMb: offer.data_allowance_mb,
        validityDays: offer.validity_days,
      },
    });
    await connection.commit();

    return res.json({
      status: 'ACTIVATED',
      bundle: {
        offerCode: offer.offer_code,
        bundleName: offer.bundle_name,
        remainingDataMb: offer.data_allowance_mb,
        validityDays: offer.validity_days,
        validFrom,
        validUntil,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error('[ocs-service] bundle activation failed', { msisdn, offerCode, error: error.message });
    return res.status(500).json({ error: 'Bundle activation failed' });
  } finally {
    connection.release();
  }
});

app.get('/bundles/:msisdn/active', async (req, res) => {
  const { msisdn } = req.params;
  console.log('[ocs-service] active bundles request', { msisdn });

  try {
    const bundles = await getActiveBundles(msisdn);
    return res.json({
      msisdn,
      count: bundles.length,
      bundles,
    });
  } catch (error) {
    console.error('[ocs-service] active bundles lookup failed', { msisdn, error: error.message });
    return res.status(500).json({ error: 'OCS service error' });
  }
});

app.post('/reset-balances', async (req, res) => {
  console.log('[ocs-service] resetting OCS state to initial state');

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await seedInitialBalances(connection, true);
    await seedBundleOffers(connection);
    await connection.query('DELETE FROM active_bundles');
    await connection.query('DELETE FROM refunds');
    await connection.query('DELETE FROM ocs_transactions');
    await connection.commit();

    const balances = {};
    for (const msisdn of Object.keys(initialBalances)) {
      balances[msisdn] = await getBalance(msisdn);
    }

    return res.json({ status: 'reset', balances });
  } catch (error) {
    await connection.rollback();
    console.error('[ocs-service] reset balances failed', { error: error.message });
    return res.status(500).json({ error: 'OCS service error' });
  } finally {
    connection.release();
  }
});

app.get('/transactions/:msisdn', async (req, res) => {
  const { msisdn } = req.params;
  console.log('[ocs-service] transaction history request', { msisdn });

  try {
    const [transactions] = await pool.query(
      'SELECT id, msisdn, transaction_type, amount, status, balance_after, reference_id, details, created_at FROM ocs_transactions WHERE msisdn = ? ORDER BY created_at DESC, id DESC',
      [msisdn]
    );

    return res.json({
      msisdn,
      count: transactions.length,
      transactions,
    });
  } catch (error) {
    console.error('[ocs-service] transaction history failed', { msisdn, error: error.message });
    return res.status(500).json({ error: 'OCS service error' });
  }
});

async function start() {
  try {
    pool = await createPoolWithRetry();
    await ensureSchema();
    app.listen(PORT, () => {
      console.log(`ocs-service listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('[ocs-service] failed to start', { error: error.message });
    process.exit(1);
  }
}

start();
