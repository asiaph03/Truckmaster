import { SetMetadata } from '@nestjs/common';

/** Marks a route as reachable without an authenticated session — login, activate, health, etc. */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
