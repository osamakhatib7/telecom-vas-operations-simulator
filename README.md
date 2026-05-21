# Telecom Core/VAS Operations Simulator

## Project Overview

Telecom Core/VAS Operations Simulator is a beginner-friendly Node.js and Docker Compose lab for practicing telecom operations concepts around VAS routing, USSD flows, mock signaling events, transaction logging, KPI monitoring, health checks, and failure troubleshooting.

The project started as a Mini Telecom VAS Lab and was extended into a small Core/VAS operations simulator suitable for learning, demos, and interview discussion.

## Important Note

This project is a Core/VAS operations simulator, not a real telecom core implementation. It does not implement real SS7, SIP, SMPP, MSC, HSS, or UDM protocols. It uses mock signaling events to demonstrate routing decisions, USSD/VAS flow, transaction logging, KPI monitoring, health checks, and failure troubleshooting. HTTP endpoints are used only as a test interface to trigger simulated telecom events. The `core-network-mock` service is only a mock signaling source used for testing.

## Why This Project

Core and VAS operations engineers often need to understand how requests move between gateways, VAS platforms, billing systems, customer data systems, SMS platforms, roaming gateways, and interconnect platforms.

This project demonstrates those ideas without pretending to be a real telecom network. It focuses on operational thinking:

- How incoming events are validated.
- How a gateway or service broker selects a destination platform.
- How failures are classified.
- How transaction logs support troubleshooting.
- How KPIs show service health.
- How a USSD-driven VAS purchase can be traced across services.

## Architecture / Flow

```text
Test Client
  -> Core Network Mock (3007)
    -> USSD Gateway / Service Broker (3001)
      -> VAS Platform / Business Application (3002)
        -> CRM Service (3003)
        -> Billing Service (3004)
        -> Aggregator Service (3006)
        -> SMSC Service (3005)

Mock signaling events
  -> Core Network Mock POST /simulate/signaling-event
    -> USSD Gateway POST /simulate/signaling-event
      -> Routing rules
      -> Transaction log
      -> KPI calculation
      -> VAS Platform POST /ussd
      -> Mock destination platforms
```

The `core-network-mock` service is only a mock signaling source. It is not a real core network implementation. The USSD Gateway acts as the service broker and owns routing rules, routing decisions, signaling transaction logs, and signaling KPIs. When routing to `VAS_PLATFORM`, the gateway converts telecom-side event fields into the normal VAS `/ussd` request format. The VAS Platform remains the business application and only receives regular `/ussd` requests for the purchase flow through CRM, Billing, Aggregator, and SMSC.

## Features

- Core Network Mock service as the official test entry point for mock signaling events.
- USSD Gateway / Service Broker for routing mock signaling traffic.
- Existing USSD bundle purchase flow.
- Mock CRM subscriber lookup.
- Mock Billing balance lookup and charging.
- Mock Aggregator activation.
- Mock SMSC confirmation delivery.
- Mock signaling event endpoint for Core/VAS operations scenarios.
- In-memory routing rules in the USSD Gateway.
- In-memory transaction logs in the USSD Gateway.
- KPI endpoint for today's signaling traffic in the USSD Gateway.
- Health endpoint with component status.
- Failure simulation for routing, subscriber, billing, partner, and internal failures.

## Routing Rules

Routing rules are stored in memory inside `ussd-gateway`.

| Service Type | Service Code | Destination Platform |
|---|---|---|
| `USSD` | `*123#` | `VAS_PLATFORM` |
| `USSD` | `*456#` | `BUNDLE_SERVICE` |
| `ROAMING_USSD` | `*123#` | `ROAMING_GATEWAY_MOCK` |
| `SMS` | `DEFAULT` | `SMSC_MOCK` |
| `VOICE` | `INTERNATIONAL` | `INTERCONNECT_GATEWAY_MOCK` |

Each rule includes:

- `id`
- `serviceType`
- `serviceCode`
- `destinationPlatform`
- `isActive`
- `priority`

