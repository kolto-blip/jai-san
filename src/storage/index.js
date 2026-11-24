import fs from 'node:fs/promises';
import path from 'node:path';
import { config, activeStorageName } from '../config.js';
import { createB2Storage } from './b2.js';

// Каждый материал помнит, в каком хранилище лежит его файл (поле storage),
// поэтому после смены хранилища старые файлы читаются, пока их не перенесут.
export function createStorages(repo) {
  const backends = {};

  backends.local = {
    name: 'local',
    dir: path.join(config.dataDir, 'files'),
    async put(key, buf) {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(path.join(this.dir, key), buf);
    },
    async get(key) {
      return fs.readFile(path.join(this.dir, key));
    },
    async del(key) {
      await fs.rm(path.join(this.dir, key), { force: true });
    },
  };

  if (repo.pool) {
    const pool = repo.pool;
    backends.db = {
      name: 'db',
      async put(key, buf) {
        await pool.query('INSERT INTO files(key,data) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET data=$2', [key, buf]);
      },
      async get(key) {
        const { rows } = await pool.query('SELECT data FROM files WHERE key=$1', [key]);
        if (!rows[0]) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        return rows[0].data;
      },
      async del(key) {
        await pool.query('DELETE FROM files WHERE key=$1', [key]);
      },
    };
  }

  const { keyId, key, bucket } = config.b2;
  if (keyId && key && bucket) backends.b2 = createB2Storage(config.b2);

  const activeName = activeStorageName();
  if (!backends[activeName]) {
    throw new Error(`STORAGE=${activeName} қолжетімсіз (db үшін DATABASE_URL, b2 үшін B2_KEY_ID, B2_KEY, B2_BUCKET керек)`);
  }

  const defaultLimitMb = { db: 1024, local: 1024, b2: 10240 }[activeName];

  return {
    active: backends[activeName],
    limitMb: config.storageLimitMb || defaultLimitMb,
    get(name) {
      const b = backends[name];
      if (!b) throw new Error(`Хранилище «${name}» не настроено`);
      return b;
    },
    // Перенос всех файлов в активное хранилище: копия → запись в базе → удаление старой копии.
    async migrateAll(log = console.log) {
      const target = backends[activeName];
      let moved = 0;
      for (const m of await repo.listMaterials()) {
        if (!m.storage || m.storage === target.name) continue;
        const src = backends[m.storage];
        if (!src) {
          log(`  ! #${m.id}: хранилище «${m.storage}» недоступно, пропуск`);
          continue;
        }
        const buf = await src.get(m.storageKey);
        await target.put(m.storageKey, buf);
        await repo.updateMaterial(m.id, { storage: target.name });
        await src.del(m.storageKey).catch(() => {});
        moved++;
        log(`  → #${m.id} «${m.fileName}» перенесён: ${src.name} → ${target.name}`);
      }
      for (const f of await repo.listAllSubmissionFiles()) {
        if (f.storage === target.name) continue;
        const src = backends[f.storage];
        if (!src) continue;
        await target.put(f.storageKey, await src.get(f.storageKey));
        await repo.setSubmissionFileStorage(f.id, target.name);
        await src.del(f.storageKey).catch(() => {});
        moved++;
      }
      // картинки вопросов ЕНТ (хранятся в ключе материала)
      for (const m of await repo.listMaterials()) {
        const qs = m.quiz?.ent?.questions;
        if (!qs?.some((x) => x.img && x.img.storage !== target.name)) continue;
        for (const x of qs) {
          if (!x.img || x.img.storage === target.name || !backends[x.img.storage]) continue;
          const src = backends[x.img.storage];
          await target.put(x.img.key, await src.get(x.img.key));
          await src.del(x.img.key).catch(() => {});
          x.img.storage = target.name;
          moved++;
        }
        await repo.updateMaterial(m.id, { quiz: m.quiz });
      }
      if (moved) log(`  → барлығы тасымалданды (оқушы фотолары да): ${moved}`);
      return moved;
    },
  };
}
