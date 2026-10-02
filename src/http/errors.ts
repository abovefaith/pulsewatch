import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);

/**
 * One consistent error envelope for every failure:
 *   { "error": { "code": "...", "message": "...", "details"?: [...] } }
 * Internal errors are logged in full but never leak details to clients.
 */
export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: {
        code: 'validation_failed',
        message: 'Request validation failed',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
  }

  if (error instanceof HttpError) {
    return reply
      .status(error.statusCode)
      .send({ error: { code: error.code, message: error.message } });
  }

  // Errors Fastify itself raises, e.g. malformed JSON or an oversized body.
  const statusCode = 'statusCode' in error ? error.statusCode : undefined;
  if (statusCode && statusCode >= 400 && statusCode < 500) {
    return reply
      .status(statusCode)
      .send({ error: { code: 'bad_request', message: error.message } });
  }

  request.log.error({ err: error }, 'Unhandled error');
  return reply
    .status(500)
    .send({ error: { code: 'internal_error', message: 'Something went wrong' } });
}
