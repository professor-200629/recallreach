import { handle, integrations, checkIntegration } from '@/lib/recall/server';
export const GET = (request: Request) => handle(() => integrations(request));
export const POST = (request: Request) => handle(() => checkIntegration(request));
