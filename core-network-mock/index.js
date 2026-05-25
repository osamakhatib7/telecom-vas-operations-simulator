const express = require('express');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3007;

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
    console.log(`[core-network-mock] [correlationId=${correlationId}] ${message}`, extra);
    return;
  }

  console.log(`[core-network-mock] [correlationId=${correlationId}] ${message}`);
}

app.use((req, res, next) => {
  req.correlationId = getCorrelationId(req);
  res.setHeader('X-Correlation-ID', req.correlationId);
  logWithCorrelation(req.correlationId, `${req.method} ${req.url}`);
  next();
});

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    correlationId: req.correlationId,
    status: 'UP',
    service: 'core-network-mock',
    role: 'mock signaling source',
  });
});

app.post('/simulate/signaling-event', async (req, res) => {
  const event = req.body;
  logWithCorrelation(req.correlationId, 'received mock signaling event', {
    protocol: event.protocol,
    eventType: event.eventType,
    msisdn: event.msisdn,
    serviceType: event.serviceType,
    serviceCode: event.serviceCode,
    simulateFailure: event.simulateFailure,
  });

  try {
    logWithCorrelation(req.correlationId, 'forwarding signaling event to ussd-gateway', {
      msisdn: event.msisdn,
      serviceType: event.serviceType,
      serviceCode: event.serviceCode,
    });
    const response = await fetch('http://ussd-gateway:3001/simulate/signaling-event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-ID': req.correlationId,
      },
      body: JSON.stringify(event),
    });

    const data = await response.json();
    logWithCorrelation(req.correlationId, 'received response from ussd-gateway', {
      status: response.status,
      response: data,
    });

    const responseBody = { ...data, correlationId: req.correlationId };
    logWithCorrelation(req.correlationId, 'final response returned', { status: response.status });
    return res.status(response.status).json(responseBody);
  } catch (error) {
    console.error(`[core-network-mock] [correlationId=${req.correlationId}] error forwarding signaling event to ussd-gateway`, error);
    return res.status(502).json({
      correlationId: req.correlationId,
      error: 'Failed to forward signaling event to ussd-gateway',
    });
  }
});

app.listen(PORT, () => {
  console.log(`core-network-mock listening on port ${PORT}`);
});
