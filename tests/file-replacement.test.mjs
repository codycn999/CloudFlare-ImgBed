import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../functions/utils/databaseAdapter.js';
import { resolveFilePath } from '../functions/utils/fileIdentity.js';
import { onRequest as replace } from '../functions/api/manage/replace/[[path]].js';
import { onRequest as read } from '../functions/file/[[path]].js';
import { onRequest as rename } from '../functions/api/manage/rename/[[path]].js';
import { onRequest as move } from '../functions/api/manage/move/[[path]].js';
import { onRequest as remove } from '../functions/api/manage/delete/[[path]].js';
import { cloneReplacementContent } from '../functions/utils/replacementStorage.js';
import { S3Client } from '@aws-sdk/client-s3';
import { DiscordAPI } from '../functions/utils/storage/discordAPI.js';
import { HuggingFaceAPI } from '../functions/utils/storage/huggingfaceAPI.js';

let originalFetch, originalCaches, purged;
beforeEach(() => {
    originalFetch = globalThis.fetch; originalCaches = globalThis.caches; purged = [];
    globalThis.caches = { default: { put: async () => {} } };
    globalThis.fetch = async (input, options = {}) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes('api.cloudflare.com/')) { purged.push(...JSON.parse(options.body).files); return Response.json({ success: true }); }
        if (url.includes('/getFile?')) return Response.json({ ok: true, result: { file_path: new URL(url).searchParams.get('file_id') } });
        if (url.includes('/file/bot')) return new Response(url.endsWith('/new') ? 'new image' : 'old image');
        throw new Error('Unexpected outbound request: ' + url);
    };
});
afterEach(() => { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; });

