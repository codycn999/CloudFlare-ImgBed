import { catalogEntries } from './organizationCatalog.js';
const isFile = key => !key.name.startsWith('manage@') && !key.name.startsWith('chunk_') && key.metadata;
export async function tagCatalog(db) {
    const counts = new Map((await catalogEntries(db, 'tag')).map(t => [t.name, 0]));
    let cursor;
    do {
        const page = await db.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const key of page.keys.filter(isFile)) {
            for (const tag of new Set((key.metadata.Tags || []).map(t => t.toLowerCase()))) counts.set(tag, (counts.get(tag) || 0) + 1);
        }
        cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    return [...counts].map(([name, count]) => ({ name, count })).sort((a,b) => a.name.localeCompare(b.name));
}
