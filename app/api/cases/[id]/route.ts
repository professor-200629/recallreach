import { handle, getCase, changeCase } from '@/lib/recall/server';
type Context = { params: Promise<{ id: string }> };
export const GET = (request: Request, context: Context) => handle(async () => getCase(request, (await context.params).id));
export const POST = (request: Request, context: Context) => handle(async () => changeCase(request, (await context.params).id));
