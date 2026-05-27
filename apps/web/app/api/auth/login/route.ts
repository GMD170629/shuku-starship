import { createSession, ensureAdminUser, verifyPassword } from '../../../../lib/auth';
import { fail, ok, readJson } from '../../../../lib/http';
import { prisma } from '../../../../lib/prisma';

export async function POST(request: Request) {
  const body = await readJson<{ email?: string; username?: string; password?: string }>(request);
  const login = body.email ?? body.username ?? '';
  const password = body.password ?? '';
  if (!login || !password) return fail('请输入账号和密码', 400);

  await ensureAdminUser();
  const user = await prisma.user.findFirst({
    where: {
      OR: [{ email: login }, { name: login }]
    }
  });
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return fail('账号或密码错误', 401);
  }
  await createSession(user.id);
  return ok({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
}
