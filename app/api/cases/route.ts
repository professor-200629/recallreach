import { handle, listCases, createCase } from '@/lib/recall/server';
export const GET = (request: Request) => handle(() => listCases(request));
export const POST = (request: Request) => handle(() => createCase(request));
