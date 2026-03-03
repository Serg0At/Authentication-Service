import AuthService from '../services/auth.service.js';
import { SuccessHandler, ErrorHandler } from '../utils/index.js';
import { Validation } from '../middlewares/validations/index.js';

export default class AuthController {
  static async registerUser(call, callback) {
    const meta = { method: 'RegisterUser' };
    try {
      const { email, username, password_hash } = call.request;
      const userAgent = call.metadata.get('user-agent')[0] || 'unknown';

      const { error: validationError } = Validation.validateRegister({ email, username, password_hash });
      if (validationError) {
        return ErrorHandler.invalidArgument(callback, validationError.details.map(d => d.message).join('; '), meta);
      }

      const result = await AuthService.register({
        email,
        username,
        password: password_hash,
        userAgent
      });

      SuccessHandler.registered(callback, result, { ...meta, userId: result.user.id, email });
    } catch (error) {
      ErrorHandler.handle(callback, error, meta);
    }
  }

  static async loginUser(call, callback) {
    const meta = { method: 'LoginUser' };
    try {
      const { email_username, password_hash } = call.request;
      const userAgent = call.metadata.get('user-agent')[0] || 'unknown';

      const { error: validationError } = Validation.validateLogin({ email_username, password_hash });
      if (validationError) {
        return ErrorHandler.invalidArgument(callback, validationError.details.map(d => d.message).join('; '), meta);
      }

      const result = await AuthService.login({
        emailUsername: email_username,
        password: password_hash,
        userAgent,
      });

      SuccessHandler.authenticated(callback, result, { ...meta, userId: result.user.id });
    } catch (error) {
      ErrorHandler.handle(callback, error, meta);
    }
  }

  static async refreshTokens(call, callback) {
    const meta = { method: 'RefreshTokens' };
    try {
      const { refresh_token } = call.request;
      const userAgent = call.metadata.get('user-agent')[0] || 'unknown';

      const { error: validationError } = Validation.validateRefreshToken({ refresh_token });
      if (validationError) {
        return ErrorHandler.invalidArgument(callback, validationError.details.map(d => d.message).join('; '), meta);
      }

      const result = await AuthService.refreshTokens({
        refreshToken: refresh_token,
        userAgent,
      });

      SuccessHandler.tokenRefreshed(callback, result, meta);
    } catch (error) {
      ErrorHandler.handle(callback, error, meta);
    }
  }

  static async forgotPassword(call, callback) {
    const meta = { method: 'ForgotPassword' };
    try {
      const { email } = call.request;

      const { error: validationError } = Validation.validateForgotPassword({ email });
      if (validationError) {
        return ErrorHandler.invalidArgument(callback, validationError.details.map(d => d.message).join('; '), meta);
      }

      const result = await AuthService.forgotPassword({ email });

      SuccessHandler.ok(callback, result, { ...meta, email });
    } catch (error) {
      ErrorHandler.handle(callback, error, meta);
    }
  }

  static async verifyResetCode(call, callback) {
    const meta = { method: 'VerifyResetCode' };
    try {
      const { email, code } = call.request;

      const { error: validationError } = Validation.validateVerifyResetCode({ email, code });
      if (validationError) {
        return ErrorHandler.invalidArgument(callback, validationError.details.map(d => d.message).join('; '), meta);
      }

      const result = await AuthService.verifyResetCode({ email, code });

      SuccessHandler.ok(callback, result, meta);
    } catch (error) {
      ErrorHandler.handle(callback, error, meta);
    }
  }

  static async resetPassword(call, callback) {
    const meta = { method: 'ResetPassword' };
    try {
      const { email, code, new_pass } = call.request;

      const { error: validationError } = Validation.validateResetPassword({ email, code, new_pass });
      if (validationError) {
        return ErrorHandler.invalidArgument(callback, validationError.details.map(d => d.message).join('; '), meta);
      }

      const result = await AuthService.resetPassword({ email, code, newPass: new_pass });

      SuccessHandler.passwordChanged(callback, result, meta);
    } catch (error) {
      ErrorHandler.handle(callback, error, meta);
    }
  }

  static async changePassword(call, callback) {
    const meta = { method: 'ChangePassword' };
    try {
      const { old_pass, new_pass, access_token } = call.request;

      const { error: validationError } = Validation.validateChangePassword({ old_pass, new_pass, access_token });
      if (validationError) {
        return ErrorHandler.invalidArgument(callback, validationError.details.map(d => d.message).join('; '), meta);
      }

      const result = await AuthService.changePassword({
        oldPass: old_pass,
        newPass: new_pass,
        accessToken: access_token,
      });

      SuccessHandler.passwordChanged(callback, result, meta);
    } catch (error) {
      ErrorHandler.handle(callback, error, meta);
    }
  }

  static async setup2FA(call, callback) {
    const meta = { method: 'Setup2FA' };
    try {
      const { access_token } = call.request;

      const { error: validationError } = Validation.validateSetup2FA({ access_token });
      if (validationError) {
        return ErrorHandler.invalidArgument(callback, validationError.details.map(d => d.message).join('; '), meta);
      }

      const result = await AuthService.setup2FA({ accessToken: access_token });

      SuccessHandler.twoFactorSetup(callback, result, meta);
    } catch (error) {
      ErrorHandler.handle(callback, error, meta);
    }
  }

  static async verify2FA(call, callback) {
    const meta = { method: 'Verify2FA' };
    try {
      const { code, access_token } = call.request;
      const userAgent = call.metadata.get('user-agent')[0] || 'unknown';

      const { error: validationError } = Validation.validateVerify2FA({ code, access_token });
      if (validationError) {
        return ErrorHandler.invalidArgument(callback, validationError.details.map(d => d.message).join('; '), meta);
      }

      const result = await AuthService.verify2FA({
        code,
        accessToken: access_token,
        userAgent,
      });

      SuccessHandler.twoFactorVerified(callback, result, meta);
    } catch (error) {
      ErrorHandler.handle(callback, error, meta);
    }
  }

  static async logout(call, callback) {
    const meta = { method: 'Logout' };
    try {
      const { refresh_token } = call.request;
      const userAgent = call.metadata.get('user-agent')[0] || 'unknown';

      const { error: validationError } = Validation.validateLogout({ refresh_token });
      if (validationError) {
        return ErrorHandler.invalidArgument(callback, validationError.details.map(d => d.message).join('; '), meta);
      }

      const result = await AuthService.logout({
        refreshToken: refresh_token,
        userAgent,
      });

      SuccessHandler.ok(callback, result, meta);
    } catch (error) {
      ErrorHandler.handle(callback, error, meta);
    }
  }

  static async verifyEmail(call, callback) {
    const meta = { method: 'VerifyEmail' };
    try {
      const { token } = call.request;

      const { error: validationError } = Validation.validateVerifyEmail({ token });
      if (validationError) {
        return ErrorHandler.invalidArgument(callback, validationError.details.map(d => d.message).join('; '), meta);
      }

      const result = await AuthService.verifyEmail({ token });

      SuccessHandler.emailVerified(callback, result, meta);
    } catch (error) {
      ErrorHandler.handle(callback, error, meta);
    }
  }
}
