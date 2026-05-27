# Telecom Core/VAS Operations Simulator

## Overview

This project is a learning and portfolio lab for telecom Core/VAS operations. It simulates a VAS troubleshooting environment with small HTTP microservices, Docker Compose, MySQL-backed operational state, transaction logs, health checks, and correlation IDs.

It does not implement real SS7, SMPP, SIP, MSC, HLR/HSS, UDM, or production OCS integrations. The telecom signaling and downstream systems are mocked so the operational flow can be practiced safely.

## Architecture

```text
Subscriber/Test Client
  -> Core Network Mock
  -> USSD Gateway
  -> VAS Platform
  -> CRM / OCS / Aggregator / SMSC
  -> VAS Platform
  -> USSD Gateway
  -> Subscriber/Test Client
```

Active services:

| Service | Port | Role |
|---|---:|---|
| Core Network Mock | 3007 | Test entry point that generates mock telecom signaling events |
| USSD Gateway | 3001 | Validates and routes mock signaling, creates Gateway transactions, exposes KPI, converts events to VAS `/ussd` requests |
| VAS Platform | 3002 | Owns the USSD menu and orchestrates CRM, OCS, Aggregator, and SMSC flows |
| CRM Service | 3003 | Stores subscriber profile, status, segment, campaign eligibility, and `allowedServices` |
| OCS Service | 3004 | Handles balance, charging, refunds, internet bundle activation, and active bundle state |
| SMSC Service | 3005 | Records mock SMS delivery attempts |
| Aggregator Service | 3006 | Handles third-party/news content subscriptions |
| MySQL Database | internal 3306 | Stores CRM, OCS, Aggregator, SMSC, Gateway, and VAS operational data |

## USSD Menu

```text
Welcome to VAS Platform
1. Buy internet bundle
2. Check balance
3. Subscribe to news alerts
4. Check active internet bundles
5. Exit
```

Option ownership:

- Option 1 uses CRM and OCS. Internet bundle activation is handled by OCS, not Aggregator.
- Option 2 uses CRM and OCS.
- Option 3 uses CRM, OCS, Aggregator, and SMSC. Aggregator represents a third-party news/content provider.
- Option 4 uses CRM and OCS.
- Option 5 ends the session.

## Main Features

- End-to-end `X-Correlation-ID` propagation across active services.
- USSD Gateway transactions persisted in MySQL.
- USSD Gateway KPI derived from MySQL transaction data.
- VAS Platform transactions persisted in MySQL.
- CRM subscriber profile and `allowedServices` stored in MySQL.
- VAS enforcement of CRM `allowedServices`:
  - option `1` requires `INTERNET_BUNDLE`
  - option `3` requires `GENERAL_NEWS`
- OCS balance, charge, refund/reversal, internet bundle activation, and active bundle tracking.
- Aggregator-backed third-party/news subscriptions.
- SMSC delivery attempt tracking.
- Docker Compose multi-service setup.

## Run The Lab

Docker is required.

Start or rebuild:

```bash
docker compose up --build -d
```

Check containers:

```bash
docker compose ps
```

Stop containers:

```bash
docker compose down
```

Fully reset the MySQL data volume:

```bash
docker compose down -v
```

Warning: `docker compose down -v` deletes persisted database data.

## Ports

| Service | URL |
|---|---|
| Core Network Mock | `http://localhost:3007` |
| USSD Gateway | `http://localhost:3001` |
| VAS Platform | `http://localhost:3002` |
| CRM Service | `http://localhost:3003` |
| OCS Service | `http://localhost:3004` |
| SMSC Service | `http://localhost:3005` |
| Aggregator Service | `http://localhost:3006` |
| MySQL | internal Docker port `3306`; not host-exposed by default |

## Health Checks

```bash
curl http://localhost:3007/health
curl http://localhost:3001/health
curl http://localhost:3002/health
curl http://localhost:3003/health
curl http://localhost:3004/health
curl http://localhost:3005/health
curl http://localhost:3006/health
```

## Example USSD Request

Normal entry point:

