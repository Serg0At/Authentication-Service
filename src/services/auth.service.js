import crypto from 'crypto';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import CryptoUtil from '../utils/crypto.util.js';
import JwtUtil from '../utils/jwt.util.js';
import { publishAuthEvent } from '../rabbit/publisher.js';
import { getRedis, redisOps } from '../redis/redisClient.js';
import config from '../config/variables.config.js';
import db from '../config/db.js';
import { AuthModel } from '../models/index.js';
import { dbBreaker, redisBreaker, rabbitBreaker } from '../utils/index.js';

authenticator.options = {
  digits: config.TOTP.DIGITS,
  period: config.TOTP.PERIOD,
  window: 1,
};

export default class AuthService {
  static async register({ email, username, password, userAgent }) {
    const [emailConflict, usernameConflict] = await Promise.all([
      dbBreaker.fire(() => AuthModel.findByEmail(email)),
      dbBreaker.fire(() => AuthModel.findByUsername(username)),
    ]);

    if (emailConflict) {
      const err = new Error('Email is already in use');
      err.name = 'ConflictError';
      throw err;
    }
    if (usernameConflict) {
      const err = new Error('Username is already in use');
      err.name = 'ConflictError';
      throw err;
    }

    const passwordHash = await CryptoUtil.hashPassword(password);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    const newUser = await dbBreaker.fire(() =>
      db.transaction((trx) =>
        AuthModel.create(
          { email, username, password_hash: passwordHash, role: 0, is_active: false, device_fingerprint: userAgent },
          trx
        )
      )
    );

    const redisKey = `verify_token:${verificationToken}`;
    await redisBreaker.fire(() =>
      getRedis().set(
        redisKey,
        JSON.stringify({ userId: newUser.id, email }),
        'EX',
        config.EMAIL.VERIFY_TOKEN_TTL
      )
    );

    const uaHash = CryptoUtil.hashUA(userAgent);
    const { accessToken } = JwtUtil.generateAccessToken(
      { id: newUser.id, email: newUser.email, role: newUser.role },
      uaHash
    );
    const refreshToken = JwtUtil.generateRefreshToken();

    await redisBreaker.fire(() => redisOps.saveRefreshToken(refreshToken, newUser.id, uaHash));

    await rabbitBreaker.fire(() =>
      publishAuthEvent(
        config.RABBITMQ.ROUTING_KEYS.USER_REGISTERED,
        {
          user_id: newUser.id,
          email: newUser.email,
          username: newUser.username,
          verification_token: verificationToken,
          ts: Math.floor(Date.now() / 1000)
        }
      )
    );

    return {
      success: true,
      user: {
        id: newUser.id.toString(),
        email: newUser.email,
        username: newUser.username,
        external_id: '',
        provider: 'local',
        subscription: null
      },
      tokens: {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: 3600
      }
    };
  }

