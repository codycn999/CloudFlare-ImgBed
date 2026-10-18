export function validImageDimensions(width, height) {
    const w = Number(width), h = Number(height);
    return Number.isSafeInteger(w) && Number.isSafeInteger(h) && w > 0 && h > 0 &&
        w <= 1000000 && h <= 1000000 ? { width: w, height: h } : null;
}

export function needsPermanentLinkTab(original, permanent, origin) {
    if (!permanent) return false;
    try { return new URL(original || '', origin).href !== new URL(permanent, origin).href; }
    catch { return true; }
}
