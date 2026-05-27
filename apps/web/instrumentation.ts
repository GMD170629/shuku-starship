import { assertProductionStartup } from './lib/system-health';

export async function register() {
  await assertProductionStartup();
}
