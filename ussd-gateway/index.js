const express = require('express');
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

const routingRules = [
  {
    id: 'RULE-USSD-123',
    serviceType: 'USSD',
    serviceCode: '*123#',
    destinationPlatform: 'VAS_PLATFORM',
    isActive: true,
    priority: 1,
  },
  {
    id: 'RULE-USSD-456',
    serviceType: 'USSD',
    serviceCode: '*456#',
    destinationPlatform: 'BUNDLE_SERVICE',
    isActive: true,
    priority: 2,
  },
  {
    id: 'RULE-ROAMING-USSD-123',
    serviceType: 'ROAMING_USSD',
    serviceCode: '*123#',
    destinationPlatform: 'ROAMING_GATEWAY_MOCK',
    isActive: true,
    priority: 1,
  },
  {
    id: 'RULE-SMS-DEFAULT',
    serviceType: 'SMS',
    serviceCode: 'DEFAULT',
    destinationPlatform: 'SMSC_MOCK',
    isActive: true,
    priority: 10,
  },
  {
    id: 'RULE-VOICE-INTERNATIONAL',
    serviceType: 'VOICE',
    serviceCode: 'INTERNATIONAL',
    destinationPlatform: 'INTERCONNECT_GATEWAY_MOCK',
    isActive: true,
    priority: 1,
  },
];

const transactionLogs = [];
let nextTransactionNumber = 10001;
const startedAt = Date.now();

function createTransactionId() {
  const transactionId = `TX-${nextTransactionNumber}`;
  nextTransactionNumber += 1;
  return transactionId;
}

function findRoutingRule(serviceType, serviceCode) {
  return routingRules
    .filter(rule => rule.isActive && rule.serviceType === serviceType && rule.serviceCode === serviceCode)
    .sort((a, b) => a.priority - b.priority)[0];
}

function createTransactionLog(event, result) {
  const transactionLog = {
    transactionId: result.transactionId,
    msisdn: event.msisdn,
    protocol: event.protocol,
    eventType: event.eventType,
    serviceType: event.serviceType,
    serviceCode: event.serviceCode,
    destinationPlatform: result.destinationPlatform || null,
    status: result.status,
    failureReason: result.failureReason || null,
    errorMessage: result.errorMessage || null,
    createdAt: new Date().toISOString(),
  };

  transactionLogs.push(transactionLog);
  console.log('[ussd-gateway] transaction log created', transactionLog);
  return transactionLog;
}

function incrementCounter(counter, key) {
  const counterKey = key || 'UNKNOWN';
  counter[counterKey] = (counter[counterKey] || 0) + 1;
}

function getTopFailureReason(logs) {
  const failureCounts = {};

  logs.forEach(log => {
    if (log.failureReason) {
      incrementCounter(failureCounts, log.failureReason);
    }
  });

  const topFailure = Object.entries(failureCounts)
    .sort((a, b) => b[1] - a[1])[0];

  return topFailure ? topFailure[0] : null;
}

function processMockDestination(event, destinationPlatform) {
  if (event.simulateFailure === 'SUBSCRIBER_NOT_ACTIVE') {
    return {
      status: 'FAILED',
      failureReason: 'SUBSCRIBER_NOT_ACTIVE',
      errorMessage: 'Subscriber is not active for this service.',
    };
  }

  if (event.simulateFailure === 'BILLING_FAILED') {
    return {
      status: 'FAILED',
      failureReason: 'BILLING_FAILED',
      errorMessage: 'Mock billing validation failed.',
    };
  }

  if (event.simulateFailure === 'PARTNER_TIMEOUT') {
    return {
      status: 'FAILED',
      failureReason: 'PARTNER_TIMEOUT',
      errorMessage: 'Mock partner platform timed out.',
    };
  }

  if (event.simulateFailure === 'INTERNAL_ERROR') {
    return {
      status: 'FAILED',
      failureReason: 'INTERNAL_ERROR',
      errorMessage: 'Internal mock processing error.',
    };
  }

  const platformMessages = {
    BUNDLE_SERVICE: 'Bundle service event accepted.',
    SMSC_MOCK: 'SMS event routed to SMSC mock.',
    ROAMING_GATEWAY_MOCK: 'Roaming USSD event routed to roaming gateway mock.',
    INTERCONNECT_GATEWAY_MOCK: 'International voice event routed to interconnect gateway mock.',
  };

  return {
    status: 'SUCCESS',
    message: platformMessages[destinationPlatform] || 'Event accepted by mock destination.',
  };
}

app.use((req, res, next) => {
  console.log(`[ussd-gateway] ${req.method} ${req.url}`);
  next();
});

app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    service: 'ussd-gateway',
    role: 'USSD Gateway / Service Broker',
    components: {
      gatewayService: 'UP',
      routingModule: routingRules.length > 0 ? 'UP' : 'DOWN',
      transactionLogger: Array.isArray(transactionLogs) ? 'UP' : 'DOWN',
      vasPlatformConnector: 'UP',
    },
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
});

