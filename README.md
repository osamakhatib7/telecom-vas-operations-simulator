# Telecom Core/VAS Operations Simulator

## Project Overview

Telecom Core/VAS Operations Simulator is a beginner-friendly Node.js and Docker Compose lab for practicing telecom VAS and core operations troubleshooting.

The lab simulates a production-style operational flow:

- mock telecom signaling events
- USSD gateway routing and transaction logging
- VAS application orchestration
- CRM subscriber profile checks
- OCS balance, charging, refunds, and internet bundle entitlements
- third-party news/content subscriptions through an Aggregator
- SMS notification attempts
- MySQL-backed operational state

This project does not implement real SS7, SIP, SMPP, MSC, HSS, UDM, or live operator integrations. It uses HTTP services to simulate the operational path so that logs, health checks, transactions, state, and failure handling can be practiced safely.

## Architecture

```text
Test Client
  -> Core Network Mock (3007)
    -> USSD Gateway / Service Broker (3001)
      -> VAS Platform (3002)
        -> CRM Service + MySQL (3003)
        -> OCS Service + MySQL (3004)
        -> Aggregator + MySQL for news/content only (3006)
        -> SMSC Service + MySQL (3005)
          -> MySQL Database
```

Important ownership notes:

- Internet bundle charging and activation are handled by OCS.
- Aggregator is not used for internet bundle activation.
- Aggregator is used only for external third-party news/content subscriptions.
- CRM, OCS, Aggregator, and SMSC are MySQL-backed.
- USSD Gateway routing rules and signaling transaction logs are still in memory.

## Service Responsibilities

| Service | Port | Responsibility | State |
|---|---:|---|---|
| Core Network Mock | 3007 | Test entry point for mock telecom signaling events | Stateless |
| USSD Gateway / Service Broker | 3001 | Validates mock signaling events, applies routing rules, creates signaling transaction logs, exposes KPI, converts routed USSD events to VAS `/ussd` requests | In memory |
| VAS Platform | 3002 | Owns USSD menu and business orchestration across CRM, OCS, Aggregator, and SMSC | Stateless orchestration |
| CRM Service | 3003 | Subscriber profile, status, segment, eligibility, allowed services | MySQL |
| OCS Service | 3004 | Balance, charge, refund/reversal, OCS transactions, bundle offers, active internet bundles | MySQL |
| Aggregator Service | 3006 | External third-party news/content subscriptions | MySQL |
| SMSC Service | 3005 | Sends mock SMS notifications and stores SMS send attempts | MySQL |
| MySQL Database | internal | Stores lab data for CRM, OCS, Aggregator, and SMSC | Docker volume |

## USSD Menu

The VAS Platform exposes this customer menu through the normal signaling path:

```text
Welcome to VAS Platform
1. Buy internet bundle
2. Check balance
3. Subscribe to news alerts
4. Check active internet bundles
5. Exit
```

### Option 1: Buy Internet Bundle

Flow:

```text
VAS -> CRM: verify subscriber
VAS -> OCS: check balance
VAS -> OCS: charge
VAS -> OCS: activate internet bundle entitlement
VAS -> SMSC: send confirmation
```

No Aggregator call is made for internet bundle purchase.

If the charge succeeds but bundle activation fails, VAS calls OCS refund/reversal and returns a clear customer-facing failure message.

### Option 2: Check Balance

Flow:

```text
VAS -> CRM: verify subscriber
VAS -> OCS: get balance
VAS -> customer: balance response
```

### Option 3: Subscribe To News Alerts

Stage 3 currently supports `GENERAL_NEWS`.

Flow:

```text
VAS -> CRM: verify subscriber
VAS -> Aggregator: check existing news subscription
VAS -> OCS: charge
VAS -> Aggregator: create third-party news/content subscription
VAS -> SMSC: send confirmation
```

If the subscriber already has an active `GENERAL_NEWS` subscription, VAS does not charge again.

If OCS charge succeeds but Aggregator subscription fails, VAS calls OCS refund/reversal.

### Option 4: Check Active Internet Bundles

Flow:

```text
VAS -> CRM: verify subscriber
VAS -> OCS: get active bundles
VAS -> customer: active bundle details
```

### Option 5: Exit

VAS ends the session with a simple exit message.

## Endpoint Reference

### Core Network Mock

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Service health |
| POST | `/simulate/signaling-event` | Public test entry point for mock signaling events |

