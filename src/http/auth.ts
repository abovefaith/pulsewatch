import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { HttpError } from './errors.ts';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/**
 * Returns a preHandler hook that requires the API key via
 * `Authorization: Bearer <key>` or `X-API-Key: <key>`.
 *
 * Both sides are hashed first so `timingSafeEqual` always compares equal-length
 * buffers — this avoids leaking the key through response timing *and* its length.
 */
export function requireApiKey(apiKey: string) {
  const expected = sha256(apiKey);

  return async function authenticate(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    const provided = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : request.headers['x-api-key'];

    if (typeof provided !== 'string' || provided.length === 0) {
      throw new HttpError(401, 'unauthorized', 'Missing API key');
    }
    if (!timingSafeEqual(sha256(provided), expected)) {
      throw new HttpError(401, 'unauthorized', 'Invalid API key');
    }
  };
}
