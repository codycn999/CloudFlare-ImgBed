export function validateFileName(name) {
    return typeof name === 'string' && name.length > 0 && name === name.trim() &&
        name !== '.' && name !== '..' && !/[\\/,:*?"<>|#%\u0000-\u001f\u007f]/.test(name) &&
        !name.endsWith('.') && new TextEncoder().encode(name).length <= 180;
}

export function uploadFileName(name) {
    const base = String(name || '').split(/[\\/]/).pop().trim()
        .replace(/[,:*?"<>|#%\u0000-\u001f\u007f]/g, '_').replace(/\.+$/, '');
    let result = base || 'file';
    while (new TextEncoder().encode(result).length > 160) result = result.slice(1);
    return result === '.' || result === '..' ? 'file' : result;
}

export async function chooseFilePath(db, folder, name, fixedId = '', currentPath = '') {
    const join = value => folder ? `${folder}/${value}` : value;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    for (let suffix = 0; suffix < 10000; suffix++) {
        const candidate = join(suffix ? `${stem} (${suffix + 1})${extension}` : name);
        if (candidate === currentPath) return candidate;
        const record = await db.getWithMetadata(candidate);
        if (record?.metadata || (record?.value != null)) continue;
        if (db.isPathReserved && await db.isPathReserved(candidate, fixedId)) continue;
        return candidate;
    }
    throw new Error('Too many files share the same name');
}
