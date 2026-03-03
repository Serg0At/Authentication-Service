import amqp from 'amqplib';
import 'dotenv/config';
import config from '../config/variables.config.js';
import logger from '../utils/logger.util.js';
import { AuthModel } from '../models/index.js';
import db from '../config/db.js';
import { dbBreaker } from '../utils/circuit-breaker.util.js';

const { EXCHANGE, QUEUES, ROUTING_KEYS, RETRY } = config.RABBITMQ;

let connection = null;
let channel = null;
let reconnecting = false;

export const initRabbitConsumer = async () => {
  if (channel) return channel;

  connection = await amqp.connect(process.env.RABBIT_URL);
  channel = await connection.createChannel();

  await channel.assertExchange(EXCHANGE.NAME, EXCHANGE.TYPE, { durable: true });

  await channel.assertQueue(QUEUES.USERNAME_SYNC, { durable: true });
  await channel.bindQueue(QUEUES.USERNAME_SYNC, EXCHANGE.NAME, ROUTING_KEYS.USER_USERNAME_CHANGED);

  channel.consume(QUEUES.USERNAME_SYNC, async (msg) => {
    if (!msg) return;

    try {
      const payload = JSON.parse(msg.content.toString());
      logger.info('Received user.username_changed event', {
        userId: payload.user_id,
        oldUsername: payload.old_username,
        newUsername: payload.new_username,
      });

      await dbBreaker.fire(() =>
        db.transaction((trx) =>
          AuthModel.updateUsername(payload.user_id, payload.new_username, trx)
        )
      );

      logger.info('Username synced in users table', { userId: payload.user_id, newUsername: payload.new_username });
      channel.ack(msg);
    } catch (err) {
      logger.error('Failed to process user.username_changed event', { error: err.message, stack: err.stack });

      const retryCount = (msg.properties.headers?.['x-retry-count'] || 0) + 1;
      if (retryCount <= RETRY.MAX_RETRIES) {
        logger.warn(`Retrying user.username_changed (attempt ${retryCount}/${RETRY.MAX_RETRIES})`);
        setTimeout(() => {
          channel.publish('', QUEUES.USERNAME_SYNC, msg.content, {
            ...msg.properties,
            headers: { ...msg.properties.headers, 'x-retry-count': retryCount },
          });
          channel.ack(msg);
        }, RETRY.RETRY_DELAY);
      } else {
        logger.error('Max retries exceeded for user.username_changed event, nacking');
        channel.nack(msg, false, false);
      }
    }
  });

  connection.on('error', (err) => {
    logger.error('RabbitMQ consumer connection error', { error: err.message });
  });

  connection.on('close', () => {
    logger.warn('RabbitMQ consumer connection closed, scheduling reconnect');
    channel = null;
    connection = null;
    scheduleReconnect();
  });

  logger.info('RabbitMQ consumer connected, listening for user.username_changed');
  return channel;
};

const scheduleReconnect = () => {
  if (reconnecting) return;
  reconnecting = true;

  const attempt = (retries) => {
    setTimeout(async () => {
      try {
        await initRabbitConsumer();
        reconnecting = false;
        logger.info('RabbitMQ consumer reconnected');
      } catch (err) {
        const nextRetries = retries + 1;
        const delay = Math.min(RETRY.RECONNECT_INTERVAL * nextRetries, 30000);
        logger.warn(`RabbitMQ consumer reconnect failed, retry #${nextRetries} in ${delay}ms`, { error: err.message });
        attempt(nextRetries);
      }
    }, RETRY.RECONNECT_INTERVAL * retries || RETRY.RECONNECT_INTERVAL);
  };

  attempt(1);
};
