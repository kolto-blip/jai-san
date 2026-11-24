// Пример: 3 класса и по одному материалу каждого вида.
// Запуск: npm run seed   (повторный запуск ничего не дублирует)
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openRepo } from '../src/db/index.js';
import { createStorages } from '../src/storage/index.js';
import { generateCode, FILE_TYPES, fileExt, todayISO } from '../src/util.js';

const SEED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seed');

export async function seed(repo, storages, log = console.log) {
  if ((await repo.listClasses()).length) {
    log('Сыныптар бар — мысал қосылмады.');
    return null;
  }
  const cls = {};
  for (const name of ['7Ә', '8Ғ', '9А']) {
    let code;
    do code = generateCode(); while (await repo.getClassByCode(code));
    cls[name] = await repo.createClass({ name, code });
  }
  const daysAgo = (n) => {
    const d = new Date(Date.parse(todayISO()) - n * 86400_000);
    return d.toISOString().slice(0, 10);
  };
  async function fileFields(fileName) {
    const buf = await fs.readFile(path.join(SEED_DIR, fileName));
    const key = crypto.randomBytes(16).toString('hex');
    await storages.active.put(key, buf);
    const t = FILE_TYPES[fileExt(fileName)];
    return { kind: t.kind, fileName, fileMime: t.mime, fileSize: buf.length, storage: storages.active.name, storageKey: key };
  }

  const materials = [
    { title: 'Дәреже қасиеттері — конспект', topic: 'Дәреже', date: daysAgo(2), classIds: [cls['8Ғ'].id],
      ...(await fileFields('Дәреже_қасиеттері_конспект.pdf')) },
    { title: 'Сызықтық теңдеулер — үй тапсырмасы №3', topic: 'Теңдеулер', date: daysAgo(1), classIds: [cls['7Ә'].id],
      quiz: { answers: ['5', '3', '9', '5', '150'], open: true, retry: false, show: false },
      ...(await fileFields('Теңдеулер_үй_тапсырмасы_№3.docx')) },
    { title: 'Квадраттық функция — презентация', topic: 'Функциялар', date: daysAgo(12), classIds: [cls['9А'].id],
      ...(await fileFields('Квадраттық_функция.pptx')) },
    { title: 'ЕНТ үлгі нұсқасы — Математика', topic: 'ЕНТ', date: daysAgo(0), allClasses: true,
      ...(await fileFields('ЕНТ_үлгі_нұсқа_математика.pdf')),
      quiz: { answers: ['B', 'A', 'B', 'C', 'A', 'C', 'B', 'ACE', 'BC', 'B'], open: true, retry: true, show: true,
        ent: { subject: 'Математика', minutes: 0, letters: 5 } } },
    { title: 'Дәрежеге кіріспе (Khan Academy)', topic: 'Дәреже', date: daysAgo(4), allClasses: true, kind: 'video',
      url: 'https://www.youtube.com/watch?v=XZRQhkii0h0' },
    { title: 'Desmos — функция графигін салу', topic: 'Функциялар', date: daysAgo(20), kind: 'link',
      classIds: [cls['8Ғ'].id, cls['9А'].id], url: 'https://www.desmos.com/calculator?lang=ru' },
  ];
  for (const m of materials) await repo.createMaterial({ classIds: [], allClasses: false, ...m });

  log('Мысал қосылды. Сынып кодтары:');
  for (const c of Object.values(cls)) log(`  ${c.name}: ${c.code}`);
  return cls;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repo = await openRepo();
  const storages = createStorages(repo);
  await seed(repo, storages);
  await repo.close();
}
