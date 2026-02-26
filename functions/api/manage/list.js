const INVALID_PREFIXES = ['session:', 'chunk:', 'upload:', 'temp:'];
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'ico', 'svg', 'heic', 'heif', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogg', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'm4v', '3gp', 'ts']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'ape', 'opus']);

function inferStorageType(name, metadata = {}) {
  const explicit = metadata.storageType || metadata.storage;
  if (explicit) return String(explicit).toLowerCase();

  if (String(name || '').startsWith('r2:')) return 'r2';
  if (String(name || '').startsWith('s3:')) return 's3';
  if (String(name || '').startsWith('discord:')) return 'discord';
  if (String(name || '').startsWith('hf:')) return 'huggingface';
  return 'telegram';
}

function inferFileType(name) {
  const segments = String(name || '').split('.');
  const ext = segments.length > 1 ? segments.pop().toLowerCase() : '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'document';
}

function shouldIncludeKey(key) {
  if (!key?.name) return false;
  if (INVALID_PREFIXES.some((item) => key.name.startsWith(item))) return false;
  const metadata = key.metadata || {};
  return Boolean(metadata.fileName) && metadata.TimeStamp !== undefined && metadata.TimeStamp !== null;
}

function normalizeKey(key) {
  const metadata = key.metadata || {};
  const storageType = inferStorageType(key.name, metadata);
  const fileType = inferFileType(key.name);

  return {
    ...key,
    metadata: {
      ...metadata,
      storageType,
      fileType,
    },
  };
}

function matchStorage(storageType, storageFilter) {
  if (!storageFilter) return true;
  if (storageFilter === 'kv' || storageFilter === 'telegram') return storageType === 'telegram';
  return storageType === storageFilter;
}

async function buildGlobalStats(env, prefix, storageFilter) {
  const stats = {
    total: 0,
    byType: { image: 0, video: 0, audio: 0, document: 0 },
    byStorage: { telegram: 0, r2: 0, s3: 0, discord: 0, huggingface: 0 },
  };

  let cursor = undefined;
  let guard = 0;

  do {
    const page = await env.img_url.list({ limit: 1000, cursor, prefix });
    const keys = page.keys || [];
    for (const key of keys) {
      if (!shouldIncludeKey(key)) continue;
      const normalized = normalizeKey(key);
      const storageType = normalized.metadata.storageType;
      if (!matchStorage(storageType, storageFilter)) continue;

      const fileType = normalized.metadata.fileType || 'document';
      stats.total += 1;
      if (Object.prototype.hasOwnProperty.call(stats.byType, fileType)) {
        stats.byType[fileType] += 1;
      } else {
        stats.byType.document += 1;
      }
      if (Object.prototype.hasOwnProperty.call(stats.byStorage, storageType)) {
        stats.byStorage[storageType] += 1;
      }
    }

    cursor = page.list_complete ? undefined : page.cursor;
    guard += 1;
  } while (cursor && guard < 10000);

  return stats;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const raw = url.searchParams.get('limit');
  let limit = parseInt(raw || '100', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  if (limit > 1000) limit = 1000;

  const cursor = url.searchParams.get('cursor') || undefined;
  const prefix = url.searchParams.get('prefix') || undefined;
  const storageFilter = (url.searchParams.get('storage') || '').toLowerCase();
  const includeStats = ['1', 'true', 'yes'].includes(
    (url.searchParams.get('includeStats') || url.searchParams.get('stats') || '').toLowerCase()
  );

  const value = await env.img_url.list({ limit, cursor, prefix });

  const normalizedKeys = (value.keys || [])
    .filter(shouldIncludeKey)
    .map(normalizeKey);

  const filteredKeys = normalizedKeys.filter((key) =>
    matchStorage(key.metadata?.storageType, storageFilter)
  );

  const payload = {
    ...value,
    keys: filteredKeys,
    pageCount: filteredKeys.length,
  };

  if (includeStats) {
    payload.stats = await buildGlobalStats(env, prefix, storageFilter);
  }

  return new Response(
    JSON.stringify(payload),
    {
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