  static async login({ emailUsername, password, userAgent }) {
    const user = await dbBreaker.fire(() => AuthModel.findByEmailOrUsername(emailUsername));

    if (!user || !user.password_hash) {
      const err = new Error('Invalid credentials');
      err.name = 'InvalidPasswordError';
      throw err;
    }

    if (!user.is_active) {
      const err = new Error('Account not activated. Please verify your email.');
      err.name = 'UnauthorizedError';
      throw err;
    }

    const hash = String(user.password_hash);
    const isValid = await CryptoUtil.comparePassword(password, hash);
    if (!isValid) {
      const err = new Error('Invalid credentials');
      err.name = 'InvalidPasswordError';
      throw err;
    }

    const uaHash = CryptoUtil.hashUA(userAgent);

    // Check if user has 2FA enabled
    const twoFA = await dbBreaker.fire(() => AuthModel.find2FAByUserId(user.id));
    if (twoFA?.enabled) {
      const { accessToken } = JwtUtil.generateAccessToken(
        { id: user.id, email: user.email, role: user.role },
        uaHash
      );

      return {
        success: true,
        user: {
          id: user.id.toString(),
          email: user.email,
          username: user.username,
          external_id: '',
          provider: 'local',
          subscription: null,
        },
        tokens: {
          access_token: accessToken,
          refresh_token: '',
          token_type: 'Bearer',
          expires_in: 300,
        },
        requires_2fa: true,
      };
    }

    const { accessToken } = JwtUtil.generateAccessToken(
      { id: user.id, email: user.email, role: user.role },
      uaHash
    );
    const refreshToken = JwtUtil.generateRefreshToken();

    // Revoke old refresh token for this device before saving new one
    await redisBreaker.fire(() => redisOps.revokeDeviceToken(user.id, uaHash));

    await Promise.all([
      dbBreaker.fire(() => AuthModel.updateLastLogin(user.id)),
      redisBreaker.fire(() => redisOps.addUserSession(user.id, uaHash)),
      redisBreaker.fire(() => redisOps.saveRefreshToken(refreshToken, user.id, uaHash)),
    ]);

    await rabbitBreaker.fire(() =>
      publishAuthEvent(
        config.RABBITMQ.ROUTING_KEYS.USER_LOGGED_IN,
        {
          user_id: user.id,
          email: user.email,
          ts: Math.floor(Date.now() / 1000),
        }
      )
    );

    return {
      success: true,
      user: {
        id: user.id.toString(),
        email: user.email,
        username: user.username,
        external_id: '',
        provider: 'local',
        subscription: null,
      },
      tokens: {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: 3600,
      },
      requires_2fa: false,
    };
  }

  static async refreshTokens({ refreshToken, userAgent }) {
    const session = await redisBreaker.fire(() => redisOps.getRefreshToken(refreshToken));
    if (!session) {
      const err = new Error('Invalid or expired refresh token');
      err.name = 'UnauthorizedError';
      throw err;
    }

    const uaHash = CryptoUtil.hashUA(userAgent);
    if (session.device !== uaHash) {
      const err = new Error('Device mismatch');
      err.name = 'UnauthorizedError';
      throw err;
    }

    const user = await dbBreaker.fire(() => AuthModel.findById(session.user_id));
    if (!user) {
      const err = new Error('User not found');
      err.name = 'ResourceNotFoundError';
      throw err;
    }

    // Rotate: delete old, create new
    await redisBreaker.fire(() => redisOps.deleteRefreshToken(refreshToken));

    const { accessToken } = JwtUtil.generateAccessToken(
      { id: user.id, email: user.email, role: user.role },
      uaHash
    );
    const newRefreshToken = JwtUtil.generateRefreshToken();

    await redisBreaker.fire(() => redisOps.saveRefreshToken(newRefreshToken, user.id, uaHash));

    return {
      access_token: accessToken,
      refresh_token: newRefreshToken,
    };
  }

  static async forgotPassword({ email }) {
    const user = await dbBreaker.fire(() => AuthModel.findByEmailOrUsername(email));

    // Always return success to prevent email enumeration
    if (!user) {
      return {
        success: true,
        message: 'If the email exists, a reset code has been sent',
      };
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));

    await redisBreaker.fire(() => redisOps.saveVerificationCode(email, code, user.id));

    await rabbitBreaker.fire(() =>
      publishAuthEvent(
        config.RABBITMQ.ROUTING_KEYS.USER_FORGOT_PASSWORD,
        {
          user_id: user.id,
          email: user.email,
          code,
          ts: Math.floor(Date.now() / 1000),
        }
      )
    );

