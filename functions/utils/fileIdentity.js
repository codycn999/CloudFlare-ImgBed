const ID_PREFIX = 'manage@identity@id@';
const PATH_PREFIX = 'manage@identity@path@';
const HISTORY_PREFIX = 'manage@identity@paths@';
export const isFixedId = value => /^f_[a-f0-9]{32}$/.test(value || '');
const isFile = (key, metadata) => !key.startsWith('manage@') && metadata &&
    metadata.TimeStamp != null && metadata.Channel;

async function hash(value) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
const aliasKey = async path => PATH_PREFIX + await hash(path);

// Registry entries live in settings, keeping aliases out of file lists and statistics.
// An alias always points to a fixed ID; that ID points directly to the current path.
export function withFileIdentity(db) {
    const rawPut = db.put.bind(db);
    const rawGet = db.get.bind(db);
    const rawGetWithMetadata = db.getWithMetadata.bind(db);

    db.isPathReserved = async (path, allowedId = '') => {
        if (isFixedId(path) && path !== allowedId) return true;
        const owner = await rawGet(await aliasKey(path));
        return !!owner && owner !== allowedId;
    };

    db.put = async (key, value, options = {}) => {
        if (!isFile(key, options.metadata)) return rawPut(key, value, options);
        const metadata = options.metadata;
        const existing = await rawGetWithMetadata(key);
        // The identity of an existing file cannot be changed by metadata updates.
        if (isFixedId(existing?.metadata?.FixedId)) metadata.FixedId = existing.metadata.FixedId;
        if (!isFixedId(metadata.FixedId)) {
            // Deterministic lazy initialization prevents concurrent first views from
            // assigning two IDs to the same legacy record. New uploads have unique keys/times.
            const seed = JSON.stringify([key, metadata.TimeStamp, metadata.Channel,
                metadata.TgFileId || '', metadata.S3FileKey || '']);
            metadata.FixedId = 'f_' + (await hash(seed)).slice(0, 32);
        }
        const pathKey = await aliasKey(key);
        const owner = await rawGet(pathKey);
        if (owner && owner !== metadata.FixedId) throw new Error('Path is reserved by an existing reference');
        if (isFixedId(key)) throw new Error('Fixed IDs cannot be used as editable file paths');
        const previousPaths = JSON.parse(await rawGet(HISTORY_PREFIX + metadata.FixedId) || '[]');
        const paths = [...new Set([...previousPaths, key])];
        await rawPut(key, value, options);
        // Publish the locator after the destination record has been persisted.
        const currentPath = await rawGet(ID_PREFIX + metadata.FixedId);
        if (currentPath !== key) await rawPut(ID_PREFIX + metadata.FixedId, key);
        if (owner !== metadata.FixedId) await rawPut(pathKey, metadata.FixedId);
        if (paths.length !== previousPaths.length) await rawPut(HISTORY_PREFIX + metadata.FixedId, JSON.stringify(paths));
    };

    db.ensureFileIdentity = async path => {
        const record = await rawGetWithMetadata(path);
        if (!record?.metadata || !isFile(path, record.metadata)) return record;
        if (!isFixedId(record.metadata.FixedId) || await rawGet(ID_PREFIX + record.metadata.FixedId) !== path) {
            await db.put(path, record.value, { metadata: record.metadata });
        }
        return record;
    };

    // Reserve historical paths, including deleted files: an old link must never
    // silently serve a different newly uploaded file with the same name.
    db.get = async (key, options) => {
        const value = await rawGet(key, options);
        if (value !== null || key.startsWith('manage@')) return value;
        return await db.isPathReserved(key) ? '' : null;
    };
    return db;
}

export async function getReferencePaths(db, path) {
    const id = isFixedId(path) ? path : await db.get(await aliasKey(path));
    if (!isFixedId(id)) return [path];
    const paths = JSON.parse(await db.get(HISTORY_PREFIX + id) || '[]');
    return [...new Set([path, id, ...paths])];
}

export async function resolveFilePath(db, requestedPath) {
    if (!isFixedId(requestedPath)) {
        const direct = await db.getWithMetadata(requestedPath);
        if (direct?.metadata) return requestedPath;
    }
    const id = isFixedId(requestedPath) ? requestedPath : await db.get(await aliasKey(requestedPath));
    if (!isFixedId(id)) return isFixedId(requestedPath) ? null : requestedPath;
    const path = await db.get(ID_PREFIX + id);
    if (!path) return null;
    const record = await db.getWithMetadata(path);
    return record?.metadata?.FixedId === id ? path : null;
}
