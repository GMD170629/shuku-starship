import { spawnSync } from 'node:child_process';

const steps = [
  ['pnpm', ['install', '--frozen-lockfile']],
  ['pnpm', ['--filter', '@shuku/database', 'prisma:generate']],
  ['pnpm', ['typecheck']],
  ['pnpm', ['build']]
];

for (const [command, args] of steps) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('\nMVP acceptance commands completed.');
