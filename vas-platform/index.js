const express = require('express');
const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());

const startedAt = Date.now();

app.use((req, res, next) => {
  console.log(`[vas-platform] ${req.method} ${req.url}`);
  next();
});

app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    service: 'vas-platform',
    components: {
      vasService: 'UP',
      ussdPurchaseFlow: 'UP',
      billingMock: 'UP',
      crmMock: 'UP',
      aggregatorMock: 'UP',
      smscMock: 'UP',
    },
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
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
