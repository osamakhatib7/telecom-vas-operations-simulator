const express = require('express');
const app = express();
const PORT = process.env.PORT || 3005;

app.use(express.json());

app.use((req, res, next) => {
  console.log(`[smsc-service] ${req.method} ${req.url}`);
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'smsc-service' });
});

app.post('/send-sms', (req, res) => {
  const { msisdn, message, simulateFailure } = req.body;
  console.log('[smsc-service] send sms', { msisdn, message, simulateFailure });

  if (simulateFailure === 'smsc-down') {
    console.log('[smsc-service] simulating service down (500)', { msisdn });
    return res.status(500).json({ error: 'SMSC service unavailable' });
  }

  if (simulateFailure === 'smsc-failed') {
    console.log('[smsc-service] simulating delivery failure', { msisdn });
    return res.json({ deliveryStatus: 'FAILED', error: 'SMS delivery failed' });
  }

  if (!msisdn || !message) {
    return res.status(400).json({ error: 'Invalid SMS request' });
  }

  return res.json({ deliveryStatus: 'DELIVERED' });
});

app.listen(PORT, () => {
  console.log(`smsc-service listening on port ${PORT}`);
});
