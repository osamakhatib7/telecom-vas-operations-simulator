const express = require('express');
const app = express();
const PORT = process.env.PORT || 3006;

app.use(express.json());

app.use((req, res, next) => {
  console.log(`[aggregator-service] ${req.method} ${req.url}`);
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'aggregator-service' });
});

app.post('/external-service', (req, res) => {
  const { msisdn, serviceCode, simulateFailure } = req.body;
  console.log('[aggregator-service] external request', { msisdn, serviceCode, simulateFailure });

  if (simulateFailure === 'aggregator-timeout') {
    console.log('[aggregator-service] simulating timeout', { msisdn });
    return; // Never send response
  }

  if (simulateFailure === 'aggregator-500') {
    console.log('[aggregator-service] simulating 500 error', { msisdn });
    return res.status(500).json({ error: 'Aggregator service error' });
  }

  if (!msisdn || !serviceCode) {
    return res.status(400).json({ error: 'Invalid external service request' });
  }

  return res.json({ providerStatus: 'SUCCESS', serviceCode });
});

app.listen(PORT, () => {
  console.log(`aggregator-service listening on port ${PORT}`);
});
