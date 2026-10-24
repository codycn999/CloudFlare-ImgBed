import { getDatabase } from '../../../utils/databaseAdapter.js';
import { authenticate, AUTH_SCOPE } from '../../../utils/auth/authCore.js';
import { activeNotesFile, readFileNotes, writeFileNotes, readNotesBody } from '../../../utils/fileNotes.js';

const reply = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
export async function onRequest(context) {
    const { request, env } = context;
    if (!['GET', 'POST'].includes(request.method)) return reply({ success: false, error: 'Method not allowed' }, 405);
    const auth = await authenticate({ env, request, authScope: AUTH_SCOPE.ADMIN, requiredPermission: request.method === 'GET' ? 'list' : 'organize' });
    if (!auth.authorized) return reply({ success: false, error: 'Permission denied' }, 401);
    try {
        const raw = Array.isArray(context.params.path) ? context.params.path.join('/') : String(context.params.path || '');
        const reference = decodeURIComponent(raw), db = getDatabase(env);
        if (request.method === 'POST') return reply(await writeFileNotes(db, reference, await readNotesBody(request), new URL(request.url).origin));
        const file = await activeNotesFile(db, reference);
        return reply({ success: true, ...file, ...await readFileNotes(db, file.id) });
    } catch (error) {
        return reply({ success: false, error: error.status ? error.message : 'Unable to access notes; retry after reading the file' }, error.status || 500);
    }
}
