import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../functions/utils/databaseAdapter.js';
import { resolveFilePath, isFixedId } from '../functions/utils/fileIdentity.js';

export function kvStore() {
    const map = new Map();
    return {
        map,
        async get(key) { return map.get(key)?.value ?? null; },
        async getWithMetadata(key) { return structuredClone(map.get(key) || { value: null, metadata: null }); },
        async put(key, value, options = {}) { map.set(key, structuredClone({ value, metadata: options.metadata || null })); },
        async delete(key) { map.delete(key); },
        async list({ prefix = '' } = {}) { return { keys: [...map].filter(([k]) => k.startsWith(prefix)).map(([name, r]) => ({ name, metadata: r.metadata })), list_complete: true }; }
    };
}

function d1Store() {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync(new URL('../database/init.sql', import.meta.url), 'utf8'));
    return { prepare(sql) {
        let args = [];
        const statement = {
            bind(...values) { args = values.map(value => value === undefined ? null : typeof value === 'boolean' ? Number(value) : value); return statement; },
            async first() { return sqlite.prepare(sql).get(...args) || null; },
            async run() { return sqlite.prepare(sql).run(...args); },
            async all() { return { results: sqlite.prepare(sql).all(...args) }; }
        };
        return statement;
    } };
}

const makeMetadata = () => ({ Channel: 'TelegramNew', ChannelName: 'Telegram_env', TgFileId: 'tg-test',
    FileName: '原图.jpg', FileType: 'image/jpeg', TimeStamp: 1700000000000,
    FileSize: '0.01', Directory: 'Telegram/', Tags: [], ListType: 'None', Label: 'None' });

for (const engine of ['KV', 'D1']) {
    const fixture = () => {
        const env = engine === 'KV' ? { img_url: kvStore() } : { img_d1: d1Store() };
        return { env, db: getDatabase(env) };
    };
    test(`${engine}: new uploads receive immutable IDs and extensionless permanent routes`, async () => {
        const { db } = fixture(); const metadata = makeMetadata();
        await db.put('Telegram/original.jpg', '', { metadata });
        assert.ok(isFixedId(metadata.FixedId));
        assert.equal(await resolveFilePath(db, metadata.FixedId), 'Telegram/original.jpg');
        const id = metadata.FixedId;
        await db.put('Telegram/original.jpg', '', { metadata: { ...metadata, FixedId: 'f_' + 'a'.repeat(32), FileName: '新名字.jpg', Tags: ['旅行'] } });
        const updated = await db.getWithMetadata('Telegram/original.jpg');
        assert.equal(updated.metadata.FixedId, id);
        assert.equal(updated.metadata.FileName, '新名字.jpg');
    });
    test(`${engine}: renames and repeated moves preserve the original and intermediate links`, async () => {
        const { db } = fixture(); const metadata = makeMetadata();
        await db.put('Telegram/original.jpg', '', { metadata });
        const id = metadata.FixedId;
        for (const [oldPath, newPath] of [
            ['Telegram/original.jpg', 'Telegram/renamed.jpg'],
            ['Telegram/renamed.jpg', '相册/旅行/renamed.jpg'],
            ['相册/旅行/renamed.jpg', 'archive/renamed.jpg']
        ]) {
            const record = await db.ensureFileIdentity(oldPath);
            await db.put(newPath, record.value, { metadata: record.metadata });
            await db.delete(oldPath);
        }
        for (const link of [id, 'Telegram/original.jpg', 'Telegram/renamed.jpg', '相册/旅行/renamed.jpg', 'archive/renamed.jpg']) {
            assert.equal(await resolveFilePath(db, link), 'archive/renamed.jpg');
        }
        assert.equal((await db.getWithMetadata('archive/renamed.jpg')).metadata.FixedId, id);
    });
    test(`${engine}: legacy records get stable IDs before their first move`, async () => {
        const { env, db } = fixture();
        const raw = engine === 'KV' ? env.img_url : null;
        if (raw) await raw.put('old.jpg', '', { metadata: makeMetadata() });
        else await env.img_d1.prepare('INSERT INTO files (id, value, metadata) VALUES (?, ?, ?)').bind('old.jpg', '', JSON.stringify(makeMetadata())).run();
        const a = await db.ensureFileIdentity('old.jpg');
        const b = await db.ensureFileIdentity('old.jpg');
        assert.equal(a.metadata.FixedId, b.metadata.FixedId);
        await db.put('new.jpg', a.value, { metadata: a.metadata }); await db.delete('old.jpg');
        assert.equal(await resolveFilePath(db, 'old.jpg'), 'new.jpg');
    });
    test(`${engine}: deleting the current record invalidates every alias and reserves historical paths`, async () => {
        const { db } = fixture(); const metadata = makeMetadata();
        await db.put('original.jpg', '', { metadata });
        await db.put('new.jpg', '', { metadata }); await db.delete('original.jpg');
        await db.delete('new.jpg');
        assert.equal(await resolveFilePath(db, metadata.FixedId), null);
        assert.equal(await resolveFilePath(db, 'original.jpg'), null);
        assert.equal(await db.get('original.jpg'), '');
        await assert.rejects(db.put('original.jpg', '', { metadata: { ...makeMetadata(), TimeStamp: 1800000000000 } }), /reserved/);
    });
    test(`${engine}: moving back to an owned historical path keeps the same ID`, async () => {
        const { db } = fixture(); const metadata = makeMetadata();
        await db.put('a.jpg', '', { metadata });
        await db.put('b.jpg', '', { metadata }); await db.delete('a.jpg');
        assert.equal(await db.isPathReserved('a.jpg', metadata.FixedId), false);
        await db.put('a.jpg', '', { metadata }); await db.delete('b.jpg');
        assert.equal(await resolveFilePath(db, 'b.jpg'), 'a.jpg');
    });
    test(`${engine}: settings and chunk/session data do not acquire file identities`, async () => {
        const { db } = fixture();
        const chunk = { uploadTime: Date.now(), status: 'uploaded' };
        await db.put('manage@sysConfig@test', '{}');
        await db.put('upload_session_test', '{}', { metadata: chunk });
        assert.equal(chunk.FixedId, undefined);
        assert.equal(await db.get('manage@sysConfig@test'), '{}');
        assert.equal(await resolveFilePath(db, 'f_' + '0'.repeat(32)), null);
    });
}
