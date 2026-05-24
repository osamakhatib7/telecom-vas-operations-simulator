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

async function getBalance(msisdn, connection = pool) {
  const [rows] = await connection.query('SELECT balance FROM balances WHERE msisdn = ?', [msisdn]);
  if (rows.length === 0) {
    return null;
  }
  return Number(rows[0].balance);
}

async function setInitialBalances(connection = pool) {
  const entries = Object.entries(initialBalances);
  for (const [msisdn, balance] of entries) {
    await connection.query(
      'INSERT INTO balances (msisdn, balance) VALUES (?, ?) ON DUPLICATE KEY UPDATE balance = VALUES(balance)',
      [msisdn, balance]
    );
  }
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
      await connection.query(
        'INSERT INTO ocs_transactions (msisdn, transaction_type, amount, status, balance_after, reference_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [msisdn, 'CHARGE', amount, 'INSUFFICIENT_BALANCE', currentBalance, `CHARGE-${Date.now()}`, JSON.stringify({ reason: 'INSUFFICIENT_BALANCE' })]
      );
      await connection.commit();
      return res.status(400).json({ status: 'INSUFFICIENT_BALANCE' });
    }

    const newBalance = Number((currentBalance - amount).toFixed(2));
    const referenceId = `CHARGE-${Date.now()}`;

    await connection.query('UPDATE balances SET balance = ? WHERE msisdn = ?', [newBalance, msisdn]);
    await connection.query(
      'INSERT INTO ocs_transactions (msisdn, transaction_type, amount, status, balance_after, reference_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [msisdn, 'CHARGE', amount, 'CHARGED', newBalance, referenceId, JSON.stringify({ source: 'vas-platform' })]
    );
    await connection.commit();

    return res.json({ status: 'CHARGED', newBalance });
  } catch (error) {
    await connection.rollback();
    console.error('[ocs-service] charge failed', { msisdn, error: error.message });
    return res.status(500).json({ error: 'OCS service error' });
  } finally {
    connection.release();
  }
});

app.post('/reset-balances', async (req, res) => {
  console.log('[ocs-service] resetting balances to initial state');

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await setInitialBalances(connection);
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
    app.listen(PORT, () => {
      console.log(`ocs-service listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('[ocs-service] failed to start', { error: error.message });
    process.exit(1);
  }
}

start();
