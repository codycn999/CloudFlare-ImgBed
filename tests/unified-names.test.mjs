import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDatabase } from '../functions/utils/databaseAdapter.js';
import { resolveFilePath } from '../functions/utils/fileIdentity.js';
import { onRequest as editMetadata } from '../functions/api/manage/metadata/[[path]].js';
import { onRequest as renameFile } from '../functions/api/manage/rename/[[path]].js';
import { onRequest as normalizeNames } from '../functions/api/manage/normalizeNames.js';
import { buildUniqueFileId } from '../functions/upload/uploadTools.js';
import { onRequestPost as restoreBatch } from '../functions/api/manage/batch/restore/chunk.js';

function fixture() {
    const map = new Map(); const tasks = [];
    const env = { img_url: {
        get: async key => map.get(key)?.value ?? null,
        getWithMetadata: async key => structuredClone(map.get(key) || { value: null, metadata: null }),
        put: async (key, value, options = {}) => map.set(key, structuredClone({ value, metadata: options.metadata || null })),
        delete: async key => map.delete(key),
        list: async ({ limit = 1000, cursor = '', prefix = '' } = {}) => {
            const keys = [...map.keys()].filter(key => key.startsWith(prefix) && key > cursor).sort();
            return { keys: keys.slice(0, limit).map(name => ({ name, metadata: map.get(name).metadata })),
                cursor: keys.length > limit ? keys[limit - 1] : null, list_complete: keys.length <= limit };
        }
    } };
    const db = getDatabase(env);
    const context = (path, body, method = 'POST') => ({ env, params: { path: path.split('/').map(encodeURIComponent) },
        request: new Request('https://test.example/api/manage/test', { method,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        waitUntil: task => tasks.push(task), data: {} });
    const create = async (path, name) => {
        const metadata = { FileName: name, Channel: 'TelegramNew', ChannelName: 'Telegram_env', TgFileId: path,
            TimeStamp: 1700000000000, FileType: 'image/png', Directory: path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '', Label: 'None' };
        await db.put(path, '', { metadata }); return metadata.FixedId;
    };
    return { db, map, env, tasks, context, create };
}

globalThis.caches = { default: { put: async () => {} } };

test('editing a display name renames the path in place and preserves every reference', async () => {
    const f = fixture(); const id = await f.create('photos/old.png', 'old.png');
    const result = await editMetadata(f.context('photos/old.png', { FileName: '海边日落.png', FileType: 'image/png' }, 'PATCH'));
    assert.equal(result.status, 200, await result.clone().text());
    const data = await result.json();
    assert.equal(data.newFileId, 'photos/海边日落.png');
    assert.equal(data.metadata.FileName, '海边日落.png');
    assert.equal(data.metadata.FixedId, id);
    assert.equal(await resolveFilePath(f.db, 'photos/old.png'), 'photos/海边日落.png');
    assert.equal(await resolveFilePath(f.db, id), 'photos/海边日落.png');
    await Promise.all(f.tasks);
});

test('the legacy rename API cannot move between folders or accept path traversal', async () => {
    const f = fixture(); await f.create('photos/old.png', 'old.png');
    for (const body of [{ newFileId: 'archive/new.png' }, { newFileName: '../new.png' }, { newFileName: 'nested/new.png' }]) {
        assert.equal((await renameFile(f.context('photos/old.png', body))).status, 400);
    }
    assert.ok((await f.db.getWithMetadata('photos/old.png')).metadata);
});

test('saving an unchanged name changes attributes without deleting the file', async () => {
    const f = fixture(); const id = await f.create('photos/old.png', 'old.png');
    const result = await editMetadata(f.context('photos/old.png', { FileName: 'old.png', FileType: 'image/webp' }, 'PATCH'));
    assert.equal(result.status, 200);
    const record = await f.db.getWithMetadata('photos/old.png');
    assert.equal(record.metadata.FileType, 'image/webp');
    assert.equal(record.metadata.FixedId, id);
    await Promise.all(f.tasks);
});

test('a conflicting manual name returns 409 and preserves both files', async () => {
    const f = fixture(); await f.create('photos/a.png', 'a.png'); await f.create('photos/b.png', 'b.png');
    const result = await editMetadata(f.context('photos/a.png', { FileName: 'b.png' }, 'PATCH'));
    assert.equal(result.status, 409);
    assert.ok((await f.db.getWithMetadata('photos/a.png')).metadata);
    assert.ok((await f.db.getWithMetadata('photos/b.png')).metadata);
});

test('legacy migration follows displayed names, numbers duplicates and reports unsafe names', async () => {
    const f = fixture();
    const a = await f.create('photos/001.png', '假期.png');
    const b = await f.create('photos/002.png', '假期.png');
    await f.create('photos/003.png', '../bad.png');
    let state;
    for (let batch = 0; batch < 20; batch++) {
        const result = await normalizeNames(f.context('', {}));
        assert.equal(result.status, 200);
        state = await result.json(); if (state.done) break;
    }
    assert.equal(state.done, true);
    assert.equal(state.renamed, 2);
    assert.equal(state.conflictsResolved, 1);
    assert.equal(state.skipped, 1);
    assert.equal((await f.db.getWithMetadata('photos/假期.png')).metadata.FileName, '假期.png');
    assert.equal((await f.db.getWithMetadata('photos/假期 (2).png')).metadata.FileName, '假期 (2).png');
    assert.equal(await resolveFilePath(f.db, a), 'photos/假期.png');
    assert.equal(await resolveFilePath(f.db, b), 'photos/假期 (2).png');
    const repeated = await (await normalizeNames(f.context('', {}))).json();
    assert.equal(repeated.renamed, 2);
});

test('new upload paths use the filename rather than a timestamp or random naming setting', async () => {
    const f = fixture();
    const context = { env: f.env, url: new URL('https://test.example/upload?uploadFolder=photos&uploadNameType=short') };
    assert.equal(await buildUniqueFileId(context, 'my picture.png', 'image/png'), 'photos/my picture.png');
    await f.create('photos/my picture.png', 'my picture.png');
    const next = await buildUniqueFileId(context, 'my picture.png', 'image/png');
    assert.equal(next, 'photos/my picture (2).png');
    await f.db.put(next, '', { metadata: { FileName: 'my picture.png', NamePolicyVersion: 1,
        Channel: 'TelegramNew', TimeStamp: 1800000000000 } });
    assert.equal((await f.db.getWithMetadata(next)).metadata.FileName, 'my picture (2).png');
});

test('restoring an old backup schedules filename normalization again', async () => {
    const f = fixture();
    await normalizeNames(f.context('', {}));
    assert.ok(await f.db.get('manage@migration@unifiedNames@v1'));
    const response = await restoreBatch(f.context('', { type: 'files', data: {
        'photos/old.png': { metadata: { FileName: 'restored.png', Channel: 'TelegramNew', TimeStamp: 1700000000000 } }
    } }));
    assert.equal(response.status, 200);
    assert.equal(await f.db.get('manage@migration@unifiedNames@v1'), null);
    let state;
    for (let batch = 0; batch < 20; batch++) {
        state = await (await normalizeNames(f.context('', {}))).json();
        if (state.done) break;
    }
    assert.equal(state.renamed, 1);
    assert.equal((await f.db.getWithMetadata('photos/restored.png')).metadata.FileName, 'restored.png');
});
