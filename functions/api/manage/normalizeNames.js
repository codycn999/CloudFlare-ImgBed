import { getDatabase } from '../../utils/databaseAdapter.js';
import { chooseFilePath, validateFileName } from '../../utils/fileNaming.js';
import { onRequest as renameFile } from './rename/[[path]].js';

const STATE_KEY = 'manage@migration@unifiedNames@v1';

// Resumable, authenticated batches. Opening the dashboard continues unfinished work.
export async function onRequest(context) {
    if (context.request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const db = getDatabase(context.env);
    const body = await context.request.json().catch(() => ({}));
    let state = body.restart ? null : JSON.parse(await db.get(STATE_KEY) || 'null');
    state ||= { cursor: null, done: false, scanned: 0, renamed: 0, conflictsResolved: 0, skipped: 0, errors: [] };
    if (state.done) return Response.json(state, { headers: { 'Cache-Control': 'no-store' } });
    const result = await db.list({ limit: 10, ...(state.cursor ? { cursor: state.cursor } : {}) });
    const tasks = [];
    for (const item of result.keys) {
        if (item.name.startsWith('manage@') || !item.metadata?.TimeStamp || !item.metadata?.Channel) continue;
        const record = await db.getWithMetadata(item.name);
        if (!record?.metadata) continue;
        const name = record.metadata.FileName;
        state.scanned++;
        if (!name || item.name.split('/').pop() === name) continue;
        try {
            if (!validateFileName(name)) throw new Error('显示名称包含路径不支持的字符，请先修改文件名');
            const folder = item.name.split('/').slice(0, -1).join('/');
            const initialized = await db.ensureFileIdentity(item.name);
            const target = await chooseFilePath(db, folder, name, initialized.metadata.FixedId, item.name);
            const selectedName = target.split('/').pop();
            const response = await renameFile({ ...context,
                params: { path: item.name.split('/').map(encodeURIComponent) },
                request: new Request(context.request.url, { method: 'POST', headers: context.request.headers,
                    body: JSON.stringify({ newFileName: selectedName }) }),
                waitUntil: task => tasks.push(task)
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || '整理失败');
            state.renamed++;
            if (selectedName !== name) state.conflictsResolved++;
        } catch (error) {
            state.skipped++;
            if (state.errors.length < 50) state.errors.push({ path: item.name, reason: error.message });
        }
    }
    await Promise.all(tasks);
    state.cursor = result.cursor || null;
    state.done = result.list_complete === true || !state.cursor;
    await db.put(STATE_KEY, JSON.stringify(state));
    return Response.json(state, { headers: { 'Cache-Control': 'no-store' } });
}
