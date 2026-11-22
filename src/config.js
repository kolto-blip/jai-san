import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT) || 3000,
  databaseUrl: env.DATABASE_URL || '',
  adminPin: (env.ADMIN_PIN || '').trim(),
  dataDir: path.resolve(env.DATA_DIR || 'data'),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  // Сайт «в интернете»: на Render, в production или с облачной базой.
  isPublic: Boolean(env.RENDER || env.NODE_ENV === 'production' || env.DATABASE_URL),
  // Явный выбор хранилища файлов: db | local | b2. Пусто — выбор автоматически.
  storage: (env.STORAGE || '').trim().toLowerCase(),
  b2: {
    keyId: env.B2_KEY_ID || '',
    key: env.B2_KEY || '',
    bucket: env.B2_BUCKET || '',
    endpoint: (env.B2_ENDPOINT || '').replace(/\/+$/, ''),
  },
  maxFileBytes: 20 * 1024 * 1024,
  storageLimitMb: Number(env.STORAGE_LIMIT_MB) || 0, // 0 — по умолчанию для хранилища
  rateLimit: {
    codeFailures: Number(env.CODE_MAX_FAILS) || 20, // неверных кодов с одного IP
    pinFailures: Number(env.PIN_MAX_FAILS) || 5, // неверных PIN с одного IP
    windowMs: 15 * 60 * 1000,
  },
  timeZone: env.TZ_SCHOOL || 'Asia/Almaty',
};

export function activeStorageName() {
  if (config.storage) return config.storage;
  if (config.b2.keyId && config.b2.key && config.b2.bucket) return 'b2';
  return config.databaseUrl ? 'db' : 'local';
}
