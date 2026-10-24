import { requireChatGPTUser } from './chatgpt-auth';
import Workspace from '@/components/recall/workspace';
export default async function Home() {
  const user = await requireChatGPTUser('/');
  return <Workspace userName={user.fullName || 'Your workspace'} />;
}