function fixture(engine = 'KV') {
    const map = new Map(); const objects = new Map(); const tasks = [];
    const env = { TG_BOT_TOKEN: '123:test', TG_CHAT_ID: '-100123',
        CF_ZONE_ID: 'test-zone', CF_EMAIL: 'test@example.com', CF_API_KEY: 'test-only' };
    if (engine === 'KV') env.img_url = {
        get: async key => map.get(key)?.value ?? null,
        getWithMetadata: async key => structuredClone(map.get(key) || { value: null, metadata: null }),
        put: async (key, value, options = {}) => map.set(key, structuredClone({ value, metadata: options.metadata || null })),
        delete: async key => map.delete(key),
        list: async ({ prefix = '' } = {}) => ({ keys: [...map].filter(([k]) => k.startsWith(prefix)).map(([name, r]) => ({ name, metadata: r.metadata })), list_complete: true })
    };
    else {
        const sqlite = new DatabaseSync(':memory:');
        sqlite.exec(readFileSync(new URL('../database/init.sql', import.meta.url), 'utf8'));
        env.img_d1 = { prepare(sql) {
            let args = []; const statement = {
                bind(...values) { args = values.map(v => v === undefined ? null : typeof v === 'boolean' ? Number(v) : v); return statement; },
                async first() { return sqlite.prepare(sql).get(...args) || null; },
                async run() { return sqlite.prepare(sql).run(...args); },
                async all() { return { results: sqlite.prepare(sql).all(...args) }; }
            }; return statement;
        } };
    }
    env.img_r2 = {
        get: async (key, options = {}) => {
            if (!objects.has(key)) return null;
            const bytes = objects.get(key); const range = options.range;
            const body = range ? bytes.slice(range.offset, range.offset + (range.length || bytes.length)) : bytes;
            return { body, size: bytes.length, httpMetadata: {}, customMetadata: {},
                writeHttpMetadata() {}, ...(range ? { range: { offset: range.offset, length: body.length } } : {}) };
        },
        put: async (key, body) => objects.set(key, new Uint8Array(await new Response(body).arrayBuffer())),
        delete: async key => objects.delete(key)
    };
    const db = getDatabase(env);
    const context = (path, method = 'POST', body, query = '', headers = {}) => ({ env, data: {}, params: { path: path.split('/') },
        request: new Request(`https://test.example/file/${path}${query}`, { method, headers: { 'Content-Type': 'application/json', ...headers },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), waitUntil: task => tasks.push(task) });
    const add = async (path, overrides = {}, value = '') => {
        await db.put(path, value, { metadata: { Channel: 'TelegramNew', ChannelName: 'Telegram_env', TgFileId: path.startsWith('source') ? 'new' : 'old',
            FileName: path.split('/').pop(), FileType: 'image/png', TimeStamp: 1700000000000,
            FileSize: '0.01', FileSizeBytes: 8, Directory: path.split('/').slice(0, -1).join('/') + '/',
            Tags: ['target-tag'], ListType: 'None', Label: 'None', NamePolicyVersion: 1, ...overrides } });
        return (await db.getWithMetadata(path)).metadata.FixedId;
    };
    const run = (deleteSource = false, extra = {}, headers = {}) => replace(context('source/new.png', 'POST', {
        target: 'target/old.png', deleteSource, expectedSourcePath: 'source/new.png', expectedTargetPath: 'target/old.png', ...extra
    }, '', headers));
    return { map, objects, tasks, env, db, context, add, run };
}

for (const engine of ['KV', 'D1']) {
    for (const deletion of [false, true]) test(`${engine}: replacement keeps target links and metadata, deleteSource=${deletion}`, async () => {
        const f = fixture(engine);
        const sourceId = await f.add('source/new.png', { Tags: ['source-tag'], Width: 2, Height: 3 });
        const targetId = await f.add('target/original.png', { Width: 99, Height: 99 });
        assert.equal((await rename(f.context('target/original.png', 'POST', { newFileName: 'old.png' }))).status, 200);
        const old = await f.db.getWithMetadata('target/old.png');
        const response = await f.run(deletion);
        assert.equal(response.status, 200, await response.clone().text());
        const result = await response.json();
        assert.equal(result.sourceDeleted, deletion); assert.equal(result.fixedId, targetId); assert.deepEqual(result.warnings, []);
        const target = await f.db.getWithMetadata('target/old.png');
        for (const key of ['FixedId', 'FileName', 'Directory', 'Tags', 'TimeStamp', 'ListType']) assert.deepEqual(target.metadata[key], old.metadata[key], key);
        assert.equal(target.metadata.Width, 2); assert.equal(target.metadata.Height, 3);
        assert.equal(target.metadata.TgFileId, 'new'); assert.ok(target.metadata.ContentVersion);
        for (const path of [targetId, 'target/original.png', 'target/old.png']) {
            const content = await read(f.context(path, 'GET'));
            assert.equal(content.status, 200); assert.equal(await content.text(), 'new image');
            assert.ok(purged.includes('https://test.example/file/' + path));
        }
        assert.equal(await resolveFilePath(f.db, sourceId), deletion ? null : 'source/new.png');
        assert.equal((await read(f.context(sourceId, 'GET'))).status, deletion ? 404 : 200);
        await Promise.all(f.tasks);
    });
}

test('R2 content is independent after copy and subsequent source deletion; rename/move/range/delete work', async () => {
    const f = fixture();
    const source = await f.add('source/new.png', { Channel: 'CloudflareR2' });
    const target = await f.add('target/old.png', { Channel: 'CloudflareR2', Width: 77, Height: 99 });
    await f.env.img_r2.put('source/new.png', 'new image'); await f.env.img_r2.put('target/old.png', 'old image');
    assert.equal((await f.run()).status, 200);
    const snapshot = await f.db.getWithMetadata('target/old.png');
    assert.ok(snapshot.metadata.R2FileKey); assert.equal(snapshot.metadata.Width, undefined);
    assert.equal(f.objects.has('target/old.png'), false);
    assert.equal((await remove(f.context('source/new.png', 'DELETE'))).status, 200);
    assert.equal((await read(f.context(source, 'GET'))).status, 404);
    assert.equal(await (await read(f.context(target, 'GET'))).text(), 'new image');
    const range = await read(f.context(target, 'GET', undefined, '', { Range: 'bytes=0-2' }));
    assert.equal(range.status, 206); assert.equal(await range.text(), 'new');
    assert.equal((await rename(f.context('target/old.png', 'POST', { newFileName: 'renamed.png' }))).status, 200);
    assert.equal((await move(f.context('target/renamed.png', 'GET', undefined, '?dist=archive'))).status, 200);
    assert.equal(await (await read(f.context(target, 'GET'))).text(), 'new image');
    assert.equal((await remove(f.context('archive/renamed.png', 'DELETE'))).status, 200);
    assert.equal(f.objects.size, 0); await Promise.all(f.tasks);
});

test('self, folders, mismatched types, stale versions and moved selections leave content intact', async () => {
    const f = fixture(); await f.add('source/new.png'); await f.add('target/old.png');
    for (const [extra, status] of [
        [{ target: 'source/new.png', expectedTargetPath: 'source/new.png' }, 400],
        [{ target: 'target/' }, 404], [{ target: 'missing.png' }, 404],
        [{ expectedSourcePath: 'previous.png' }, 409], [{ targetVersion: 'stale' }, 409], [{ deleteSource: 'false' }, 400]
    ]) {
        const before = await f.db.getWithMetadata('target/old.png');
        assert.equal((await f.run(false, extra)).status, status);
        assert.deepEqual(await f.db.getWithMetadata('target/old.png'), before);
    }
    const record = await f.db.getWithMetadata('target/old.png'); record.metadata.FileType = 'application/pdf';
    await f.db.put('target/old.png', record.value, { metadata: record.metadata });
    assert.equal((await f.run()).status, 400);
    assert.equal((await replace(f.context('source/new.png', 'GET'))).status, 405);
});

test('PDF replacement updates document bytes and size without changing the published address', async () => {
    const f = fixture(); await f.add('source/new.png', { FileType: 'application/pdf', Channel: 'CloudflareR2', FileSizeBytes: 8 });
    const id = await f.add('target/old.png', { FileType: 'application/pdf', Channel: 'CloudflareR2' });
    await f.env.img_r2.put('source/new.png', '%PDF-new'); await f.env.img_r2.put('target/old.png', '%PDF-old');
    assert.equal((await f.run(true)).status, 200);
    const response = await read(f.context(id, 'GET'));
    assert.equal(response.headers.get('Content-Type'), 'application/pdf'); assert.equal(await response.text(), '%PDF-new');
    assert.equal((await f.db.getWithMetadata('target/old.png')).metadata.FileSizeBytes, 8);
});

test('copy failure preserves both files and old target bytes', async () => {
    const f = fixture(); await f.add('source/new.png', { Channel: 'CloudflareR2' }); await f.add('target/old.png', { Channel: 'CloudflareR2' });
    await f.env.img_r2.put('source/new.png', 'new image'); await f.env.img_r2.put('target/old.png', 'old image');
    const before = await f.db.getWithMetadata('target/old.png');
    f.env.img_r2.put = async () => { throw new Error('test-copy-failure'); };
    assert.equal((await f.run(true)).status, 500);
    assert.deepEqual(await f.db.getWithMetadata('target/old.png'), before);
    assert.equal(new TextDecoder().decode(f.objects.get('target/old.png')), 'old image');
    assert.ok((await f.db.getWithMetadata('source/new.png')).metadata);
});

test('a source changed during staging is retained and staged bytes are rolled back', async () => {
    const f = fixture(); await f.add('source/new.png', { Channel: 'CloudflareR2' }); await f.add('target/old.png');
    await f.env.img_r2.put('source/new.png', 'new image');
    const put = f.env.img_r2.put;
    f.env.img_r2.put = async (...args) => {
        await put(...args);
        const source = await f.db.getWithMetadata('source/new.png'); source.metadata.Tags = ['changed'];
        await f.db.put('source/new.png', source.value, { metadata: source.metadata });
    };
    assert.equal((await f.run(true)).status, 409);
    assert.equal((await f.db.getWithMetadata('target/old.png')).metadata.TgFileId, 'old');
    assert.equal(f.objects.size, 1);
});

test('failed source deletion reports partial success without losing the replaced target', async () => {
    const f = fixture(); await f.add('source/new.png'); const targetId = await f.add('target/old.png');
    const remove = f.env.img_url.delete; f.env.img_url.delete = async key => { if (key === 'source/new.png') throw new Error('fail'); return remove(key); };
    const response = await f.run(true); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.sourceDeleted, false); assert.ok(result.warnings.length);
    assert.equal(await (await read(f.context(targetId, 'GET'))).text(), 'new image');
    assert.ok((await f.db.getWithMetadata('source/new.png')).metadata);
});

