const express = require('express');
const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());

const startedAt = Date.now();
const INTERNET_BUNDLE_OFFER_CODE = 'BUNDLE_1GB';
const INTERNET_BUNDLE_NAME = '1GB Internet Bundle';
const INTERNET_BUNDLE_PRICE = 5;

async function fetchWithTimeout(url, options = {}, timeoutMessage = 'Request timeout') {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutMessage)), 5000)),
  ]);
}

async function checkDependencyHealth(url) {
  try {
    const response = await Promise.race([
      fetch(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Health check timeout')), 2000)),
    ]);

    return response.ok ? 'UP' : 'DOWN';
  } catch (error) {
    return 'DOWN';
  }
}

function buildMainMenu(balance) {
  return [
    'Welcome to VAS Platform',
    `Your balance is: ${balance} NIS`,
    '1. Buy internet bundle',
    '2. Check balance',
    '3. Subscribe to news alerts',
    '4. Check active internet bundles',
    '5. Exit',
  ].join('\n');
}

function formatDataAllowance(megabytes) {
  if (megabytes >= 1024 && megabytes % 1024 === 0) {
    return `${megabytes / 1024}GB`;
  }
  return `${megabytes}MB`;
}

function formatBundleExpiry(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toISOString().slice(0, 10);
}

function formatActiveBundles(bundles) {
  if (!bundles.length) {
    return 'You have no active internet bundles.';
  }

  const lines = bundles.map(bundle => {
    const allowance = formatDataAllowance(Number(bundle.remainingDataMb));
    return `${bundle.bundleName}: ${allowance} remaining, valid until ${formatBundleExpiry(bundle.validUntil)}`;
  });

  return ['Active internet bundles:', ...lines].join('\n');
}

app.use((req, res, next) => {
  console.log(`[vas-platform] ${req.method} ${req.url}`);
  next();
});

app.get('/health', async (req, res) => {
  const [crmService, ocsService, aggregatorService, smscService] = await Promise.all([
    checkDependencyHealth('http://crm-service:3003/health'),
    checkDependencyHealth('http://ocs-service:3004/health'),
    checkDependencyHealth('http://aggregator-service:3006/health'),
    checkDependencyHealth('http://smsc-service:3005/health'),
  ]);

  const components = {
    vasService: 'UP',
    crmService,
    ocsService,
    aggregatorService,
    smscService,
  };

  const allDependenciesUp = Object.values(components).every(status => status === 'UP');

  res.json({
    status: allDependenciesUp ? 'UP' : 'DEGRADED',
    service: 'vas-platform',
    components,
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

  const normalizedText = text.trim();
  const buildFailureQs = (failure) => failure ? `?simulateFailure=${encodeURIComponent(failure)}` : '';
  const crmFailure = ['SUBSCRIBER_NOT_ACTIVE', 'BILLING_FAILED'].includes(simulateFailure) ? null : simulateFailure;
  const ocsFailure = simulateFailure === 'BILLING_FAILED' ? 'billing-500' : simulateFailure;
  const activationFailure = simulateFailure === 'BUNDLE_ACTIVATION_FAILED' ? 'ocs-activation-500' : null;

  async function fetchActiveBundles() {
    console.log('[vas-platform] calling OCS active bundles', { sessionId, msisdn });
    const activeBundlesResponse = await fetchWithTimeout(
      `http://ocs-service:3004/bundles/${encodeURIComponent(msisdn)}/active`,
      {},
      'OCS active bundles timeout'
    ).catch(err => err);

    if (activeBundlesResponse instanceof Error) {
      console.log('[vas-platform] OCS active bundles failed', { sessionId, error: activeBundlesResponse.message });
      return { error: activeBundlesResponse };
    }

    if (!activeBundlesResponse.ok) {
      console.log('[vas-platform] OCS active bundles error', { sessionId, status: activeBundlesResponse.status });
      return { error: new Error('OCS active bundles error') };
    }

    const activeBundlesData = await activeBundlesResponse.json();
    console.log('[vas-platform] OCS active bundles response', {
      sessionId,
      status: activeBundlesResponse.status,
      count: activeBundlesData.count,
    });
    return { data: activeBundlesData };
  }

  async function refundCharge(chargeData, reason) {
    console.log('[vas-platform] calling OCS refund', {
      sessionId,
      msisdn,
      amount: INTERNET_BUNDLE_PRICE,
      originalReferenceId: chargeData.referenceId,
      reason,
    });

    const refundResponse = await fetchWithTimeout(
      'http://ocs-service:3004/refund',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msisdn,
          amount: INTERNET_BUNDLE_PRICE,
          originalReferenceId: chargeData.referenceId,
          reason,
        }),
      },
      'OCS refund timeout'
    ).catch(err => err);

    if (refundResponse instanceof Error) {
      console.log('[vas-platform] OCS refund failed', { sessionId, error: refundResponse.message });
      return { status: 'REFUND_FAILED' };
    }

    if (!refundResponse.ok) {
      console.log('[vas-platform] OCS refund error', { sessionId, status: refundResponse.status });
      return { status: 'REFUND_FAILED' };
    }

    const refundData = await refundResponse.json();
    console.log('[vas-platform] OCS refund response', { sessionId, status: refundResponse.status, refundStatus: refundData.status });
    return refundData;
  }

  try {
    console.log('[vas-platform] calling CRM', { sessionId, msisdn, simulateFailure });
    const crmResponse = await fetchWithTimeout(
      `http://crm-service:3003/subscribers/${encodeURIComponent(msisdn)}${buildFailureQs(crmFailure)}`,
      {},
      'CRM timeout'
    ).catch(err => err);

    if (crmResponse instanceof Error) {
      console.log('[vas-platform] CRM failed', { sessionId, error: crmResponse.message });
      const message = 'Service temporarily unavailable. Please try again later.';
      console.log('[vas-platform] final response', { sessionId, message, reason: 'crm_failure' });
      return res.json({ sessionId, continueSession: false, message });
    }

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

    if (simulateFailure === 'SUBSCRIBER_NOT_ACTIVE') {
      const message = 'Your subscription is suspended. Please contact support.';
      console.log('[vas-platform] final response', { sessionId, message, reason: 'subscriber_not_active_simulation' });
      return res.json({ sessionId, continueSession: false, message, failureReason: 'SUBSCRIBER_NOT_ACTIVE' });
    }

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

    console.log('[vas-platform] calling OCS balance', { sessionId, msisdn, simulateFailure });
    const ocsResponse = await fetchWithTimeout(
      `http://ocs-service:3004/balance/${encodeURIComponent(msisdn)}${buildFailureQs(ocsFailure)}`,
      {},
      'OCS timeout'
    ).catch(err => err);

    if (ocsResponse instanceof Error) {
      console.log('[vas-platform] OCS failed', { sessionId, error: ocsResponse.message });
      const message = 'Unable to check or charge your balance right now. Please try again later.';
      console.log('[vas-platform] final response', { sessionId, message, reason: 'ocs_failure' });
      return res.json({ sessionId, continueSession: false, message, failureReason: simulateFailure === 'BILLING_FAILED' ? 'BILLING_FAILED' : undefined });
    }

    if (ocsResponse.status === 404) {
      const message = 'Balance information not found. Please try again later.';
      console.log('[vas-platform] final response', { sessionId, message, status: 404 });
      return res.json({ sessionId, continueSession: false, message });
    }

    if (!ocsResponse.ok) {
      console.log('[vas-platform] OCS error', { sessionId, status: ocsResponse.status });
      const message = 'Unable to check or charge your balance right now. Please try again later.';
      console.log('[vas-platform] final response', { sessionId, message, reason: 'ocs_error' });
      return res.json({ sessionId, continueSession: false, message, failureReason: simulateFailure === 'BILLING_FAILED' ? 'BILLING_FAILED' : undefined });
    }

    const ocsData = await ocsResponse.json();
    console.log('[vas-platform] OCS balance response', { sessionId, status: ocsResponse.status, ocsData });

    const balance = ocsData.balance;

    if (normalizedText === '' || normalizedText === '0') {
      const message = buildMainMenu(balance);
      console.log('[vas-platform] final response', { sessionId, message });
      return res.json({ sessionId, continueSession: true, message });
    }

    if (normalizedText === '2') {
      const message = `Your balance is: ${balance} NIS`;
      console.log('[vas-platform] final response', { sessionId, message });
      return res.json({ sessionId, continueSession: false, message });
    }

    if (normalizedText === '3') {
      const message = 'News alerts are not available yet.';
      console.log('[vas-platform] final response', { sessionId, message });
      return res.json({ sessionId, continueSession: false, message });
    }

    if (normalizedText === '4') {
      const activeBundlesResult = await fetchActiveBundles();
      if (activeBundlesResult.error) {
        const message = 'Unable to retrieve active internet bundles. Please try again later.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'active_bundles_error' });
        return res.json({ sessionId, continueSession: false, message });
      }

      const message = formatActiveBundles(activeBundlesResult.data.bundles || []);
      console.log('[vas-platform] final response', { sessionId, message });
      return res.json({ sessionId, continueSession: false, message });
    }

    if (normalizedText === '5') {
      const message = 'Thank you for using VAS Platform.';
      console.log('[vas-platform] final response', { sessionId, message });
      return res.json({ sessionId, continueSession: false, message });
    }

    if (normalizedText === '1') {
      const activeBundlesResult = await fetchActiveBundles();
      if (activeBundlesResult.error) {
        const message = 'Unable to verify active internet bundles. Please try again later.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'active_bundles_precheck_error' });
        return res.json({ sessionId, continueSession: false, message });
      }

      const hasSameActiveBundle = (activeBundlesResult.data.bundles || [])
        .some(bundle => bundle.offerCode === INTERNET_BUNDLE_OFFER_CODE);

      if (hasSameActiveBundle) {
        const message = `You already have an active ${INTERNET_BUNDLE_NAME}.`;
        console.log('[vas-platform] final response', { sessionId, message, reason: 'bundle_already_active_precheck' });
        return res.json({ sessionId, continueSession: false, message });
      }

      if (balance < INTERNET_BUNDLE_PRICE) {
        const message = 'Insufficient balance to buy bundle';
        console.log('[vas-platform] final response', { sessionId, message });
        return res.json({ sessionId, continueSession: false, message });
      }

      console.log('[vas-platform] charging account through OCS', {
        sessionId,
        msisdn,
        amount: INTERNET_BUNDLE_PRICE,
        simulateFailure,
      });
      const chargeResponse = await fetchWithTimeout(
        'http://ocs-service:3004/charge',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msisdn, amount: INTERNET_BUNDLE_PRICE, simulateFailure: ocsFailure }),
        },
        'OCS charge timeout'
      ).catch(err => err);

      if (chargeResponse instanceof Error) {
        console.log('[vas-platform] Charge failed', { sessionId, error: chargeResponse.message });
        const message = 'Unable to check or charge your balance right now. Please try again later.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'charge_failure' });
        return res.json({ sessionId, continueSession: false, message, failureReason: simulateFailure === 'BILLING_FAILED' ? 'BILLING_FAILED' : undefined });
      }

      if (!chargeResponse.ok || chargeResponse.status >= 400) {
        console.log('[vas-platform] Charge error', { sessionId, status: chargeResponse.status });
        const message = 'Unable to check or charge your balance right now. Please try again later.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'charge_error' });
        return res.json({ sessionId, continueSession: false, message, failureReason: simulateFailure === 'BILLING_FAILED' ? 'BILLING_FAILED' : undefined });
      }

      const chargeData = await chargeResponse.json();
      console.log('[vas-platform] OCS charge response', { sessionId, status: chargeResponse.status, chargeData });

      if (chargeData.status !== 'CHARGED') {
        const message = 'Unable to check or charge your balance right now. Please try again later.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'charge_not_successful' });
        return res.json({ sessionId, continueSession: false, message });
      }

      console.log('[vas-platform] activating internet bundle through OCS', {
        sessionId,
        msisdn,
        offerCode: INTERNET_BUNDLE_OFFER_CODE,
        chargeReferenceId: chargeData.referenceId,
      });
      const activationResponse = await fetchWithTimeout(
        'http://ocs-service:3004/bundles/activate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            msisdn,
            offerCode: INTERNET_BUNDLE_OFFER_CODE,
            referenceId: chargeData.referenceId,
            simulateFailure: activationFailure,
          }),
        },
        'OCS bundle activation timeout'
      ).catch(err => err);

      if (activationResponse instanceof Error || !activationResponse.ok || activationResponse.status >= 400) {
        console.log('[vas-platform] OCS bundle activation failed after charge', {
          sessionId,
          error: activationResponse instanceof Error ? activationResponse.message : activationResponse.status,
        });
        const refundData = await refundCharge(chargeData, 'BUNDLE_ACTIVATION_FAILED_AFTER_CHARGE');
        const message = refundData.status === 'REFUNDED'
          ? 'Bundle purchase could not be completed. Charged amount has been reversed.'
          : 'Bundle purchase could not be completed. Your transaction has been flagged for reversal.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'bundle_activation_failed_post_charge' });
        return res.json({ sessionId, continueSession: false, message });
      }

      const activationData = await activationResponse.json();
      console.log('[vas-platform] OCS bundle activation response', {
        sessionId,
        status: activationResponse.status,
        activationStatus: activationData.status,
        bundle: activationData.bundle,
      });

      if (activationData.status !== 'ACTIVATED') {
        const refundData = await refundCharge(chargeData, 'BUNDLE_ACTIVATION_NOT_SUCCESSFUL_AFTER_CHARGE');
        const message = refundData.status === 'REFUNDED'
          ? 'Bundle purchase could not be completed. Charged amount has been reversed.'
          : 'Bundle purchase could not be completed. Your transaction has been flagged for reversal.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'bundle_activation_not_successful' });
        return res.json({ sessionId, continueSession: false, message });
      }

      console.log('[vas-platform] calling SMSC', { sessionId, msisdn, message: 'Your 1GB bundle has been activated.', simulateFailure });
      const smsResponse = await fetchWithTimeout(
        'http://smsc-service:3005/send-sms',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msisdn, message: 'Your 1GB bundle has been activated.', simulateFailure }),
        },
        'SMSC timeout'
      ).catch(err => err);

      if (smsResponse instanceof Error || !smsResponse.ok || smsResponse.status >= 400) {
        console.log('[vas-platform] SMSC failed but purchase succeeded', { sessionId, error: smsResponse instanceof Error ? smsResponse.message : smsResponse.status });
        const message = 'Bundle purchase successful, but SMS confirmation could not be sent.';
        console.log('[vas-platform] final response', { sessionId, message, reason: 'smsc_failure_post_purchase' });
        return res.json({ sessionId, continueSession: false, message });
      }

      const smsData = await smsResponse.json();
      console.log('[vas-platform] SMSC response', { sessionId, status: smsResponse.status, smsData });

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

    const message = buildMainMenu(balance);
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
