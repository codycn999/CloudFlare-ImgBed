import { isFixedId, resolveFilePath } from './fileIdentity.js';

export const NOTES_PREFIX = 'manage@notes@';
export const NOTES_LIMIT = 32768; // UTF-16 code units, matching browser maxlength.
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const activeWrites = new Set();

export async function readNotesBody(request) {
    const limit = 256 * 1024; // Includes JSON escaping and request fields.
    if (Number(request.headers.get('Content-Length')) > limit) throw fail('Request body too large', 413);
    const reader = request.body?.getReader();
    if (!reader) throw fail('Expected a JSON object');
    const parts = []; let length = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > limit) { await reader.cancel(); throw fail('Request body too large', 413); }
            parts.push(value);
        }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const part of parts) { bytes.set(part, offset); offset += part.length; }
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!body || Array.isArray(body) || typeof body !== 'object') throw fail('Expected a JSON object');
        return body;
    } catch (error) { if (error.status) throw error; throw fail('Expected a valid JSON object'); }
    finally { reader.releaseLock(); }
}

export async function activeNotesFile(db, reference) {
    if (!reference || reference.startsWith('manage@')) throw fail('File not found', 404);
    const path = await resolveFilePath(db, reference);
    const record = path && await db.ensureFileIdentity(path);
    if (!record?.metadata?.Channel || !isFixedId(record.metadata.FixedId)) throw fail('File not found', 404);
    return { path, id: record.metadata.FixedId };
}

export async function readFileNotes(db, id) {
    if (!isFixedId(id)) throw fail('Invalid fixed ID');
    const value = await db.get(NOTES_PREFIX + id);
    const record = value ? JSON.parse(value) : { notes: '', revision: '', updatedAt: null };
    return { notes: record.notes, revision: record.revision, updatedAt: record.updatedAt, maxLength: NOTES_LIMIT };
}

export async function writeFileNotes(db, reference, body, origin = '') {
    if (typeof body.notes !== 'string') throw fail('notes must be a string; use an empty string to clear it');
    if (body.notes.length > NOTES_LIMIT) throw fail(`notes must not exceed ${NOTES_LIMIT} UTF-16 code units`, 413);
    if (typeof body.expectedRevision !== 'string') throw fail('expectedRevision is required; read the notes before updating');
    if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') throw fail('dryRun must be boolean');
    const file = await activeNotesFile(db, reference);
    if (body.expectedPath !== undefined && body.expectedPath !== file.path) throw fail('File moved; fetch it again', 409);
    const lock = origin + '/' + file.id;
    if (activeWrites.has(lock)) throw fail('Notes update in progress; retry after reading', 409);
    activeWrites.add(lock);
    try {
        const current = await readFileNotes(db, file.id);
        if (body.expectedRevision !== current.revision) throw fail('Notes changed; read the latest notes before updating', 409);
        if (body.dryRun) return { success: true, dryRun: true, id: file.id, path: file.path, ...current, notes: body.notes };
        const latest = await activeNotesFile(db, file.id);
        if (latest.path !== file.path) throw fail('File moved; fetch it again', 409);
        if (body.notes === current.notes) return { success: true, id: file.id, path: file.path, ...current };
        const next = { notes: body.notes, revision: crypto.randomUUID(), updatedAt: Date.now() };
        // Separate values avoid KV's 1 KB metadata limit, huge indexes and public
        // metadata exposure. Clearing retains a revision to reject stale writes.
        await db.put(NOTES_PREFIX + file.id, JSON.stringify(next));
        return { success: true, id: file.id, path: file.path, ...next, maxLength: NOTES_LIMIT };
    } finally { activeWrites.delete(lock); }
}