### USSD Gateway

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Gateway health and component status |
| GET | `/kpi/today` | In-memory KPI for current-day signaling traffic |
| GET | `/transactions` | In-memory signaling transaction log with optional filters |
| POST | `/simulate/signaling-event` | Gateway-side mock signaling event endpoint |
| POST | `/simulate-ussd` | Direct VAS-style USSD simulation helper |

### VAS Platform

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | VAS and dependency health |
| POST | `/ussd` | Normal VAS USSD application endpoint |

### CRM Service

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | CRM and database health |
| GET | `/subscribers/:msisdn` | Subscriber profile/status lookup from MySQL |

### OCS Service

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | OCS and database health |
| GET | `/balance/:msisdn` | Subscriber balance |
| POST | `/charge` | Charge subscriber balance |
| POST | `/refund` | Refund/reversal after failed downstream step |
| POST | `/bundles/activate` | Activate internet bundle entitlement |
| GET | `/bundles/:msisdn/active` | Active internet bundles |
| GET | `/transactions/:msisdn` | OCS transaction history |
| POST | `/reset-balances` | Reset lab OCS state for repeatable tests |

### Aggregator Service

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Aggregator and database health |
| POST | `/subscriptions` | Create external news/content subscription |
| GET | `/subscriptions/:msisdn` | Read external news/content subscriptions |

### SMSC Service

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | SMSC and database health |
| POST | `/send-sms` | Send mock SMS notification |
| GET | `/attempts/:msisdn` | Read SMS attempts for troubleshooting |

## MySQL Schema Overview

| Table | Owner | Purpose |
|---|---|---|
| `subscribers` | CRM | Subscriber status, type, segment, eligibility |
| `subscriber_allowed_services` | CRM | Relational allowed-service mapping per subscriber |
| `balances` | OCS | Subscriber balance |
| `ocs_transactions` | OCS | Charge, refund, and bundle activation history |
| `refunds` | OCS | Refund/reversal records and idempotency checks |
| `bundle_offers` | OCS | Internet bundle offer definitions |
| `active_bundles` | OCS | Active internet bundle entitlements |
| `content_offers` | Aggregator | Third-party content/news offer definitions |
| `content_subscriptions` | Aggregator | Active news/content subscriptions |
| `sms_attempts` | SMSC | SMS delivery attempts and failures |

The `mysql-db` container stores data in the `mysql-data` Docker volume.

## How To Run

From the repository root:

```powershell
docker compose up --build -d
```

Check containers:

```powershell
docker compose ps
```

Stop the stack:

```powershell
docker compose down
```

Main exposed ports:

| Service | Port |
|---|---:|
| Core Network Mock | 3007 |
| USSD Gateway | 3001 |
| VAS Platform | 3002 |
| CRM Service | 3003 |
| OCS Service | 3004 |
| SMSC Service | 3005 |
| Aggregator Service | 3006 |

MySQL is used inside Docker Compose and is not bound to the host port by default.

## Curl Examples

These examples use the normal signaling path through `core-network-mock`.

### Open Menu

```bash
curl -X POST http://127.0.0.1:3007/simulate/signaling-event \
  -H "Content-Type: application/json" \
  -d '{
    "protocol": "SS7-MAP-MOCK",
    "eventType": "USSD_REQUEST",
    "msisdn": "970599123456",
    "serviceType": "USSD",
    "serviceCode": "*123#",
    "originPointCode": "1234",
    "destinationPointCode": "5678",
    "globalTitle": "970599123456",
    "visitedNetwork": "LOCAL",
    "text": "0"
  }'
```

### Buy Internet Bundle

```bash
curl -X POST http://127.0.0.1:3007/simulate/signaling-event \
  -H "Content-Type: application/json" \
  -d '{
    "protocol": "SS7-MAP-MOCK",
    "eventType": "USSD_REQUEST",
    "msisdn": "970599123456",
    "serviceType": "USSD",
    "serviceCode": "*123#",
    "originPointCode": "1234",
    "destinationPointCode": "5678",
    "globalTitle": "970599123456",
    "visitedNetwork": "LOCAL",
    "text": "1"
  }'
```

### Check Balance

```bash
curl -X POST http://127.0.0.1:3007/simulate/signaling-event \
  -H "Content-Type: application/json" \
  -d '{
    "protocol": "SS7-MAP-MOCK",
    "eventType": "USSD_REQUEST",
    "msisdn": "970599123456",
    "serviceType": "USSD",
    "serviceCode": "*123#",
    "originPointCode": "1234",
    "destinationPointCode": "5678",
    "globalTitle": "970599123456",
    "visitedNetwork": "LOCAL",
    "text": "2"
  }'
```

