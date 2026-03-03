# Auth Service

Authentication and authorization microservice built with Node.js and gRPC. Part of a larger microservices architecture with a GraphQL gateway as the consumer. Handles user registration, login, token management, 2FA (TOTP), OAuth (Google OIDC), password reset, and email verification.

## Tech Stack

- **Runtime:** Node.js (ES modules)
- **Transport:** gRPC (`@grpc/grpc-js`, `@grpc/proto-loader`)
- **Database:** PostgreSQL via Knex.js (tables: `users`, `user_2fa`, `oauth_accounts`)
- **Cache/Sessions:** Redis (ioredis) — sessions, refresh tokens, reset codes, email verification
- **Messaging:** RabbitMQ (amqplib) — topic exchange for notifications, fanout for subscriptions
- **Auth:** RS256 JWT access tokens, opaque refresh tokens (stored in Redis, 30-day TTL)
- **2FA:** TOTP via `otplib`, QR codes via `qrcode`
- **Resilience:** Circuit breakers via `opossum`
- **Validation:** Joi schemas
- **Logging:** Winston

## Architecture

```
GraphQL Gateway
      |
      | gRPC (:50051)
      v
 Auth Service
      |
      ├── PostgreSQL   (users, 2FA secrets, OAuth accounts)
      ├── Redis        (sessions, refresh tokens, reset codes, verification tokens)
      └── RabbitMQ     (auth events → notification-service, subscription-service, user-service)
```

## gRPC API

Defined in `proto/auth.proto`:

| RPC | Description |
|-----|-------------|
| `RegisterUser` | Create account with email/username/password |
| `LoginUser` | Email or username + password login (returns `requires_2fa` if enabled) |
| `OIDCLogin` | Google OAuth login via authorization code |
| `ForgotPassword` | Send password reset code to email |
| `VerifyResetCode` | Validate reset code without consuming it |
| `ResetPassword` | Reset password using email + code (unauthenticated) |
| `ChangePassword` | Change password with old password (authenticated) |
| `Setup2FA` | Generate TOTP QR code, secret, and backup codes |
| `Verify2FA` | Validate TOTP code, returns tokens with `acr: '2fa'` claim |
| `VerifyEmail` | Confirm email via magic link token |
| `RefreshTokens` | Rotate access + refresh tokens |
| `Logout` | Revoke refresh token and end session |

## Project Structure

```
src/
├── app.js              # Entry point — boots Redis, RabbitMQ, DB, then gRPC server
├── bin/
│   ├── server.js       # gRPC server setup and graceful shutdown
│   └── loader.js       # Proto file loader (keepCase: true)
├── config/
│   ├── variables.config.js  # Centralized env config
│   ├── db.js                # Database connection
│   └── knex.config.js       # Knex configuration
├── controllers/        # gRPC handlers (call, callback pattern)
├── services/           # Business logic (auth, oauth, twofa)
├── models/             # Knex query builders (Auth, OAuth, TwoFa)
├── middlewares/
│   ├── schemas/        # Joi validation schemas
│   └── validation.js   # Validation middleware
├── rabbit/             # RabbitMQ publisher
├── redis/              # Redis client + operations
└── utils/              # JWT, crypto, error-handler, success-handler, circuit-breaker, logger
proto/auth.proto        # All RPC definitions
migrations/             # create_tables.js / drop_tables.js
```

## Getting Started

### Prerequisites

- Node.js 20+
- Docker & Docker Compose

### 1. Clone and install

```bash
git clone <repository-url>
cd auth-service
npm install
```

### 2. Configure environment

Create a `.env` file with your PostgreSQL, Redis, and RabbitMQ credentials. See `src/config/variables.config.js` for the full list of required environment variables.

### 3. Start infrastructure

```bash
docker compose up -d
```

### 4. Run migrations

```bash
npm run migrate
```

### 5. Start the service

```bash
npm run dev
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start with nodemon (development) |
| `npm start` | Start in production mode |
| `npm run debug` | Start with Node inspector |
| `npm run reload` | Kill port 50051 + restart dev |
| `npm run migrate` | Run database migrations |
| `npm run migrate-down` | Drop database tables |
| `npm run seed` | Seed database |
| `npm test` | Run tests (Jest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Run ESLint with auto-fix |
| `npm run format` | Format code with Prettier |
| `npm run docker:build` | Build Docker image |
| `npm run compose:up` | Start with Docker Compose |
| `npm run compose:down` | Stop Docker Compose |

## RabbitMQ Events

Published via `publishAuthEvent(routingKey, payload)`:

| Routing Key | Description |
|-------------|-------------|
| `user.registered` | New user signed up |
| `user.logged_in` | User login event |
| `user.password_changed` | Password was changed |
| `user.verify_email` | Email verification requested |
| `user.forgot_password` | Password reset requested |
| `user.2fa_enabled` | 2FA was enabled |

## Author

Serg
