/** Every failure is a PerlyPayError: the API's own `{ type, code, message, param }`, plus the HTTP status and request id. */

export interface ErrorFields {
  type: string;
  code: string;
  message: string;
  param?: string | undefined;
  status?: number | undefined;
  requestId?: string | undefined;
  headers?: Record<string, string> | undefined;
}

export class PerlyPayError extends Error {
  readonly type: string;
  readonly code: string;
  readonly param: string | undefined;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly headers: Record<string, string>;

  constructor(fields: ErrorFields) {
    super(fields.message);
    this.name = new.target.name;
    this.type = fields.type;
    this.code = fields.code;
    this.param = fields.param;
    this.status = fields.status;
    this.requestId = fields.requestId;
    this.headers = fields.headers ?? {};
  }

  static from(fields: ErrorFields): PerlyPayError {
    switch (fields.type) {
      case "invalid_request_error":
        return new InvalidRequestError(fields);
      case "authentication_error":
        return new AuthenticationError(fields);
      case "permission_error":
        return new PermissionError(fields);
      case "rate_limit_error":
        return new RateLimitError(fields);
      case "idempotency_error":
        return new IdempotencyError(fields);
      default:
        return new APIError(fields);
    }
  }
}

export class InvalidRequestError extends PerlyPayError {}
export class AuthenticationError extends PerlyPayError {}
export class PermissionError extends PerlyPayError {}
export class RateLimitError extends PerlyPayError {}
export class IdempotencyError extends PerlyPayError {}
export class APIError extends PerlyPayError {}
/** The request never got an answer: network down, DNS, timeout. */
export class ConnectionError extends PerlyPayError {}
/** A webhook whose signature does not check out. */
export class SignatureVerificationError extends PerlyPayError {}
