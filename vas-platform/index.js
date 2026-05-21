const express = require('express');
const app = express();
const PORT = process.env.PORT || 3002;

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
  console.log('[vas-platform] transaction log created', transactionLog);
  return transactionLog;
}

function processMockPlatform(event, destinationPlatform) {
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
    VAS_PLATFORM: 'USSD event routed to VAS platform.',
    BUNDLE_SERVICE: 'Bundle service event accepted.',
    SMSC_MOCK: 'SMS event routed to SMSC mock.',
    ROAMING_GATEWAY_MOCK: 'Roaming USSD event routed to roaming gateway mock.',
    INTERCONNECT_GATEWAY_MOCK: 'International voice event routed to interconnect gateway mock.',
  };

  return {
    status: 'SUCCESS',
    message: platformMessages[destinationPlatform] || 'Event accepted by mock platform.',
  };
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

app.use((req, res, next) => {
  console.log(`[vas-platform] ${req.method} ${req.url}`);
  next();
});

app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    components: {
      vasService: 'UP',
      routingModule: routingRules.length > 0 ? 'UP' : 'DOWN',
      transactionLogger: Array.isArray(transactionLogs) ? 'UP' : 'DOWN',
      billingMock: 'UP',
      crmMock: 'UP',
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

app.post('/signaling-event', (req, res) => {
  const event = req.body;
  const transactionId = createTransactionId();
  console.log('[vas-platform] received signaling event', {
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

  const platformResult = processMockPlatform(event, routingRule.destinationPlatform);
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

app.post('/ussd', async (req, res) => {
  const { msisdn, sessionId, ussdCode, text, simulateFailure } = req.body;
  console.log('[vas-platform] received request', { sessionId, msisdn, ussdCode, text, simulateFailure });

  if (!msisdn || !sessionId || !ussdCode || typeof text !== 'string') {
    console.log('[vas-platform] invalid payload', { sessionId });
    return res.status(400).json({ error: 'Invalid ussd request payload' });
  }

  try {
    // Build query param for failure simulation if present
    const failureQs = simulateFailure ? `?simulateFailure=${encodeURIComponent(simulateFailure)}` : '';

    console.log('[vas-platform] calling CRM', { sessionId, msisdn, simulateFailure });
    const crmResponse = await Promise.race([
      fetch(`http://crm-service:3003/subscribers/${encodeURIComponent(msisdn)}${failureQs}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('CRM timeout')), 5000))
    ]).catch(err => err);

    if (crmResponse instanceof Error) {
      console.log('[vas-platform] CRM failed', { sessionId, error: crmResponse.message });
      const message = 'Service temporarily unavailable. Please try again later.';
      console.log('[vas-platform] final response', { sessionId, message, reason: 'crm_failure' });
      return res.json({ sessionId, continueSession: false, message });
    }

    // Handle 404 specifically before treating other 4xx/5xx errors
    if (crmResponse.status === 404) {
      const message = 'Subscriber not found. Please check your number and try again.';
      console.log('[vas-platform] final response', { sessionId, message, status: 404 });
      return res.json({ sessionId, continueSession: false, message });
    }

    if (!crmResponse.ok) {
      console.log('[vas-platform] CRM error', { sessionId, status: crmResponse.status });
      const message = 'Service temporarily unavailable. Please try again later.';
      console.log('[vas-platform] final response', { sessionId, message, reason: 'crm_error' });
      return res.json({ sessionId, continueSession: false, message });
    }

    const crmData = await crmResponse.json();
    console.log('[vas-platform] CRM response', { sessionId, status: crmData.status, crmData });

    if (crmData.status === 'SUSPENDED') {
      const message = 'Your subscription is suspended. Please contact support.';
      console.log('[vas-platform] final response', { sessionId, message });
      return res.json({ sessionId, continueSession: false, message });
    }

    if (crmData.status !== 'ACTIVE') {
      const message = 'Unable to verify subscriber status. Please try again later.';
      console.log('[vas-platform] final response', { sessionId, message });
      return res.json({ sessionId, continueSession: false, message });
    }

    console.log('[vas-platform] calling Billing', { sessionId, msisdn, simulateFailure });
    const billingResponse = await Promise.race([
      fetch(`http://billing-service:3004/balance/${encodeURIComponent(msisdn)}${failureQs}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Billing timeout')), 5000))
    ]).catch(err => err);

    if (billingResponse instanceof Error) {
      console.log('[vas-platform] Billing failed', { sessionId, error: billingResponse.message });
      const message = 'Unable to check or charge your balance right now. Please try again later.';
      console.log('[vas-platform] final response', { sessionId, message, reason: 'billing_failure' });
      return res.json({ sessionId, continueSession: false, message });
    }

    // Handle 404 specifically before treating other 4xx/5xx errors
    if (billingResponse.status === 404) {
      const message = 'Balance information not found. Please try again later.';
      console.log('[vas-platform] final response', { sessionId, message, status: 404 });
      return res.json({ sessionId, continueSession: false, message });
    }

    if (!billingResponse.ok) {
      console.log('[vas-platform] Billing error', { sessionId, status: billingResponse.status });
      const message = 'Unable to check or charge your balance right now. Please try again later.';
      console.log('[vas-platform] final response', { sessionId, message, reason: 'billing_error' });
      return res.json({ sessionId, continueSession: false, message });
    }

    const billingData = await billingResponse.json();
    console.log('[vas-platform] Billing response', { sessionId, status: billingData.status, billingData });

    const balance = billingData.balance;

    if (text.trim() === '' || text.trim() === '0') {
      const message = `Welcome to VAS Platform\nYour balance is: ${balance} NIS\n1. Buy bundle\n2. Exit`;
      console.log('[vas-platform] final response', { sessionId, message });
      return res.json({ sessionId, continueSession: true, message });
    }

    if (text.trim() === '2') {
      const message = 'Thank you for using VAS Platform.';
      console.log('[vas-platform] final response', { sessionId, message });
      return res.json({ sessionId, continueSession: false, message });
    }

    if (text.trim() === '1') {
      if (balance < 5) {
        const message = 'Insufficient balance to buy bundle';
        console.log('[vas-platform] final response', { sessionId, message });
        return res.json({ sessionId, continueSession: false, message });
      }

      console.log('[vas-platform] charging account', { sessionId, msisdn, amount: 5, simulateFailure });
      const chargeResponse = await Promise.race([
        fetch('http://billing-service:3004/charge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msisdn, amount: 5, simulateFailure }),
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Charge timeout')), 5000))
      ]).catch(err => err);

      if (chargeResponse instanceof Error) {
        console.log('[vas-platform] Charge failed', { sessionId, error: chargeResponse.message });
        const message = 'Unable to check or charge your balance right now. Please try again later.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'charge_failure' });
        return res.json({ sessionId, continueSession: false, message });
      }

      if (!chargeResponse.ok || chargeResponse.status >= 400) {
        console.log('[vas-platform] Charge error', { sessionId, status: chargeResponse.status });
        const message = 'Unable to check or charge your balance right now. Please try again later.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'charge_error' });
        return res.json({ sessionId, continueSession: false, message });
      }

      const chargeData = await chargeResponse.json();
      console.log('[vas-platform] charging response', { sessionId, status: chargeResponse.status, chargeData });

      if (chargeData.status !== 'CHARGED') {
        const message = 'Unable to check or charge your balance right now. Please try again later.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'charge_not_successful' });
        return res.json({ sessionId, continueSession: false, message });
      }

      // Charge succeeded; proceed to aggregator and SMS
      // If aggregator fails, we log this as a potential refund scenario

      console.log('[vas-platform] calling Aggregator', { sessionId, msisdn, serviceCode: 'BUNDLE_1GB', simulateFailure });
      const aggregatorResponse = await Promise.race([
        fetch('http://aggregator-service:3006/external-service', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msisdn, serviceCode: 'BUNDLE_1GB', simulateFailure }),
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Aggregator timeout')), 5000))
      ]).catch(err => err);

      if (aggregatorResponse instanceof Error || !aggregatorResponse.ok || aggregatorResponse.status >= 400) {
        console.error('[vas-platform] Aggregator failed after charge', { sessionId, error: aggregatorResponse instanceof Error ? aggregatorResponse.message : aggregatorResponse.status, note: 'COMPENSATION_NEEDED' });
        const message = 'Bundle activation failed after charging. Your transaction has been flagged for automatic refund/reversal.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'aggregator_failure_post_charge' });
        return res.json({ sessionId, continueSession: false, message });
      }

      const aggregatorData = await aggregatorResponse.json();
      console.log('[vas-platform] Aggregator response', { sessionId, status: aggregatorResponse.status, aggregatorData });

      if (aggregatorData.providerStatus !== 'SUCCESS') {
        console.error('[vas-platform] Aggregator returned unsuccessful status after charge', { sessionId, providerStatus: aggregatorData.providerStatus, aggregatorData, note: 'COMPENSATION_NEEDED' });
        const message = 'Bundle activation failed after charging. Your transaction has been flagged for automatic refund/reversal.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'aggregator_unsuccessful_post_charge' });
        return res.json({ sessionId, continueSession: false, message });
      }

      console.log('[vas-platform] calling SMSC', { sessionId, msisdn, message: 'Your 1GB bundle has been activated.', simulateFailure });
      const smsResponse = await Promise.race([
        fetch('http://smsc-service:3005/send-sms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msisdn, message: 'Your 1GB bundle has been activated.', simulateFailure }),
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SMSC timeout')), 5000))
      ]).catch(err => err);

      if (smsResponse instanceof Error || !smsResponse.ok || smsResponse.status >= 400) {
        console.log('[vas-platform] SMSC failed but purchase succeeded', { sessionId, error: smsResponse instanceof Error ? smsResponse.message : smsResponse.status });
        const message = 'Bundle purchase successful, but SMS confirmation could not be sent.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'smsc_failure_post_purchase' });
        return res.json({ sessionId, continueSession: false, message });
      }

      const smsData = await smsResponse.json();
      console.log('[vas-platform] SMSC response', { sessionId, status: smsResponse.status, smsData });

      // Check SMSC delivery status
      if (smsData.deliveryStatus !== 'DELIVERED') {
        console.log('[vas-platform] SMS not delivered', { sessionId, smsData });
        const message = 'Bundle purchase successful, but SMS confirmation could not be sent.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'sms_not_delivered' });
        return res.json({ sessionId, continueSession: false, message });
      }

      const message = 'Bundle purchase successful. Confirmation SMS sent.';
      console.log('[vas-platform] final response', { sessionId, message });
      return res.json({ sessionId, continueSession: false, message });
    }

    const message = `Welcome to VAS Platform\nYour balance is: ${balance} NIS\n1. Buy bundle\n2. Exit`;
    console.log('[vas-platform] final response', { sessionId, message });
    return res.json({ sessionId, continueSession: true, message });
  } catch (error) {
    console.error('[vas-platform] error processing ussd', { sessionId, error: error.message });
    const message = 'Service temporarily unavailable. Please try again later.';
    console.log('[vas-platform] final response', { sessionId, message, reason: 'uncaught_error' });
    return res.json({ sessionId, continueSession: false, message });
  }
});

app.listen(PORT, () => {
  console.log(`vas-platform listening on port ${PORT}`);
});
