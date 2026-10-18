import { tagCatalog } from '../../../utils/tagCatalog.js';
import { getDatabase } from '../../../utils/databaseAdapter.js';
import { registerEntry } from '../../../utils/organizationCatalog.js';
import { validateTag } from '../../../utils/tagHelpers.js';
import { addFileToIndex } from '../../../utils/indexManager.js';
import { cleanPersistedMetadata } from '../../../utils/metadata/metadataSecurity.js';

const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const isFile = key => !key.name.startsWith('manage@') && !key.name.startsWith('chunk_') && key.metadata;

export async function onRequest(context) {
    const db = getDatabase(context.env);
    if (context.request.method === 'GET') return reply({ tags: await tagCatalog(db) });
    if (context.request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
    let body;
    try { body = await context.request.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    const { action, cursor } = body;
    const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
    const newName = typeof body.newName === 'string' ? body.newName.trim().toLowerCase() : '';
    if (!['add', 'delete', 'rename'].includes(action) || !validateTag(name) || name.length > 100 ||
        (action === 'rename' && (!validateTag(newName) || newName.length > 100 || newName === name)) ||
        (cursor != null && typeof cursor !== 'string')) return reply({ error: 'Invalid tag or action' }, 400);
    if (action === 'add') {
        await registerEntry(db, 'tag', name);
        return reply({ success: true });
    }
    if (action === 'delete') {
        const entry = (await tagCatalog(db)).find(t => t.name === name);
        if (entry?.count) return reply({ error: 'Tag is still in use', count: entry.count }, 409);
        await db.delete('manage@organization@tag@' + encodeURIComponent(name));
        return reply({ success: true });
    }
    // Bounded batches let the UI report progress and retry interrupted renames safely.
    const page = await db.list({ limit: 25, ...(cursor ? { cursor } : {}) });
    let updated = 0;
    for (const key of page.keys.filter(isFile)) {
        if (!(key.metadata.Tags || []).some(t => [name, newName].includes(t.toLowerCase()))) continue;
        const file = await db.getWithMetadata(key.name);
        if (!file.metadata) continue;
        const changed = (file.metadata.Tags || []).some(t => t.toLowerCase() === name);
        if (!changed) {
            const repair = await addFileToIndex(context, key.name, cleanPersistedMetadata(file.metadata));
            if (!repair.success) return reply({ error: 'Index update failed; retry the same rename' }, 503);
            continue;
        }
        const metadata = cleanPersistedMetadata({ ...file.metadata,
            Tags: [...new Set(file.metadata.Tags.map(t => t.toLowerCase() === name ? newName : t))] });
        await db.put(key.name, file.value, { metadata });
        const indexed = await addFileToIndex(context, key.name, metadata);
        if (!indexed.success) return reply({ error: 'Index update failed; retry the same rename' }, 503);
        updated++;
    }
    const nextCursor = page.list_complete ? null : page.cursor;
    if (!nextCursor) {
        await registerEntry(db, 'tag', newName);
        await db.delete('manage@organization@tag@' + encodeURIComponent(name));
    }
    return reply({ success: true, updated, nextCursor });
}
