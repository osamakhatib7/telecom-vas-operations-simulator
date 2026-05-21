const express = require('express');
const app = express();
const PORT = process.env.PORT || 3004;

app.use(express.json());

const balances = {
  '0599123456': 10.5,
  '970599123456': 10.5,
  '0599000000': 0,
};

app.use((req, res, next) => {
  console.log(`[billing-service] ${req.method} ${req.url}`);
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'billing-service' });
});

app.get('/balance/:msisdn', (req, res) => {
  const { msisdn } = req.params;
  const { simulateFailure } = req.query;
  console.log('[billing-service] lookup balance', { msisdn, simulateFailure });

  if (simulateFailure === 'billing-timeout') {
    console.log('[billing-service] simulating timeout', { msisdn });
    return; // Never send response, will timeout after ~30s
  }

  if (simulateFailure === 'billing-500') {
    console.log('[billing-service] simulating 500 error', { msisdn });
    return res.status(500).json({ error: 'Billing service error' });
  }

  if (balances.hasOwnProperty(msisdn)) {
    return res.json({ msisdn, balance: balances[msisdn] });
  }

  return res.status(404).json({ error: 'Balance not found' });
});

app.post('/charge', (req, res) => {
  const { msisdn, amount, simulateFailure } = req.body;
  console.log('[billing-service] charge request', { msisdn, amount, simulateFailure });

  if (simulateFailure === 'billing-timeout') {
    console.log('[billing-service] simulating timeout on charge', { msisdn });
    return; // Never send response
  }

  if (simulateFailure === 'billing-500') {
    console.log('[billing-service] simulating 500 error on charge', { msisdn });
    return res.status(500).json({ error: 'Billing service error' });
  }

  if (!msisdn || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid charge request' });
  }

  if (!balances.hasOwnProperty(msisdn)) {
    return res.status(404).json({ error: 'Balance not found' });
  }

  if (balances[msisdn] < amount) {
    return res.status(400).json({ status: 'INSUFFICIENT_BALANCE' });
  }

  balances[msisdn] -= amount;
  return res.json({ status: 'CHARGED', newBalance: balances[msisdn] });
});

app.post('/reset-balances', (req, res) => {
  console.log('[billing-service] resetting balances to initial state');
  balances['0599123456'] = 10.5;
  balances['970599123456'] = 10.5;
  balances['0599000000'] = 0;
  return res.json({ status: 'reset', balances });
});

app.listen(PORT, () => {
  console.log(`billing-service listening on port ${PORT}`);
});
