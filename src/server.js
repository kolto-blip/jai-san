import { createApp } from './app.js';
import { config } from './config.js';

const app = await createApp();

// SEED_DEMO=1 — при первом запуске создать пример (3 класса, 5 материалов).
if (process.env.SEED_DEMO === '1') {
  const { seed } = await import('../scripts/seed.js');
  await seed(app.repo, app.storages);
}

app.server.listen(config.port, () => {
  console.log(`Сайт іске қосылды: http://localhost:${config.port}`);
  console.log(`  Деректер: ${app.repo.kind === 'postgres' ? 'Postgres (DATABASE_URL)' : 'жергілікті папка ' + config.dataDir}`);
  console.log(`  Файлдар қоймасы: ${app.storages.active.name}`);
  if (!config.adminPin) {
    console.log(config.isPublic
      ? '  ! ADMIN_PIN орнатылмаған — мұғалім беті жабық.'
      : '  ADMIN_PIN жоқ — мұғалім беті тек осы компьютерден ашылады: http://localhost:' + config.port + '/admin');
  }
});

// Хранилище сменили (например, на B2) — переносим старые файлы в фоне.
app.storages
  .migrateAll()
  .then((n) => n && console.log(`Файлдар тасымалданды: ${n}`))
  .catch((e) => console.error('Файлдарды тасымалдау қатесі:', e.message));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await app.close().catch(() => {});
    process.exit(0);
  });
}