    return {
      success: true,
      message: 'If the email exists, a reset code has been sent',
    };
  }

  static async verifyResetCode({ email, code }) {
    const stored = await redisBreaker.fire(() => redisOps.getVerificationCode(email));
    if (!stored) {
      const err = new Error('Reset code expired or invalid');
      err.name = 'ExpiredTokenConfirmError';
      throw err;
    }

    if (stored.code !== code) {
      const err = new Error('Invalid reset code');
      err.name = 'InvalidEmailConfirmError';
      throw err;
    }

    return {
      success: true,
      message: 'Code verified successfully',
    };
  }

  static async resetPassword({ email, code, newPass }) {
    const stored = await redisBreaker.fire(() => redisOps.getVerificationCode(email));
    if (!stored) {
      const err = new Error('Reset code expired or invalid');
      err.name = 'ExpiredTokenConfirmError';
      throw err;
    }

    if (stored.code !== code) {
      const err = new Error('Invalid reset code');
      err.name = 'InvalidEmailConfirmError';
      throw err;
    }

    const passwordHash = await CryptoUtil.hashPassword(newPass);

    await dbBreaker.fire(() => AuthModel.updatePassword(stored.userId, passwordHash));
    await redisBreaker.fire(() => redisOps.deleteVerificationCode(email));

    await rabbitBreaker.fire(() =>
      publishAuthEvent(
        config.RABBITMQ.ROUTING_KEYS.USER_PASSWORD_CHANGED,
        {
          user_id: stored.userId,
          ts: Math.floor(Date.now() / 1000),
        }
      )
    );

    return {
      success: true,
      message: 'Password reset successfully',
    };
  }

  static async changePassword({ oldPass, newPass, accessToken }) {
    const decoded = JwtUtil.verifyAccessToken(accessToken);
    if (!decoded) {
      const err = new Error('Invalid or expired access token');
      err.name = 'UnauthorizedError';
      throw err;
    }

    const user = await dbBreaker.fire(() => AuthModel.findByEmailOrUsername(decoded.email));
    if (!user) {
      const err = new Error('User not found');
      err.name = 'ResourceNotFoundError';
      throw err;
    }

    const hash = String(user.password_hash);
    const isValid = await CryptoUtil.comparePassword(oldPass, hash);
    if (!isValid) {
      const err = new Error('Old password is incorrect');
      err.name = 'InvalidPasswordError';
      throw err;
    }

    const passwordHash = await CryptoUtil.hashPassword(newPass);

    await dbBreaker.fire(() => AuthModel.updatePassword(user.id, passwordHash));

    await rabbitBreaker.fire(() =>
      publishAuthEvent(
        config.RABBITMQ.ROUTING_KEYS.USER_PASSWORD_CHANGED,
        {
          user_id: user.id,
          ts: Math.floor(Date.now() / 1000),
        }
      )
    );

    return {
      success: true,
      message: 'Password changed successfully',
    };
  }

  static async setup2FA({ accessToken }) {
    const decoded = JwtUtil.verifyAccessToken(accessToken);
    if (!decoded) {
      const err = new Error('Invalid or expired access token');
      err.name = 'UnauthorizedError';
      throw err;
    }

    const existing = await dbBreaker.fire(() => AuthModel.find2FAByUserId(decoded.id));
    if (existing?.enabled) {
      const err = new Error('2FA is already enabled');
      err.name = 'ConflictError';
      throw err;
    }

    // Allow re-setup if previously started but not verified
    if (existing && !existing.enabled) {
      await dbBreaker.fire(() => AuthModel.delete2FA(decoded.id));
    }

    const secret = authenticator.generateSecret();
    const otpauthUri = authenticator.keyuri(decoded.email, config.TOTP.ISSUER, secret);
    const qrCode = await QRCode.toDataURL(otpauthUri);

    const encryptedSecret = CryptoUtil.encrypt(secret, config.SECURITY.ENCRYPTION_KEY);

    // Generate backup codes: random 8-char hex strings, store hashed
    const backupCodesPlain = Array.from({ length: config.TOTP.BACKUP_CODES_COUNT }, () =>
      crypto.randomBytes(4).toString('hex')
    );
    const backupCodesHashed = backupCodesPlain.map((code) =>
      crypto.createHash('sha256').update(code).digest('hex')
    );

    await dbBreaker.fire(() =>
      AuthModel.create2FA(decoded.id, encryptedSecret, backupCodesHashed)
    );

    return {
      success: true,
      qr_code: qrCode,
      secret,
      backup_codes: backupCodesPlain,
    };
  }

  static async verify2FA({ code, accessToken, userAgent }) {
    const decoded = JwtUtil.verifyAccessToken(accessToken);
    if (!decoded) {
      const err = new Error('Invalid or expired access token');
      err.name = 'UnauthorizedError';
      throw err;
    }

    const twoFA = await dbBreaker.fire(() => AuthModel.find2FAByUserId(decoded.id));
    if (!twoFA) {
      const err = new Error('2FA is not set up for this account');
      err.name = 'ResourceNotFoundError';
      throw err;
    }

    const secret = CryptoUtil.decrypt(twoFA.secret, config.SECURITY.ENCRYPTION_KEY);
    let isValid = authenticator.check(code, secret);
    let backupCodeUsed = false;

    // If TOTP check fails, try backup codes
    if (!isValid) {
      const codeHash = crypto.createHash('sha256').update(code).digest('hex');
      const backupCodes = typeof twoFA.backup_codes === 'string'
        ? JSON.parse(twoFA.backup_codes)
        : twoFA.backup_codes;

      const idx = backupCodes.indexOf(codeHash);
      if (idx !== -1) {
        isValid = true;
        backupCodeUsed = true;
        backupCodes.splice(idx, 1);
        await dbBreaker.fire(() => AuthModel.update2FABackupCodes(decoded.id, backupCodes));
      }
    }

    if (!isValid) {
      const err = new Error('Invalid 2FA code');
      err.name = 'Invalid2FACodeError';
      throw err;
    }

    // First-time activation
    if (!twoFA.enabled) {
      await dbBreaker.fire(() => AuthModel.enable2FA(decoded.id));

      await rabbitBreaker.fire(() =>
        publishAuthEvent(
          config.RABBITMQ.ROUTING_KEYS.USER_2FA_ENABLED,
          {
            user_id: decoded.id,
            email: decoded.email,
            ts: Math.floor(Date.now() / 1000),
          }
        )
      );
    }

    const uaHash = decoded.ua_hash || CryptoUtil.hashUA(userAgent || 'unknown');

    // Generate upgraded access token with acr claim
    const { accessToken: newAccessToken } = JwtUtil.generateAccessToken(
      { id: decoded.id, email: decoded.email, role: decoded.role },
      uaHash,
      { acr: '2fa' }
    );

    // Post-login 2FA: create session + refresh token
    const refreshToken = JwtUtil.generateRefreshToken();

    await redisBreaker.fire(() => redisOps.revokeDeviceToken(decoded.id, uaHash));

    await Promise.all([
      dbBreaker.fire(() => AuthModel.updateLastLogin(decoded.id)),
      redisBreaker.fire(() => redisOps.addUserSession(decoded.id, uaHash)),
      redisBreaker.fire(() => redisOps.saveRefreshToken(refreshToken, decoded.id, uaHash)),
    ]);

    return {
      success: true,
      message: backupCodeUsed
        ? '2FA verified with backup code. Please generate new backup codes.'
        : '2FA verified successfully',
      access_token: newAccessToken,
      refresh_token: refreshToken,
    };
  }

  static async verifyEmail({ token }) {
    const redisKey = `verify_token:${token}`;
    const raw = await redisBreaker.fire(() => getRedis().get(redisKey));
    if (!raw) {
      throw new Error('Verification link expired or invalid');
    }

    const { userId } = JSON.parse(raw);

    const updated = await dbBreaker.fire(() => AuthModel.activate(userId));
    if (!updated) {
      throw new Error('User not found');
    }

    await redisBreaker.fire(() => getRedis().del(redisKey));

    return {
      success: true,
      message: 'Email verified successfully! Your account is now active.'
    };
  }
}