Direct OCS balance check:

```bash
curl http://127.0.0.1:3004/balance/970599123456
```

### Subscribe To News Alerts

```bash
curl -X POST http://127.0.0.1:3007/simulate/signaling-event \
  -H "Content-Type: application/json" \
  -d '{
    "protocol": "SS7-MAP-MOCK",
    "eventType": "USSD_REQUEST",
    "msisdn": "0599123456",
    "serviceType": "USSD",
    "serviceCode": "*123#",
    "originPointCode": "1234",
    "destinationPointCode": "5678",
    "globalTitle": "0599123456",
    "visitedNetwork": "LOCAL",
    "text": "3"
  }'
```

### Check Active Bundles

```bash
curl -X POST http://127.0.0.1:3007/simulate/signaling-event \
  -H "Content-Type: application/json" \
  -d '{
    "protocol": "SS7-MAP-MOCK",
    "eventType": "USSD_REQUEST",
    "msisdn": "970599123456",
    "serviceType": "USSD",
    "serviceCode": "*123#",
    "originPointCode": "1234",
    "destinationPointCode": "5678",
    "globalTitle": "970599123456",
    "visitedNetwork": "LOCAL",
    "text": "4"
  }'
```

### OCS Transactions

```bash
curl http://127.0.0.1:3004/transactions/970599123456
```

### OCS Active Bundles

```bash
curl http://127.0.0.1:3004/bundles/970599123456/active
```

### Aggregator Subscriptions

```bash
curl "http://127.0.0.1:3006/subscriptions/0599123456?category=GENERAL_NEWS"
```

### SMSC Attempts

```bash
curl http://127.0.0.1:3005/attempts/970599123456
```

### Gateway KPI And Signaling Transactions

```bash
curl http://127.0.0.1:3001/kpi/today
curl "http://127.0.0.1:3001/transactions?msisdn=970599123456"
```

## Troubleshooting Practice

The old Aggregator-based bundle activation scenarios should be updated or removed. Internet bundle issues now belong to the OCS path unless the customer problem is specifically about third-party news/content.

Useful current troubleshooting scenarios:

| Scenario | Where To Investigate |
|---|---|
| Customer charged but internet bundle not active | VAS logs, OCS `ocs_transactions`, OCS `active_bundles`, OCS `refunds` |
| Duplicate internet bundle purchase rejected without new charge | VAS logs, OCS active bundle endpoint, OCS transactions |
| Suspended customer cannot use USSD service | CRM subscriber profile in MySQL, VAS response |
| Customer charged for news but subscription failed | VAS logs, OCS charge/refund records, Aggregator subscription records |
| Customer already subscribed to news and should not be charged again | Aggregator `content_subscriptions`, OCS transactions |
| SMS confirmation missing after successful purchase | SMSC `sms_attempts`, VAS logs, business transaction result |
| Gateway shows routing success but customer journey failed | Gateway `/transactions`, VAS logs, downstream service state |
| KPI failure increase for `*123#` traffic | Gateway `/kpi/today`, Gateway `/transactions`, downstream health |

Recommended troubleshooting order:

1. Check gateway `/transactions` to confirm routing and transaction ID.
2. Check VAS logs to identify the business flow branch.
3. Check CRM profile/status if subscriber validation failed.
4. Check OCS transactions, balance, active bundles, and refunds for bundle or charging issues.
5. Check Aggregator subscriptions for news/content issues.
6. Check SMSC attempts for missing or failed notifications.

## Known Limitations

- No real SS7, SIP, SMPP, MSC, HSS, UDM, OCS, or SMSC protocol implementation.
- USSD sessions are simplified; there is no full session state machine.
- USSD Gateway routing rules and signaling transaction logs are in memory.
- Gateway KPI is calculated from in-memory gateway logs and resets when the gateway restarts.
- CRM, OCS, Aggregator, and SMSC use a shared MySQL lab database, not separate production databases.
- Aggregator simulates an external provider but runs inside the same Docker Compose project.
- MySQL schema is intentionally simple for learning and interview discussion.
- Some failure simulation flags remain for controlled lab testing.

## CV Description

Telecom Core/VAS Operations Simulator

Extended a VAS simulation project into a multi-service Core/VAS operations simulator with mock signaling, USSD service broker routing, VAS orchestration, MySQL-backed CRM/OCS/Aggregator/SMSC state, OCS-based charging and internet bundle entitlements, third-party news/content subscriptions, SMS attempt tracking, health checks, KPI reporting, and troubleshooting scenarios.
