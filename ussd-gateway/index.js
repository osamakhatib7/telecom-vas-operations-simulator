const express = require('express');
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

app.use((req, res, next) => {
  console.log(`[ussd-gateway] ${req.method} ${req.url}`);
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ussd-gateway' });
});

app.post('/simulate-ussd', async (req, res) => {
  const { msisdn, sessionId, ussdCode, text, simulateFailure } = req.body;
  console.log('[ussd-gateway] received simulate-ussd', { msisdn, sessionId, ussdCode, text, simulateFailure });

  const payload = { msisdn, sessionId, ussdCode, text };
  if (simulateFailure) {
    payload.simulateFailure = simulateFailure;
  }

  try {
    const response = await fetch('http://vas-platform:3002/ussd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    console.log('[ussd-gateway] forwarded to vas-platform', { status: response.status, response: data });

    return res.status(response.status).json(data);
  } catch (error) {
    console.error('[ussd-gateway] error forwarding to vas-platform', error);
    return res.status(502).json({ error: 'Failed to forward to vas-platform' });
  }
});

app.post('/simulate/signaling-event', async (req, res) => {
  const event = req.body;
  console.log('[ussd-gateway] received signaling event', {
    protocol: event.protocol,
    eventType: event.eventType,
    msisdn: event.msisdn,
    serviceType: event.serviceType,
    serviceCode: event.serviceCode,
    simulateFailure: event.simulateFailure,
  });

  try {
    const response = await fetch('http://vas-platform:3002/signaling-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });

    const data = await response.json();
    console.log('[ussd-gateway] forwarded signaling event to vas-platform', { status: response.status, response: data });

    return res.status(response.status).json(data);
  } catch (error) {
    console.error('[ussd-gateway] error forwarding signaling event to vas-platform', error);
    return res.status(502).json({ error: 'Failed to forward signaling event to vas-platform' });
  }
});

app.listen(PORT, () => {
  console.log(`ussd-gateway listening on port ${PORT}`);
});