test('organize/list tokens cannot replace content; deleting a source also needs delete permission', async () => {
    const f = fixture(); await f.add('source/new.png'); await f.add('target/old.png');
    await f.db.put('manage@sysConfig@security', JSON.stringify({ apiTokens: { tokens: {
        organizer: { id: 'organizer', token: 'org', permissions: ['organize'] },
        manager: { id: 'manager', token: 'mgr', permissions: ['manage'] },
        newManager: { token: 'mgr2', permissions: ['manage'], permissionVersion: 2 },
        newOrganizer: { token: 'org2', permissions: ['list', 'organize'], permissionVersion: 2 },
        replacer: { token: 'replacer', permissions: ['replace'], permissionVersion: 2 },
        deleter: { token: 'deleter', permissions: ['delete'], permissionVersion: 2 },
        all: { id: 'all', token: 'all', permissions: ['manage', 'delete'] }
    } } }));
    assert.equal((await f.run(false, {}, { Authorization: 'Bearer org' })).status, 401);
    for (const token of ['mgr2', 'org2', 'deleter']) assert.equal((await f.run(false, {}, { Authorization: 'Bearer ' + token })).status, 401);
    assert.equal((await f.run(true, {}, { Authorization: 'Bearer replacer' })).status, 403);
    assert.equal((await f.run(true, {}, { Authorization: 'Bearer mgr' })).status, 403);
    assert.equal((await f.run(false, {}, { Authorization: 'Bearer mgr' })).status, 200);
    const version = (await f.db.getWithMetadata('target/old.png')).metadata.ContentVersion;
    assert.equal((await f.run(true, { targetVersion: version }, { Authorization: 'Bearer all' })).status, 200);
});

