# Auth Service

Authentication and authorization microservice for the Arbitrage Scanner platform. Handles user registration, login, token management, 2FA, OAuth (Google OIDC), and email verification.

## Tech Stack

- **Runtime:** Node.js 20
- **Transport:** gRPC (via `@grpc/grpc-js`)
- **Database:** PostgreSQL (NeonDB) with Knex.js
- **Cache/Sessions:** Redis (ioredis)
- **Message Brokers:** RabbitMQ (amqplib) + Kafka (kafkajs)
- **Auth:** JWT (RS256 access + HS256 refresh), bcrypt, TOTP 2FA
- **Logging:** Winston

## Architecture

```
GraphQL Gateway
      |
      | gRPC (:50053)
      v
 Auth Service
      |
      ├── PostgreSQL   (users, credentials)
      ├── Redis        (sessions, token blacklist, verification codes)
      ├── RabbitMQ     (auth events → subscription-service, notification-service)
      └── Kafka        (event streaming)
```

## gRPC API

Defined in `proto/auth.proto`:

| RPC | Description |
|-----|-------------|
| `RegisterUser` | Create account, send verification email |
| `VerifyEmail` | Confirm email via magic link token |
| `LoginUser` | Email/password login |
| `OIDCLogin` | Google OAuth login |
| `ForgotPassword` | Send password reset code |
| `ResetPassword` | Change password with old password |
| `Setup2FA` | Generate TOTP QR code and backup codes |
| `Verify2FA` | Validate TOTP code |
| `ValidateAccessToken` | Verify JWT and return user info |
| `RefreshTokens` | Rotate access + refresh tokens |

## Project Structure

```
src/
├── app.js                  # Entry point — init Redis, Kafka, RabbitMQ, gRPC
├── bin/
│   ├── server.js           # gRPC server setup and graceful shutdown
│   └── loader.js           # Proto file loader
├── config/
│   ├── variables.config.js # Centralized env config
│   └── knex.config.js      # Database connection config
├── controllers/            # gRPC request handlers
├── services/               # Business logic
├── models/                 # Data access layer
├── middlewares/             # Auth, rate limiting, validation
├── kafka/                  # Kafka producer
├── rabbit/                 # RabbitMQ publisher (fanout + topic exchanges, DLX/DLQ)
├── redis/                  # Redis client and session/cache operations
└── utils/                  # JWT, crypto, logger, error/success handlers
```

## Getting Started

### Prerequisites

- Node.js 20+
- Docker & Docker Compose

### 1. Clone and install

```bash
git clone git@gitlab.coduretech.dev:arbitrage-scanner/back-end/auth-service.git
cd auth-service
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in your PostgreSQL, Redis, RabbitMQ credentials
```

### 3. Start infrastructure

```bash
docker compose up -d
```

This starts Redis, RabbitMQ, Kafka, and Zookeeper with healthchecks.

### 4. Run migrations and seed

```bash
npm run migrate
npm run seed
```

### 5. Start the service

```bash
npm run dev
```

You should see:

```
[info] Redis connected
[info] Kafka connected
[info] RabbitMQ connected, topology ready
[info] gRPC server started on 50053
[info] ========== AUTH SERVICE IS READY ==========
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start with nodemon (development) |
| `npm start` | Start in production mode |
| `npm run debug` | Start with Node inspector |
| `npm run migrate` | Run database migrations |
| `npm run migrate-down` | Drop database tables |
| `npm run seed` | Seed database with initial data |
| `npm run lint` | Run ESLint |
| `npm run format` | Format code with Prettier |

## RabbitMQ Topology

```
auth-events.subscription (fanout) → auth-events.subscription.queue
auth-events.notification (topic)  → auth-events.notification.queue (bind: user.*)
auth-events.dlx (topic)           → *.dlq (dead letter queues)
```

### Routing Keys

- `user.registered` — new user signed up
- `user.logged_in` — user login event
- `user.password_changed` — password was reset
- `user.profile_updated` — profile data changed
- `user.verify_email` — email verification requested

## Environment Variables

See [.env.example](.env.example) for the full list with descriptions.

## Author

Serg