```bash
curl -X POST http://localhost:3007/simulate/signaling-event \
  -H "Content-Type: application/json" \
  -H "X-Correlation-ID: demo-menu-001" \
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

Change `text` to choose a menu option:

| Text | Action |
|---|---|
| `0` | Open menu |
| `1` | Buy internet bundle |
| `2` | Check balance |
| `3` | Subscribe to news alerts |
| `4` | Check active internet bundles |
| `5` | Exit |

## Endpoint Reference

### Core Network Mock

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Service health |
| `POST` | `/simulate/signaling-event` | Main mock signaling entry point |

### USSD Gateway

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Gateway and database health |
| `GET` | `/kpi/today` | Gateway KPI derived from persisted transactions |
| `GET` | `/transactions` | Gateway transactions with filters such as `msisdn`, `serviceType`, `serviceCode`, `status`, `failureReason`, `correlationId` |
| `POST` | `/simulate/signaling-event` | Gateway-side mock signaling endpoint |
| `POST` | `/simulate-ussd` | Direct helper that forwards a VAS-style request to `/ussd` |

### VAS Platform

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | VAS and dependency health |
| `GET` | `/transactions` | VAS transactions with filters such as `msisdn`, `correlationId`, `sessionId`, `status`, `flowName` |
| `GET` | `/transactions/:correlationId` | VAS transaction lookup by correlation ID |
| `POST` | `/ussd` | VAS USSD application endpoint |

### CRM Service

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | CRM and database health |
| `GET` | `/subscribers/:msisdn` | Subscriber profile/status/allowed-services lookup |

### OCS Service

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | OCS and database health |
| `GET` | `/balance/:msisdn` | Subscriber balance |
| `POST` | `/charge` | Charge subscriber balance |
| `POST` | `/refund` | Refund/reversal |
| `POST` | `/bundles/activate` | Activate internet bundle entitlement |
| `GET` | `/bundles/:msisdn/active` | Active internet bundles |
| `GET` | `/transactions/:msisdn` | OCS transaction history |
| `POST` | `/reset-balances` | Lab helper to reset OCS state |

### Aggregator Service

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Aggregator and database health |
| `GET` | `/subscriptions/:msisdn` | Read third-party/news subscriptions |
| `POST` | `/subscriptions` | Create third-party/news subscription |

### SMSC Service

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | SMSC and database health |
| `GET` | `/attempts/:msisdn` | SMS attempts by MSISDN |
| `POST` | `/send-sms` | Send mock SMS notification |

## Useful Troubleshooting Endpoints

```bash
curl http://localhost:3001/transactions
curl "http://localhost:3001/transactions?correlationId=demo-menu-001"
curl http://localhost:3001/kpi/today

curl http://localhost:3002/transactions
curl "http://localhost:3002/transactions?correlationId=demo-menu-001"

curl http://localhost:3004/transactions/970599123456
curl http://localhost:3004/bundles/970599123456/active

curl "http://localhost:3006/subscriptions/970599123456?category=GENERAL_NEWS"
curl http://localhost:3005/attempts/970599123456
```

## Example Troubleshooting Flow

1. Send a request with a known `X-Correlation-ID`.
2. Check Gateway routing and status:

   ```bash
   curl "http://localhost:3001/transactions?correlationId=demo-menu-001"
   ```

3. Check VAS flow state and downstream flags:

   ```bash
   curl "http://localhost:3002/transactions?correlationId=demo-menu-001"
   ```

4. Depending on the flow, inspect the relevant downstream state:
   - CRM subscriber profile for status or eligibility issues.
   - OCS transactions and active bundles for balance, charge, refund, or bundle issues.
   - Aggregator subscriptions for news/content issues.
   - SMSC attempts for notification delivery issues.

Use logs with the same correlation ID:

```bash
docker compose logs vas-platform | grep "demo-menu-001"
docker compose logs ocs-service | grep "demo-menu-001"
```

## CRM allowedServices

CRM returns an `allowedServices` list for each subscriber.

VAS enforces the list for selected customer journeys:

| USSD option | Required allowed service |
|---|---|
| `1` Buy internet bundle | `INTERNET_BUNDLE` |
| `3` Subscribe to news alerts | `GENERAL_NEWS` |

If the subscriber is not eligible, VAS stops before OCS, Aggregator, and SMSC calls. The VAS transaction is recorded as:

```text
status: FAILED
failureReason: NOT_ELIGIBLE
```

## MySQL Notes

- Schema and seed data are defined in `database/init.sql`.
- MySQL data is stored in the `mysql-data` Docker volume.
- `database/init.sql` runs only when the MySQL volume is first created.
- Several services also run `CREATE TABLE IF NOT EXISTS` on startup so existing volumes can pick up required tables.
- Use `docker compose down -v` only when you intentionally want to delete database state.

Key tables:

| Table | Main owner |
|---|---|
| `subscribers` | CRM |
| `subscriber_allowed_services` | CRM |
| `balances` | OCS |
| `ocs_transactions` | OCS |
| `refunds` | OCS |
| `bundle_offers` | OCS |
| `active_bundles` | OCS |
| `content_offers` | Aggregator |
| `content_subscriptions` | Aggregator |
| `sms_attempts` | SMSC |
| `gateway_transactions` | USSD Gateway |
| `vas_transactions` | VAS Platform |

## Development Notes

- This lab is for learning operations, troubleshooting, and service orchestration.
- Do not treat it as production telecom infrastructure.
- The mock core network does not implement real SS7/SMPP/SIP.
- Gateway routing rules are still in application code.
- Failure simulation flags exist for controlled practice scenarios.
- Keep correlation IDs in every request when troubleshooting.
