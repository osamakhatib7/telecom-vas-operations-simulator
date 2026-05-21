const express = require('express');
const app = express();
const PORT = process.env.PORT || 3007;

app.use(express.json());

app.use((req, res, next) => {
  console.log(`[core-network-mock] ${req.method} ${req.url}`);
  next();
});

app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    service: 'core-network-mock',
    role: 'mock signaling source',
  });
});

app.post('/simulate/signaling-event', async (req, res) => {
  const event = req.body;
  console.log('[core-network-mock] received mock signaling event', {
    protocol: event.protocol,
    eventType: event.eventType,
    msisdn: event.msisdn,
    serviceType: event.serviceType,
    serviceCode: event.serviceCode,
    simulateFailure: event.simulateFailure,
  });

  try {
    const response = await fetch('http://ussd-gateway:3001/simulate/signaling-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });

    const data = await response.json();
    console.log('[core-network-mock] forwarded signaling event to ussd-gateway', {
      status: response.status,
      response: data,
    });

    return res.status(response.status).json(data);
  } catch (error) {
    console.error('[core-network-mock] error forwarding signaling event to ussd-gateway', error);
    return res.status(502).json({ error: 'Failed to forward signaling event to ussd-gateway' });
  }
});

app.listen(PORT, () => {
  console.log(`core-network-mock listening on port ${PORT}`);
});