## Mock Signaling Event Endpoint

The Core Network Mock service exposes the official public test entry point:

```text
POST /simulate/signaling-event
```

Use it through port `3007`:

```text
POST http://127.0.0.1:3007/simulate/signaling-event
```

This endpoint accepts a mock telecom event and forwards it to the USSD Gateway. The gateway validates the event, applies routing rules, writes a transaction log, and decides the destination platform.

When the destination is `VAS_PLATFORM`, the gateway converts the event into the VAS application request and calls `POST /ussd` on `vas-platform`. Other mock destinations are simulated directly by the gateway.

Example event:

```json
{
  "protocol": "SS7-MAP-MOCK",
  "eventType": "USSD_REQUEST",
  "msisdn": "970599123456",
  "serviceType": "USSD",
  "serviceCode": "*123#",
  "originPointCode": "1234",
  "destinationPointCode": "5678",
  "globalTitle": "970599123456",
  "visitedNetwork": "LOCAL",
  "text": "0",
  "simulateFailure": null
}
```

Successful response:

```json
{
  "transactionId": "TX-10001",
  "decision": "ROUTE_TO_VAS_PLATFORM",
  "destinationPlatform": "VAS_PLATFORM",
  "status": "SUCCESS",
  "sessionId": "TX-10001",
  "continueSession": true,
  "message": "Welcome to VAS Platform\nYour balance is: 10.5 NIS\n1. Buy bundle\n2. Exit"
}
```

## Transaction Logs

The USSD Gateway creates an in-memory transaction log for each mock signaling event.

Each transaction log includes:

- `transactionId`
- `msisdn`
- `protocol`
- `eventType`
- `serviceType`
- `serviceCode`
- `destinationPlatform`
- `status`
- `failureReason`
- `errorMessage`
- `createdAt`

Recent transactions are available at:

```text
GET /transactions
```

Supported filters:

- `msisdn`
- `serviceType`
- `serviceCode`
- `status`
- `failureReason`

Examples:

```text
GET /transactions?msisdn=970599123456
GET /transactions?failureReason=BILLING_FAILED
GET /transactions?serviceCode=*123%23
```

Logs are in memory only and reset when the USSD Gateway restarts.

## KPI and Health Checks

The KPI endpoint calculates today's counters from in-memory transaction logs:

```text
GET /kpi/today
```

Example response:

```json
{
  "totalRequests": 5,
  "successCount": 2,
  "failedCount": 3,
  "successRate": "40%",
  "topFailureReason": "ROUTING_NOT_FOUND",
  "requestsByServiceType": {
    "USSD": 4,
    "SMS": 1
  },
  "requestsByDestinationPlatform": {
    "VAS_PLATFORM": 3,
    "UNKNOWN": 1,
    "SMSC_MOCK": 1
  }
}
```

The gateway health endpoint reports basic service broker component status:

```text
GET /health
```

Example response:

```json
{
  "status": "UP",
  "service": "ussd-gateway",
  "role": "USSD Gateway / Service Broker",
  "components": {
    "gatewayService": "UP",
    "routingModule": "UP",
    "transactionLogger": "UP",
    "vasPlatformConnector": "UP"
  },
  "uptimeSeconds": 123,
  "timestamp": "2026-05-21T00:00:00.000Z"
}
```

## Failure Scenarios

The mock signaling-event flow supports these failure scenarios:

| Scenario | How to Trigger | Result |
|---|---|---|
| Unknown service code | Use an unmapped `serviceCode` | `ROUTING_NOT_FOUND` |
| Subscriber not active | `simulateFailure: "SUBSCRIBER_NOT_ACTIVE"` | `FAILED` |
| Billing failure | `simulateFailure: "BILLING_FAILED"` | `FAILED` |
| Partner timeout | `simulateFailure: "PARTNER_TIMEOUT"` | `FAILED` |
| Internal error | `simulateFailure: "INTERNAL_ERROR"` | `FAILED` |

