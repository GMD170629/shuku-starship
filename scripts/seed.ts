import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

async function main() {
  const email = process.env.ADMIN_EMAIL ?? 'admin@example.com';
  const password = process.env.ADMIN_PASSWORD ?? 'starshipnas';
  const name = process.env.ADMIN_NAME ?? '管理员';
  const passwordHash = hashPassword(password);
  await prisma.user.upsert({
    where: { email },
    create: { email, name, passwordHash, role: 'admin' },
    update: { name, role: 'admin' }
  });

  const settings = {
    systemName: process.env.NEXT_PUBLIC_APP_NAME ?? '书库星舰',
    theme: 'system',
    language: 'zh-CN',
    timezone: process.env.TZ ?? 'Asia/Shanghai'
  };
  await prisma.$transaction(
    Object.entries(settings).map(([key, value]) =>
      prisma.systemSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value }
      })
    )
  );

  console.log(`seed complete: admin=${email}, exampleBookCount=0, checksum=${createHash('sha1').update(email).digest('hex').slice(0, 8)}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
