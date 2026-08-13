import { randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { RequestContextStore } from './request-context';

/**
 * Establishes the per-request AsyncLocalStorage context for every inbound
 * request, applied globally in AppModule (§3.5, §9.3).
 *
 * Phase 0: seeds only `requestId` (correlation ID). Phase 1's auth guard
 * will extend the running context with userId/organizationId/membershipId
 * /roles once session verification exists — this middleware does not
 * change when that happens, it just runs first in the chain.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    res.setHeader('x-request-id', requestId);

    RequestContextStore.run({ requestId }, () => next());
  }
}
