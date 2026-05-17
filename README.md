# Mini Telecom VAS Lab

A compact, beginner-friendly simulation of a Telecom Value-Added Services (VAS) stack implemented with small Node.js services and Docker Compose. It is designed for learning and interview demonstrations of USSD-driven flows, CRM/Billing interactions, activation via an aggregator, SMS confirmations via an SMSC, and failure/compensation scenarios.

---

## What this project simulates

- A USSD gateway that forwards simulated USSD requests.
- A central `vas-platform` that orchestrates USSD flows and service orchestration.
- A CRM service for subscriber status lookup.
- A Billing service that provides balances and performs charges.
- An Aggregator service that activates bundles on an external provider.
- An SMSC service that sends confirmation SMS messages.
- Failure injection controls to simulate error and timeout scenarios for testing resilience and compensation.

---

## Architecture (text diagram)

USSD Client (curl/PowerShell)
  -> USSD Gateway (3001)
    -> VAS Platform (3002)
      -> CRM Service (3003)
      -> Billing Service (3004)
      -> Aggregator Service (3006)
      -> SMSC Service (3005)

Each arrow is an HTTP call. The incoming USSD request may include a `simulateFailure` flag; `vas-platform` propagates it to downstream mock services to trigger simulated errors/timeouts.

---

## Services and ports

| Service | Purpose | Port |
|---|---|---:|
| ussd-gateway | Accepts simulated USSD, forwards to `vas-platform` | 3001 |
| vas-platform | Main USSD orchestration and business logic | 3002 |
| crm-service | Subscriber lookup (ACTIVE / SUSPENDED) | 3003 |
| billing-service | Balance lookup, charging, and test-only balance reset | 3004 |
| smsc-service | Mock SMSC for sending confirmation SMS | 3005 |
| aggregator-service | Mock aggregator that activates bundles with external providers | 3006 |

---

## Main USSD flow (summary)

1. User sends USSD command (simulated via `ussd-gateway` POST `/simulate-ussd`).
2. Gateway forwards to `vas-platform` POST `/ussd`.
3. `vas-platform` calls CRM to verify subscriber status.
4. `vas-platform` calls Billing to fetch balance.
5. If `text` == "1" (Buy bundle):
   - Check balance >= bundle price (example: 5 NIS).
   - Call Billing `POST /charge` to deduct amount.
   - Call Aggregator to activate the bundle.
   - Call SMSC to send confirmation SMS.
6. Return an appropriate USSD message to the subscriber.

---

## CRM and Billing flow details

- CRM (`GET /subscribers/:msisdn`) returns subscriber `status` (`ACTIVE`, `SUSPENDED`). If not found, returns 404.
- Billing (`GET /balance/:msisdn`) returns the numeric balance.
- Billing `POST /charge` deducts an amount from an in-memory balance and returns `{ status: 'CHARGED', newBalance }` or a 400 for insufficient funds.
- For testing convenience, Billing exposes `POST /reset-balances` to restore initial balances.

---

## Bundle purchase flow (Buy 1GB example)

- The VAS price is set to 5 NIS in the code.
- When user selects Buy (text == "1") and balance >= 5:
  1. `vas-platform` charges via Billing `POST /charge`.
  2. If charging succeeds, `vas-platform` calls Aggregator `POST /external-service` to provision the bundle.
  3. After successful provisioning, `vas-platform` calls SMSC `POST /send-sms` to send confirmation.
  4. The user receives final USSD message.

Note: The system charges before the Aggregator step. Aggregator failures are logged and flagged for compensation.

---

## Failure simulation scenarios

The USSD request may include a `simulateFailure` flag. `vas-platform` propagates this flag to downstream mock services that implement simulated errors/timeouts. Example payload snippet:

```json
{ "simulateFailure": "aggregator-timeout" }
```

Supported values and user-facing results:

| Flag | Description | Expected USSD message |
|---|---|---|
| `crm-500` | CRM returns HTTP 500 | "Service temporarily unavailable. Please try again later." |
| `billing-timeout` | Billing does not respond (timeout) | "Unable to check or charge your balance right now. Please try again later." |
| `billing-500` | Billing returns HTTP 500 | "Unable to check or charge your balance right now. Please try again later." |
| `aggregator-500` | Aggregator returns HTTP 500 (post-charge) | "Bundle activation failed after charging. Your transaction has been flagged for automatic refund/reversal." |
| `aggregator-timeout` | Aggregator times out (post-charge) | "Bundle activation failed after charging. Your transaction has been flagged for automatic refund/reversal." |
| `smsc-down` | SMSC returns HTTP 500 | "Bundle purchase successful, but SMS confirmation could not be sent." |
| `smsc-failed` | SMSC returns delivery FAILED | "Bundle purchase successful, but SMS confirmation could not be sent." |

