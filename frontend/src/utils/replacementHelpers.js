export function replacementCompatible(source, target) {
    if (!source || !target || source.name === target.name || target.isFolder || target.name?.endsWith('/')) return false;
    if (source.metadata?.FixedId && source.metadata.FixedId === target.metadata?.FixedId) return false;
    const type = file => file.metadata?.FileType?.split(';')[0].trim().toLowerCase();
    return !!type(source) && type(source) === type(target);
}