The existing USSD purchase flow also supports mock failures for CRM, Billing, Aggregator, and SMSC.

## Troubleshooting Examples

Find failed transactions:

```text
GET /transactions?status=FAILED
```

Find billing failures:

```text
GET /transactions?failureReason=BILLING_FAILED
```

Find all events for one subscriber:

```text
GET /transactions?msisdn=970599123456
```

Check whether routing is working:

```text
GET /kpi/today
```

Check platform health:

```text
GET /health
```

Look for a routing failure:

```text
failureReason = ROUTING_NOT_FOUND
```

Look for a partner issue:

```text
failureReason = PARTNER_TIMEOUT
```

## How to Run

From the repository root:

```powershell
docker compose up --build -d
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
| Billing Service | 3004 |
| SMSC Service | 3005 |
| Aggregator Service | 3006 |

## API Examples

Successful USSD signaling event:

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
    "text": "0",
    "simulateFailure": null
  }'
```

Unknown USSD code:

```bash
curl -X POST http://127.0.0.1:3007/simulate/signaling-event \
  -H "Content-Type: application/json" \
  -d '{
    "protocol": "SS7-MAP-MOCK",
    "eventType": "USSD_REQUEST",
    "msisdn": "970599123456",
    "serviceType": "USSD",
    "serviceCode": "*999#",
    "originPointCode": "1234",
    "destinationPointCode": "5678",
    "globalTitle": "970599123456",
    "visitedNetwork": "LOCAL",
    "simulateFailure": null
  }'
```

Inactive subscriber:

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
    "simulateFailure": "SUBSCRIBER_NOT_ACTIVE"
  }'
```

Billing failure:

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
    "simulateFailure": "BILLING_FAILED"
  }'
```

Roaming USSD request:

```bash
curl -X POST http://127.0.0.1:3007/simulate/signaling-event \
  -H "Content-Type: application/json" \
  -d '{
    "protocol": "SS7-MAP-MOCK",
    "eventType": "USSD_REQUEST",
    "msisdn": "970599123456",
    "serviceType": "ROAMING_USSD",
    "serviceCode": "*123#",
    "originPointCode": "1234",
    "destinationPointCode": "5678",
    "globalTitle": "970599123456",
    "visitedNetwork": "ROAMING",
    "simulateFailure": null
  }'
```

SMS/SMSC mock request:

```bash
curl -X POST http://127.0.0.1:3007/simulate/signaling-event \
  -H "Content-Type: application/json" \
  -d '{
    "protocol": "SS7-MAP-MOCK",
    "eventType": "SMS_REQUEST",
    "msisdn": "970599123456",
    "serviceType": "SMS",
    "serviceCode": "DEFAULT",
    "originPointCode": "1234",
    "destinationPointCode": "5678",
    "globalTitle": "970599123456",
    "visitedNetwork": "LOCAL",
    "simulateFailure": null
  }'
```

KPI endpoint:

```bash
curl http://127.0.0.1:3001/kpi/today
```

Health endpoint:

```bash
curl http://127.0.0.1:3001/health
```

Transaction search by subscriber:

```bash
curl "http://127.0.0.1:3001/transactions?msisdn=970599123456"
```

Transaction search by failure reason:

```bash
curl "http://127.0.0.1:3001/transactions?failureReason=BILLING_FAILED"
```

Existing USSD purchase flow:

```bash
curl -X POST http://127.0.0.1:3001/simulate-ussd \
  -H "Content-Type: application/json" \
  -d '{"msisdn":"0599123456","sessionId":"sess-buy","ussdCode":"*123#","text":"1"}'
```

## CV Description

Telecom Core/VAS Operations Simulator

Extended a VAS simulation project into a Core/VAS operations simulator by adding mock signaling events, routing rules, transaction logging, health checks, KPI reporting, and failure scenarios for USSD, SMS, roaming, and interconnect service flows.
