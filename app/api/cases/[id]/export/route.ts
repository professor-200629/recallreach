import { handle, exportCase } from '@/lib/recall/server';
type Context = { params: Promise<{ id: string }> };
export const GET = (request: Request, context: Context) => handle(async () => exportCase(request, (await context.params).id));
