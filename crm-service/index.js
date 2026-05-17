const express = require('express');
const app = express();
const PORT = process.env.PORT || 3003;

app.use((req, res, next) => {
  console.log(`[crm-service] ${req.method} ${req.url}`);
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'crm-service' });
});

app.get('/subscribers/:msisdn', (req, res) => {
  const { msisdn } = req.params;
  const { simulateFailure } = req.query;
  console.log('[crm-service] lookup subscriber', { msisdn, simulateFailure });

  if (simulateFailure === 'crm-500') {
    console.log('[crm-service] simulating 500 error', { msisdn });
    return res.status(500).json({ error: 'CRM service error' });
  }

  if (msisdn === '0599123456') {
    return res.json({ msisdn, status: 'ACTIVE' });
  }

  if (msisdn === '0599000000') {
    return res.json({ msisdn, status: 'SUSPENDED' });
  }

  return res.status(404).json({ error: 'Subscriber not found' });
});

app.listen(PORT, () => {
  console.log(`crm-service listening on port ${PORT}`);
});
