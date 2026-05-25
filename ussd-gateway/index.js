const express = require('express');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3001;

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
    console.log(`[ussd-gateway] [correlationId=${correlationId}] ${message}`, extra);
    return;
  }

  console.log(`[ussd-gateway] [correlationId=${correlationId}] ${message}`);
}

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

function createTransactionLog(event, result, correlationId) {
  const transactionLog = {
    transactionId: result.transactionId,
    correlationId,
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
  logWithCorrelation(correlationId, 'transaction log created', transactionLog);
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
      failureReason: 'GATEWAY_INTERNAL_ERROR',
      errorMessage: 'Internal gateway mock processing error.',
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
    correlationId: req.correlationId,
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
    correlationId: req.correlationId,
    count: filteredLogs.length,
    transactions: filteredLogs,
  });
});

app.post('/simulate-ussd', async (req, res) => {
  const { msisdn, sessionId, ussdCode, text, simulateFailure } = req.body;
  logWithCorrelation(req.correlationId, 'received simulate-ussd', { msisdn, sessionId, ussdCode, text, simulateFailure });

  const payload = { msisdn, sessionId, ussdCode, text };
  if (simulateFailure) {
    payload.simulateFailure = simulateFailure;
  }

  try {
    logWithCorrelation(req.correlationId, 'forwarding simulate-ussd to vas-platform', { msisdn, sessionId, ussdCode });
    const response = await fetch('http://vas-platform:3002/ussd', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-ID': req.correlationId,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    logWithCorrelation(req.correlationId, 'received response from vas-platform', { status: response.status, response: data });

    return res.status(response.status).json({ ...data, correlationId: req.correlationId });
  } catch (error) {
    console.error(`[ussd-gateway] [correlationId=${req.correlationId}] error forwarding to vas-platform`, error);
    return res.status(502).json({ correlationId: req.correlationId, error: 'Failed to forward to vas-platform' });
  }
});

app.post('/simulate/signaling-event', async (req, res) => {
  const event = req.body;
  const transactionId = createTransactionId();
  logWithCorrelation(req.correlationId, 'received signaling event', {
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
    logWithCorrelation(req.correlationId, 'validation failure', { transactionId, missingFields });
    createTransactionLog(event, result, req.correlationId);
    return res.status(400).json({ ...result, correlationId: req.correlationId });
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
    logWithCorrelation(req.correlationId, 'routing failure', {
      transactionId,
      serviceType: event.serviceType,
      serviceCode: event.serviceCode,
    });
    createTransactionLog(event, result, req.correlationId);
    return res.status(404).json({ ...result, correlationId: req.correlationId });
  }

  logWithCorrelation(req.correlationId, 'routing decision', {
    transactionId,
    ruleId: routingRule.id,
    destinationPlatform: routingRule.destinationPlatform,
  });

  if (event.simulateFailure === 'INTERNAL_ERROR') {
    const result = {
      transactionId,
      decision: 'MOCK_PROCESSING_FAILED',
      destinationPlatform: routingRule.destinationPlatform,
      status: 'FAILED',
      failureReason: 'GATEWAY_INTERNAL_ERROR',
      errorMessage: 'Internal gateway mock processing error.',
    };
    logWithCorrelation(req.correlationId, 'gateway internal error simulation', { transactionId });
    createTransactionLog(event, result, req.correlationId);
    return res.status(500).json({ ...result, correlationId: req.correlationId });
  }

  if (routingRule.destinationPlatform === 'VAS_PLATFORM') {
    const vasPayload = {
      msisdn: event.msisdn,
      sessionId: transactionId,
      ussdCode: event.serviceCode,
      text: typeof event.text === 'string' ? event.text : '',
      simulateFailure: event.simulateFailure,
    };

    try {
      logWithCorrelation(req.correlationId, 'converted signaling event to /ussd payload', {
        transactionId,
        vasPayload,
      });
      const response = await fetch('http://vas-platform:3002/ussd', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Correlation-ID': req.correlationId,
        },
        body: JSON.stringify(vasPayload),
      });

      const vasResponse = await response.json();
      logWithCorrelation(req.correlationId, 'received response from vas-platform', {
        transactionId,
        status: response.status,
        vasResponse,
      });
      const vasFailed = !response.ok || vasResponse.continueSession === false;
      const businessFailureReason = vasResponse.failureReason || (
        ['SUBSCRIBER_NOT_ACTIVE', 'BILLING_FAILED'].includes(event.simulateFailure)
          ? event.simulateFailure
          : null
      );

      if (vasFailed && businessFailureReason) {
        const result = {
          transactionId,
          decision: `ROUTE_TO_${routingRule.destinationPlatform}`,
          destinationPlatform: routingRule.destinationPlatform,
          status: 'FAILED',
          failureReason: businessFailureReason,
          errorMessage: vasResponse.message || 'VAS platform returned a business failure.',
        };
        createTransactionLog(event, result, req.correlationId);
        logWithCorrelation(req.correlationId, 'final response returned', { transactionId, status: response.ok ? 200 : response.status });
        return res.status(response.ok ? 200 : response.status).json({
          ...result,
          correlationId: req.correlationId,
          sessionId: vasResponse.sessionId,
          continueSession: vasResponse.continueSession,
          message: vasResponse.message,
          vasResponse,
        });
      }

      if (!response.ok) {
        const result = {
          transactionId,
          decision: 'MOCK_PROCESSING_FAILED',
          destinationPlatform: routingRule.destinationPlatform,
          status: 'FAILED',
          failureReason: 'VAS_PLATFORM_ERROR',
          errorMessage: 'VAS platform did not accept the converted USSD request.',
        };
        createTransactionLog(event, result, req.correlationId);
        logWithCorrelation(req.correlationId, 'final response returned', { transactionId, status: response.status });
        return res.status(response.status).json({
          ...result,
          correlationId: req.correlationId,
          vasResponse,
        });
      }

      const result = {
        transactionId,
        decision: `ROUTE_TO_${routingRule.destinationPlatform}`,
        destinationPlatform: routingRule.destinationPlatform,
        status: 'SUCCESS',
      };
      createTransactionLog(event, result, req.correlationId);
      logWithCorrelation(req.correlationId, 'final response returned', { transactionId, status: response.status });
      return res.status(response.status).json({
        ...result,
        correlationId: req.correlationId,
        sessionId: vasResponse.sessionId,
        continueSession: vasResponse.continueSession,
        message: vasResponse.message,
        vasResponse,
      });
    } catch (error) {
      const result = {
        transactionId,
        decision: 'MOCK_PROCESSING_FAILED',
        destinationPlatform: routingRule.destinationPlatform,
        status: 'FAILED',
        failureReason: 'PARTNER_TIMEOUT',
        errorMessage: 'Failed to forward converted USSD request to VAS platform.',
      };
      console.error(`[ussd-gateway] [correlationId=${req.correlationId}] error forwarding converted USSD request to vas-platform`, error);
      createTransactionLog(event, result, req.correlationId);
      return res.status(502).json({ ...result, correlationId: req.correlationId });
    }
  }

  const platformResult = processMockDestination(event, routingRule.destinationPlatform);
  logWithCorrelation(req.correlationId, 'mock destination response', {
    transactionId,
    destinationPlatform: routingRule.destinationPlatform,
    platformResult,
  });
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

  createTransactionLog(event, result, req.correlationId);

  const httpStatus = platformResult.status === 'SUCCESS' ? 200 : 500;
  logWithCorrelation(req.correlationId, 'final response returned', { transactionId, status: httpStatus });
  return res.status(httpStatus).json({ ...result, correlationId: req.correlationId });
});

app.listen(PORT, () => {
  console.log(`ussd-gateway listening on port ${PORT}`);
});