test('explicit replace grant works without manage and requires delete to remove the source', async () => {
    const f = fixture(); await f.add('source/new.png'); await f.add('target/old.png');
    await f.db.put('manage@sysConfig@security', JSON.stringify({ apiTokens: { tokens: {
        replacer: { token: 'replace-only', permissions: ['replace'], permissionVersion: 2 },
        both: { token: 'replace-delete', permissions: ['replace', 'delete'], permissionVersion: 2 }
    } } }));
    const before = await f.db.getWithMetadata('target/old.png');
    assert.equal((await f.run(true, {}, { Authorization: 'Bearer replace-only' })).status, 403);
    assert.deepEqual(await f.db.getWithMetadata('target/old.png'), before);
    assert.equal((await f.run(false, {}, { Authorization: 'Bearer replace-only' })).status, 200);
    assert.ok((await f.db.getWithMetadata('source/new.png')).metadata);
    const targetVersion = (await f.db.getWithMetadata('target/old.png')).metadata.ContentVersion;
    assert.equal((await f.run(true, { targetVersion }, { Authorization: 'Bearer replace-delete' })).status, 200);
    assert.equal((await f.db.getWithMetadata('source/new.png')).metadata, null);
});

test('picker compatibility excludes self, folders and mismatched types', async () => {
    const code = readFileSync(new URL('../frontend/src/utils/replacementHelpers.js', import.meta.url), 'utf8');
    const { replacementCompatible: compatible } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
    const source = { name: 'a.png', metadata: { FixedId: 'one', FileType: 'image/png' } };
    assert.equal(compatible(source, { name: 'b.png', metadata: { FileType: 'image/png' } }), true);
    for (const target of [source, { name: 'folder/', isFolder: true }, { name: 'b', metadata: { FileType: 'application/pdf' } },
        { name: 'b.png', metadata: { FixedId: 'one', FileType: 'image/png' } }]) assert.equal(compatible(source, target), false);
});

test('S3 copies to an independent key and encodes the source object path', async () => {
    const f = fixture(); Object.assign(f.env, { S3_ENDPOINT: 'https://s3.example', S3_BUCKET_NAME: 'bucket', S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'test' });
    await f.add('source/new.png', { Channel: 'S3', ChannelName: 'S3_env', S3FileKey: '目录/a b.png' });
    const commands = []; const send = S3Client.prototype.send;
    S3Client.prototype.send = async function(command) { commands.push(command); return {}; };
    try {
        const copy = await cloneReplacementContent(f.env, 'source/new.png', await f.db.getWithMetadata('source/new.png'));
        assert.notEqual(copy.metadata.S3FileKey, '目录/a b.png');
        assert.equal(commands[0].constructor.name, 'CopyObjectCommand');
        assert.equal(commands[0].input.CopySource, 'bucket/%E7%9B%AE%E5%BD%95/a%20b.png');
        await copy.rollback(); assert.equal(commands[1].constructor.name, 'DeleteObjectCommand');
    } finally { S3Client.prototype.send = send; }
});

