# Free Trial Abuse Prevention

## Overview

Goal: silently prevent the same user from claiming the 15-day free trial multiple times using different email addresses. No signup friction (no card/phone required).

Scope: web-only.

---

## Detection Layers

### Layer 1 — Browser Fingerprint (strongest signal)

Collected on the **frontend** via [FingerprintJS](https://github.com/fingerprintjs/fingerprintjs) (open-source) or FingerprintJS Pro (higher accuracy, ~99.5%).

The JS library generates a stable `visitorId` that survives incognito mode and cache clearing. The frontend sends it with the signup request.

### Layer 2 — IP Address

Available server-side. Used as a secondary signal — not a hard block alone (shared IPs exist), but combined with fingerprint it raises confidence.

### Layer 3 — Disposable Email Blocking

Block known temporary/disposable email providers (e.g. `tempmail.com`, `guerrillamail.com`) using a library like `disposable-email-domains` or an API like `mailcheck.ai`.

### Layer 4 — Email Normalization

Normalize emails before uniqueness checks:
- Strip `+alias` suffixes: `user+1@gmail.com` → `user@gmail.com`
- Lowercase
- Deduplicate on normalized form

---

## Integration into RegisterUser Flow

### 1. gRPC Request — add fields

```proto
message RegisterUserRequest {
  string email         = 1;
  string username      = 2;
  string password_hash = 3;
  string fingerprint   = 4; // visitorId from FingerprintJS
  string ip            = 5; // forwarded by GraphQL Gateway as gRPC metadata
}
```

### 2. RegisterUser handler — check before INSERT

```
1. Normalize email → check disposable provider → reject if blocked
2. EXISTS trial_devices:{sha256(fingerprint)} → fingerprint_seen = true
3. EXISTS trial_ips:{sha256(ip)}             → ip_seen = true
4. INSERT user into DB
5. SET trial_devices:{sha256(fingerprint)} = user_id  [TTL=365d]
6. SET trial_ips:{sha256(ip)}             = user_id  [TTL=30d]
7. Publish RabbitMQ event with trial_signals
```

---

## Redis Keys

Follows the existing key naming convention:

```
trial_devices:{sha256(fingerprint)} → user_id  [TTL=365d]
trial_ips:{sha256(ip)}             → user_id  [TTL=30d]
```

---

## RabbitMQ Event — enrich existing payload

Route: `auth-events.subscription.user.registered` → Subscription Service

```json
{
  "user_id": 123,
  "email": "mail@example.com",
  "ts": 1734103999,
  "trial_signals": {
    "fingerprint_seen": true,
    "ip_seen": false,
    "disposable_email": false
  }
}
```

The **Subscription Service** owns the decision on trial length based on signals:

| fingerprint_seen | ip_seen | Result          |
|------------------|---------|-----------------|
| false            | false   | 15-day trial    |
| false            | true    | 15-day trial    |
| true             | any     | 3-day trial     |
| true             | true    | 3-day trial     |

---

## Token rotation — separate concern, not fraud detection

Opaque refresh tokens are rotated on every use (old deleted, new issued). This detects stolen refresh tokens — if an attacker uses a stolen token first, the legitimate user's next refresh fails.

This identifies a **compromised session**, not a device or user. Do not conflate it with abuse detection.

---

## Open Question

Where does the client IP arrive in the Auth Service?

The GraphQL Gateway must forward the real client IP as gRPC metadata (e.g. `x-forwarded-for`) so Auth Service can read it during `RegisterUser`. Confirm this is handled at the gateway level.
