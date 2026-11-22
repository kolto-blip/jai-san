// Перенос всех файлов в текущее хранилище (например, из Neon в Backblaze B2).
// Сервер делает это сам при запуске; скрипт — для ручного запуска.
import { openRepo } from '../src/db/index.js';
import { createStorages } from '../src/storage/index.js';

const repo = await openRepo();
const storages = createStorages(repo);
console.log(`Мақсат: ${storages.active.name}`);
const n = await storages.migrateAll();
console.log(`Дайын. Тасымалданған файлдар: ${n}`);
await repo.close();
