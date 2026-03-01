import amqp from 'amqplib';
import 'dotenv/config';
import config from '../config/variables.config.js';
import logger from '../utils/logger.util.js';

const { EXCHANGES, DLQ, RETRY } = config.RABBITMQ;

let connection = null;
let channel = null;
let reconnecting = false;

/**
 * Connect to RabbitMQ, create channel, and set up the full topology:
 * main exchanges → main queues (with DLX args) → DLX exchange → DLQ queues.
 */
export const initRabbit = async () => {
  if (channel) return channel;

  connection = await amqp.connect(process.env.RABBIT_URL);
  channel = await connection.createChannel();

  // ── DLX exchange ─────────────────────────────────
  await channel.assertExchange(EXCHANGES.DLX.NAME, EXCHANGES.DLX.TYPE, { durable: true });

  // ── DLQ queues bound to DLX ──────────────────────
  await channel.assertQueue(DLQ.SUBSCRIPTION, { durable: true });
  await channel.bindQueue(DLQ.SUBSCRIPTION, EXCHANGES.DLX.NAME, 'subscription.#');

  await channel.assertQueue(DLQ.NOTIFICATION, { durable: true });
  await channel.bindQueue(DLQ.NOTIFICATION, EXCHANGES.DLX.NAME, 'notification.#');

  // ── Subscription exchange + queue ────────────────
  await channel.assertExchange(EXCHANGES.SUBSCRIPTION.NAME, EXCHANGES.SUBSCRIPTION.TYPE, { durable: true });
  await channel.assertQueue(EXCHANGES.SUBSCRIPTION.QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': EXCHANGES.DLX.NAME,
      'x-dead-letter-routing-key': 'subscription.rejected',
    },
  });
  // Fanout ignores routing key, but binding is still required
  await channel.bindQueue(EXCHANGES.SUBSCRIPTION.QUEUE, EXCHANGES.SUBSCRIPTION.NAME, '');

  // ── Notification exchange + queue ────────────────
  await channel.assertExchange(EXCHANGES.NOTIFICATION.NAME, EXCHANGES.NOTIFICATION.TYPE, { durable: true });
  await channel.assertQueue(EXCHANGES.NOTIFICATION.QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': EXCHANGES.DLX.NAME,
      'x-dead-letter-routing-key': 'notification.rejected',
    },
  });
  await channel.bindQueue(EXCHANGES.NOTIFICATION.QUEUE, EXCHANGES.NOTIFICATION.NAME, EXCHANGES.NOTIFICATION.BIND_PATTERN);

  // ── Connection recovery ──────────────────────────
  connection.on('error', (err) => {
    logger.error('RabbitMQ connection error', { error: err.message });
  });

  connection.on('close', () => {
    logger.warn('RabbitMQ connection closed, scheduling reconnect');
    channel = null;
    connection = null;
    scheduleReconnect();
  });

  logger.info('RabbitMQ connected, topology ready');
  return channel;
};

/**
 * Reconnect with exponential backoff.
 */
const scheduleReconnect = () => {
  if (reconnecting) return;
  reconnecting = true;

  const attempt = (retries) => {
    setTimeout(async () => {
      try {
        await initRabbit();
        reconnecting = false;
        logger.info('RabbitMQ reconnected');
      } catch (err) {
        const nextRetries = retries + 1;
        const delay = Math.min(RETRY.RECONNECT_INTERVAL * nextRetries, 30000);
        logger.warn(`RabbitMQ reconnect failed, retry #${nextRetries} in ${delay}ms`, { error: err.message });
        attempt(nextRetries);
      }
    }, RETRY.RECONNECT_INTERVAL * retries || RETRY.RECONNECT_INTERVAL);
  };

  attempt(1);
};

/**
 * Build message buffer with retry-count header.
 */
const buildMessage = (payload) => ({
  content: Buffer.from(JSON.stringify(payload)),
  options: {
    persistent: true,
    headers: { 'x-retry-count': 0 },
    timestamp: Math.floor(Date.now() / 1000),
  },
});

/**
 * Publish to the subscription exchange (fanout).
 */
export const publishToSubscription = async (routingKey, payload) => {
  if (!channel) throw new Error('Rabbit channel not initialized');
  const msg = buildMessage(payload);
  channel.publish(EXCHANGES.SUBSCRIPTION.NAME, routingKey, msg.content, msg.options);
  logger.debug('Published to subscription exchange', { routingKey });
};

/**
 * Publish to the notification exchange (topic).
 */
export const publishToNotification = async (routingKey, payload) => {
  if (!channel) throw new Error('Rabbit channel not initialized');
  const msg = buildMessage(payload);
  channel.publish(EXCHANGES.NOTIFICATION.NAME, routingKey, msg.content, msg.options);
  logger.debug('Published to notification exchange', { routingKey });
};

/**
 * Publish to both subscription and notification exchanges.
 */
export const publishAuthEvent = async (routingKey, payload) => {
  await publishToSubscription(routingKey, payload);
  await publishToNotification(routingKey, payload);
};