test('WebDAV uses COPY into a separate path and supports rollback', async () => {
    const f = fixture(); Object.assign(f.env, { WEBDAV_BASE_URL: 'https://dav.example/root/', WEBDAV_CREATE_DIRECTORY: 'false' });
    await f.add('source/new.png', { Channel: 'WebDAV', ChannelName: 'WebDAV_env', WebDAVFilePath: 'original.png' });
    const calls = []; globalThis.fetch = async (url, options) => { calls.push([url, options]); return new Response(null, { status: 201 }); };
    const copy = await cloneReplacementContent(f.env, 'source/new.png', await f.db.getWithMetadata('source/new.png'));
    assert.equal(calls[0][1].method, 'COPY'); assert.equal(calls[0][1].headers.get('Overwrite'), 'F');
    assert.notEqual(copy.metadata.WebDAVFilePath, 'original.png');
    await copy.rollback(); assert.equal(calls[1][1].method, 'DELETE');
});

test('Discord chunk copies use independent messages and rollback every copied part', async () => {
    const f = fixture(); Object.assign(f.env, { DISCORD_BOT_TOKEN: 'test', DISCORD_CHANNEL_ID: 'channel' });
    const parts = [{ index: 0, messageId: 'old1', size: 3 }, { index: 1, messageId: 'old2', size: 3 }];
    await f.add('source/new.png', { Channel: 'Discord', ChannelName: 'Discord_env', IsChunked: true }, JSON.stringify(parts));
    const proto = DiscordAPI.prototype;
    const saved = { getFileContent: proto.getFileContent, sendFile: proto.sendFile, deleteMessage: proto.deleteMessage };
    const deleted = []; let number = 0;
    proto.getFileContent = async () => new Response('new');
    proto.sendFile = async () => ({ id: 'copy' + ++number, attachments: [{ id: 'attachment' }] });
    proto.deleteMessage = async (channel, id) => { deleted.push(id); return true; };
    try {
        const copy = await cloneReplacementContent(f.env, 'source/new.png', await f.db.getWithMetadata('source/new.png'));
        assert.deepEqual(JSON.parse(copy.value).map(p => p.messageId), ['copy1', 'copy2']);
        assert.deepEqual(JSON.parse((await f.db.getWithMetadata('source/new.png')).value), parts);
        await copy.rollback(); assert.deepEqual(deleted.sort(), ['copy1', 'copy2']);
        proto.getFileContent = async () => new Response(new Uint8Array(20 * 1024 * 1024 + 1));
        await assert.rejects(cloneReplacementContent(f.env, 'source/new.png', await f.db.getWithMetadata('source/new.png')), /20 MB/);
    } finally { Object.assign(proto, saved); }
});

test('HuggingFace copies upload to a new path and support rollback', async () => {
    const f = fixture(); Object.assign(f.env, { HF_TOKEN: 'test', HF_REPO: 'test/repo' });
    await f.add('source/new.png', { Channel: 'HuggingFace', ChannelName: 'HuggingFace_env', HfFilePath: 'old.png' });
    const proto = HuggingFaceAPI.prototype;
    const saved = { getFileContent: proto.getFileContent, uploadFile: proto.uploadFile, deleteFile: proto.deleteFile };
    const uploaded = []; const deleted = [];
    proto.getFileContent = async () => new Response('new');
    proto.uploadFile = async (file, path) => { uploaded.push([await file.text(), path]); return { success: true }; };
    proto.deleteFile = async path => { deleted.push(path); return true; };
    try {
        const copy = await cloneReplacementContent(f.env, 'source/new.png', await f.db.getWithMetadata('source/new.png'));
        assert.equal(uploaded[0][0], 'new'); assert.notEqual(copy.metadata.HfFilePath, 'old.png');
        await copy.rollback(); assert.deepEqual(deleted, [copy.metadata.HfFilePath]);
    } finally { Object.assign(proto, saved); }
});
