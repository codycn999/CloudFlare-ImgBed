import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getDatabase } from '../functions/utils/databaseAdapter.js';
import { onRequest as updateMetadata } from '../functions/api/manage/metadata/[[path]].js';

const helperSource = readFileSync(new URL('../frontend/src/utils/fileDetailHelpers.js', import.meta.url), 'utf8');
const { validImageDimensions, needsPermanentLinkTab } = await import('data:text/javascript;base64,' + Buffer.from(helperSource).toString('base64'));

test('permanent-link tab is omitted for equal absolute or relative original links', () => {
    const link = 'https://img.example.com/file/f_123';
    assert.equal(needsPermanentLinkTab(link, link, 'https://img.example.com'), false);
    assert.equal(needsPermanentLinkTab('/file/f_123', link, 'https://img.example.com'), false);
    assert.equal(needsPermanentLinkTab(link, '', 'https://img.example.com'), false);
});

test('a separate permanent-link tab is retained for custom hosts, external URLs or legacy paths', () => {
    const link = 'https://img.example.com/file/f_123';
    for (const original of ['https://cdn.example.com/file/f_123', 'https://other.example.com/picture.png', '/file/old.png']) {
        assert.equal(needsPermanentLinkTab(original, link, 'https://img.example.com'), true);
    }
});

test('dimensions require a complete positive integer pair and normalize stored numeric strings', () => {
    assert.deepEqual(validImageDimensions('1200', '800'), { width: 1200, height: 800 });
    assert.deepEqual(validImageDimensions(800, 1200), { width: 800, height: 1200 });
    for (const pair of [[999, undefined], [0, 800], [NaN, 800], [100, Infinity], [-1, 50], [10.5, 20]]) {
        assert.equal(validImageDimensions(...pair), null);
    }
});

function fixture() {
    const records = new Map(); const tasks = [];
    const env = { img_url: {
        get: async key => records.get(key)?.value ?? null,
        getWithMetadata: async key => structuredClone(records.get(key) || { value: null, metadata: null }),
        put: async (key, value, options = {}) => records.set(key, structuredClone({ value, metadata: options.metadata || null })),
        delete: async key => records.delete(key)
    } };
    const db = getDatabase(env);
    const save = body => updateMetadata({ env, params: { path: ['photo.png'] },
        request: new Request('https://img.example.com/api/manage/metadata/photo.png', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }), waitUntil: task => tasks.push(task) });
    return { db, save, tasks };
}

test('image dimension backfill persists both axes without altering identity, name, directory or tags', async () => {
    const f = fixture();
    const metadata = { FileName: 'photo.png', FileType: 'image/png', Channel: 'TelegramNew',
        TimeStamp: 1700000000000, Directory: '', Tags: ['旅行'], Width: 999 };
    await f.db.put('photo.png', '', { metadata });
    const result = await f.save({ Width: 1200, Height: 800 });
    assert.equal(result.status, 200);
    const saved = (await result.json()).metadata;
    assert.equal(saved.Width, 1200); assert.equal(saved.Height, 800);
    assert.equal(saved.FixedId, metadata.FixedId);
    assert.equal(saved.FileName, 'photo.png'); assert.equal(saved.Directory, '');
    assert.deepEqual(saved.Tags, ['旅行']);
    await Promise.all(f.tasks);
});

test('invalid or incomplete dimensions and mixed rename payloads are rejected without modifying data', async () => {
    const f = fixture();
    await f.db.put('photo.png', '', { metadata: { FileName: 'photo.png', FileType: 'image/png',
        Channel: 'TelegramNew', TimeStamp: 1700000000000 } });
    for (const body of [{ Width: 1200 }, { Width: 0, Height: 800 }, { Width: 1.5, Height: 800 },
        { Width: 1200, Height: -1 }, { Width: 1200, Height: 800, FileName: 'renamed.png' }]) {
        assert.equal((await f.save(body)).status, 400);
    }
    assert.equal((await f.db.getWithMetadata('photo.png')).metadata.Width, undefined);
    assert.equal((await f.db.getWithMetadata('photo.png')).metadata.FileName, 'photo.png');
});

test('dimensions cannot be added to an unrelated file type', async () => {
    const f = fixture();
    await f.db.put('photo.png', '', { metadata: { FileName: 'note.txt', FileType: 'text/plain',
        Channel: 'TelegramNew', TimeStamp: 1700000000000 } });
    // FileType is authoritative when explicitly specified.
    assert.equal((await f.save({ Width: 1200, Height: 800 })).status, 400);
});