app.get('/kpi/today', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const todayLogs = transactionLogs.filter(log => log.createdAt.slice(0, 10) === today);
  const totalRequests = todayLogs.length;
  const successCount = todayLogs.filter(log => log.status === 'SUCCESS').length;
  const failedCount = todayLogs.filter(log => log.status === 'FAILED').length;
  const successRate = totalRequests === 0 ? '0%' : `${Math.round((successCount / totalRequests) * 100)}%`;
  const requestsByServiceType = {};
  const requestsByDestinationPlatform = {};

  todayLogs.forEach(log => {
    incrementCounter(requestsByServiceType, log.serviceType);
    incrementCounter(requestsByDestinationPlatform, log.destinationPlatform);
  });

  return res.json({
    totalRequests,
    successCount,
    failedCount,
    successRate,
    topFailureReason: getTopFailureReason(todayLogs),
    requestsByServiceType,
    requestsByDestinationPlatform,
  });
});

app.get('/transactions', (req, res) => {
  const { msisdn, serviceType, serviceCode, status, failureReason } = req.query;

  const filteredLogs = transactionLogs
    .filter(log => !msisdn || log.msisdn === msisdn)
    .filter(log => !serviceType || log.serviceType === serviceType)
    .filter(log => !serviceCode || log.serviceCode === serviceCode)
    .filter(log => !status || log.status === status)
    .filter(log => !failureReason || log.failureReason === failureReason)
    .slice()
    .reverse();

  return res.json({
    count: filteredLogs.length,
    transactions: filteredLogs,
  });
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
  const transactionId = createTransactionId();
  console.log('[ussd-gateway] received signaling event', {
    transactionId,
    protocol: event.protocol,
    eventType: event.eventType,
    msisdn: event.msisdn,
    serviceType: event.serviceType,
    serviceCode: event.serviceCode,
    simulateFailure: event.simulateFailure,
  });

  const requiredFields = [
    'protocol',
    'eventType',
    'msisdn',
    'serviceType',
    'serviceCode',
    'originPointCode',
    'destinationPointCode',
    'globalTitle',
    'visitedNetwork',
  ];

  const missingFields = requiredFields.filter(field => !event[field]);

  if (missingFields.length > 0) {
    const result = {
      transactionId,
      decision: 'VALIDATION_FAILED',
      destinationPlatform: null,
      status: 'FAILED',
      failureReason: 'VALIDATION_FAILED',
      errorMessage: `Missing required fields: ${missingFields.join(', ')}`,
    };
    createTransactionLog(event, result);
    return res.status(400).json(result);
  }

  const routingRule = findRoutingRule(event.serviceType, event.serviceCode);

  if (!routingRule) {
    const result = {
      transactionId,
      decision: 'ROUTING_NOT_FOUND',
      destinationPlatform: null,
      status: 'FAILED',
      failureReason: 'ROUTING_NOT_FOUND',
      errorMessage: 'No active routing rule found for serviceType and serviceCode.',
    };
    createTransactionLog(event, result);
    return res.status(404).json(result);
  }

  if (routingRule.destinationPlatform === 'VAS_PLATFORM' && !event.simulateFailure) {
    try {
      const response = await fetch('http://vas-platform:3002/internal/routed-vas-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...event,
          transactionId,
          destinationPlatform: routingRule.destinationPlatform,
        }),
      });

      if (!response.ok) {
        const result = {
          transactionId,
          decision: 'MOCK_PROCESSING_FAILED',
          destinationPlatform: routingRule.destinationPlatform,
          status: 'FAILED',
          failureReason: 'PARTNER_TIMEOUT',
          errorMessage: 'VAS platform did not accept routed event.',
        };
        createTransactionLog(event, result);
        return res.status(502).json(result);
      }
    } catch (error) {
      const result = {
        transactionId,
        decision: 'MOCK_PROCESSING_FAILED',
        destinationPlatform: routingRule.destinationPlatform,
        status: 'FAILED',
        failureReason: 'PARTNER_TIMEOUT',
        errorMessage: 'Failed to forward routed event to VAS platform.',
      };
      createTransactionLog(event, result);
      return res.status(502).json(result);
    }
  }

  const platformResult = processMockDestination(event, routingRule.destinationPlatform);
  const decision = platformResult.status === 'SUCCESS'
    ? `ROUTE_TO_${routingRule.destinationPlatform}`
    : 'MOCK_PROCESSING_FAILED';

  const result = {
    transactionId,
    decision,
    destinationPlatform: routingRule.destinationPlatform,
    status: platformResult.status,
  };

  if (platformResult.failureReason) {
    result.failureReason = platformResult.failureReason;
  }

  if (platformResult.errorMessage) {
    result.errorMessage = platformResult.errorMessage;
  }

  createTransactionLog(event, result);

  const httpStatus = platformResult.status === 'SUCCESS' ? 200 : 500;
  return res.status(httpStatus).json(result);
});

app.listen(PORT, () => {
  console.log(`ussd-gateway listening on port ${PORT}`);
});