---

## Compensation / Reversal explanation

- Because the VAS platform charges the subscriber before contacting the Aggregator, if the Aggregator fails after charging, the system cannot guarantee provisioning.
- These cases are logged with a `COMPENSATION_NEEDED` marker in `vas-platform` logs along with the `sessionId`.
- In real systems, this would kick off an automated reversal/refund workflow (or manual review). This lab simulates the detection and logging; actual refund mechanics are out of scope but are documented in the logs.

---

## How to run (Docker Compose)

From the repository root, run:

```powershell
# build and start in detached mode
docker compose up --build -d
```

To stop the stack:

```powershell
docker compose down
```

---

## How to test (PowerShell examples)

Show menu / balance:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3001/simulate-ussd -Method Post -ContentType 'application/json' -Body '{"msisdn":"0599123456","sessionId":"sess-menu","ussdCode":"*123#","text":"0"}'
```

Buy bundle (normal):

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3001/simulate-ussd -Method Post -ContentType 'application/json' -Body '{"msisdn":"0599123456","sessionId":"sess-buy","ussdCode":"*123#","text":"1"}'
```

Simulate aggregator timeout during purchase:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3001/simulate-ussd -Method Post -ContentType 'application/json' -Body '{"msisdn":"0599123456","sessionId":"test-agg-timeout","ussdCode":"*123#","text":"1","simulateFailure":"aggregator-timeout"}'
```

---

## How to test (curl examples)

Show menu / balance:

```bash
curl -s -X POST http://127.0.0.1:3001/simulate-ussd \
  -H "Content-Type: application/json" \
  -d '{"msisdn":"0599123456","sessionId":"sess-menu","ussdCode":"*123#","text":"0"}'
```

Buy bundle with aggregator error simulation:

```bash
curl -s -X POST http://127.0.0.1:3001/simulate-ussd \
  -H "Content-Type: application/json" \
  -d '{"msisdn":"0599123456","sessionId":"test-agg-500","ussdCode":"*123#","text":"1","simulateFailure":"aggregator-500"}'
```

---

## How to check logs

Follow the `vas-platform` logs (recommended) and the individual service logs for details:

```powershell
# follow vas-platform logs
docker compose logs -f vas-platform

# follow ussd-gateway logs
docker compose logs -f ussd-gateway
```

Search logs for session-specific traces (example using PowerShell):

```powershell
docker compose logs --no-color --tail 200 vas-platform | Select-String 'sess-buy' -Context 0,8
```

Look for `COMPENSATION_NEEDED` entries to find activation-after-charge failures.

---

## Troubleshooting (like a VAS engineer)

- vas-platform returns 500 / no response:
  - Check `docker compose ps` to verify containers are running.
  - Inspect `vas-platform` logs with `docker compose logs vas-platform`.
  - Confirm `ussd-gateway` can reach `vas-platform` (networking in compose).

- A downstream service times out:
  - Simulated timeouts can be triggered intentionally; ensure `simulateFailure` is not set.
  - If real timeouts occur, check resource constraints, container restarts, and port bindings.

- Balance values appear changed between tests:
  - The `billing-service` uses in-memory balances and mutates them on charge.
  - Use `POST /reset-balances` on `billing-service` (port 3004) to restore initial values.

- Containers fail to start or build errors:
  - Ensure Docker Desktop / daemon is running on your machine.
  - Review the build output for npm install errors; run `docker compose up --build` again to see logs.

---

## Common commands

```bash
docker compose up --build -d
docker compose ps
docker compose logs -f vas-platform
docker compose logs -f ussd-gateway
```

---

## What I learned

This mini lab demonstrates core concepts of a VAS architecture: how USSD front-ends map to business logic, the importance of reliable CRM/Billing lookups before charging, the implications of ordering (charge before activation), and how to design for observability and compensation when external dependencies fail. It reinforces practical lessons about local integration testing with Docker Compose, simple fault injection, and end-to-end traceability.

---

## How this relates to real VAS platforms

- USSD Gateways: In production, USSD gateways handle session state, concurrency, and operator-specific protocols. This lab models the gateway as a simple HTTP forwarder.
- VAS Orchestrator: `vas-platform` mimics real business logic that orchestrates CRM, Billing, provisioning, and notifications.
- CRM and Billing: Real systems have persistent databases, transactional guarantees, and asynchronous eventing. This lab uses simplified HTTP mocks and in-memory state for clarity.
- Aggregators & SMSC: Real provisioning and SMSC interactions use secured APIs, retries, and idempotency. The lab simulates these interactions and shows how to handle failures.

