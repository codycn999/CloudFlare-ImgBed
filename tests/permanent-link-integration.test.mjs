import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDatabase } from '../functions/utils/databaseAdapter.js';
import { onRequest as readFile } from '../functions/file/[[path]].js';
import { onRequest as renameFile } from '../functions/api/manage/rename/[[path]].js';
import { onRequest as moveFile } from '../functions/api/manage/move/[[path]].js';
import { onRequest as initializeIdentity } from '../functions/api/manage/identity/[[path]].js';

function fixture() {
    const map = new Map();
    const env = { TG_BOT_TOKEN: '123:test', TG_CHAT_ID: '-100123', img_url: {
        get: async key => map.get(key)?.value ?? null,
        getWithMetadata: async key => structuredClone(map.get(key) || { value: null, metadata: null }),
        put: async (key, value, options = {}) => map.set(key, structuredClone({ value, metadata: options.metadata || null })),
        delete: async key => map.delete(key),
        list: async ({ prefix = '' } = {}) => ({ keys: [...map].filter(([k]) => k.startsWith(prefix)).map(([name, r]) => ({ name, metadata: r.metadata })), list_complete: true })
    } };
    const tasks = [];
    const context = (path, method = 'GET', body, query = '') => ({ env,
        params: { path: path.split('/') },
        request: new Request(`https://test.example/file/${path}${query}`, {
            method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {})
        }), data: {}, waitUntil: task => tasks.push(task) });
    return { env, map, tasks, context, db: getDatabase(env) };
}

test('real read, rename and move handlers serve identical image bytes through all reference forms', async () => {
    const f = fixture(); const originalFetch = globalThis.fetch; const originalCaches = globalThis.caches;
    const bytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
    const purged = [];
    Object.assign(f.env, { CF_ZONE_ID: 'test-zone', CF_EMAIL: 'test@example.com', CF_API_KEY: 'test-only' });
    globalThis.caches = { default: { put: async () => {} } };
    globalThis.fetch = async (input, options = {}) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes('/getFile?')) return Response.json({ ok: true, result: { file_path: 'photo/test.png' } });
        if (url.includes('/file/bot')) return new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
        if (url.includes('BlockImg.png')) return new Response('blocked', { status: 200 });
        if (url.includes('api.cloudflare.com/')) { purged.push(...JSON.parse(options.body).files); return Response.json({ success: true }); }
        throw new Error(`Unexpected outbound request: ${url}`);
    };
    try {
        await f.db.put('Telegram/test.png', '', { metadata: {
            FileName: '测试.png', FileType: 'image/png', TimeStamp: 1700000000000,
            Channel: 'TelegramNew', ChannelName: 'Telegram_env', TgFileId: 'photo',
            ListType: 'None', Label: 'None', Directory: 'Telegram/', FileSize: '0.01'
        } });
        const detail = await initializeIdentity(f.context('Telegram/test.png', 'POST'));
        assert.equal(detail.status, 200);
        const { fixedId } = await detail.json();
        const renamed = await renameFile(f.context('Telegram/test.png', 'POST', { newFileId: 'Telegram/renamed.png' }));
        assert.equal(renamed.status, 200, await renamed.clone().text());
        assert.equal((await renamed.json()).metadata.FixedId, fixedId);
        const moved = await moveFile(f.context('Telegram/renamed.png', 'GET', undefined, '?dist=archive'));
        assert.equal(moved.status, 200, await moved.clone().text());
        await Promise.all(f.tasks);
        assert.ok(purged.includes(`https://test.example/file/${fixedId}`));
        assert.ok(purged.includes('https://test.example/file/Telegram/test.png'));
        assert.ok(purged.includes('https://test.example/file/archive/renamed.png'));
        for (const path of [fixedId, 'Telegram/test.png', 'Telegram/renamed.png', 'archive/renamed.png']) {
            const response = await readFile(f.context(path));
            assert.equal(response.status, 200, path);
            assert.equal(response.headers.get('Content-Type'), 'image/png');
            assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
        }
        // The fixed route must still respect the current file's blacklist.
        const record = await f.db.getWithMetadata('archive/renamed.png');
        record.metadata.ListType = 'Block';
        await f.db.put('archive/renamed.png', record.value, { metadata: record.metadata });
        assert.equal((await readFile(f.context(fixedId))).status, 403);
        await f.db.delete('archive/renamed.png');
        assert.equal((await readFile(f.context(fixedId))).status, 404);
        assert.equal((await readFile(f.context('Telegram/test.png'))).status, 404);
    } finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
});
