function stripJpegMetadata(buffer) {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error('Invalid JPEG structure');
    const segments = [buffer.subarray(0, 2)];
    let offset = 2;
    let foundEnd = false;
    while (offset < buffer.length) {
        const start = offset;
        if (buffer[offset++] !== 0xff) throw new Error('Invalid JPEG marker');
        while (offset < buffer.length && buffer[offset] === 0xff) offset++;
        if (offset >= buffer.length) throw new Error('Incomplete JPEG marker');
        const marker = buffer[offset++];
        if (marker === 0xda) {
            if (offset + 2 > buffer.length) throw new Error('Incomplete JPEG scan header');
            const length = buffer.readUInt16BE(offset);
            const end = offset + length;
            if (length < 2 || end > buffer.length) throw new Error('Invalid JPEG scan header');
            segments.push(buffer.subarray(start));
            foundEnd = true;
            break;
        }
        if (marker === 0xd9) {
            segments.push(buffer.subarray(start, offset));
            foundEnd = true;
            break;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            segments.push(buffer.subarray(start, offset));
            continue;
        }
        if (offset + 2 > buffer.length) throw new Error('Incomplete JPEG segment');
        const length = buffer.readUInt16BE(offset);
        const end = offset + length;
        if (length < 2 || end > buffer.length) throw new Error('Invalid JPEG segment');
        if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) {
            segments.push(buffer.subarray(start, end));
        }
        offset = end;
    }
    if (!foundEnd) throw new Error('JPEG has no image data');
    return Buffer.concat(segments);
}

function stripPngMetadata(buffer) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) throw new Error('Invalid PNG structure');
    const chunks = [buffer.subarray(0, 8)];
    let offset = 8;
    let foundEnd = false;
    const privateChunks = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const end = offset + length + 12;
        if (end > buffer.length) throw new Error('Invalid PNG chunk length');
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        if (!privateChunks.has(type)) chunks.push(buffer.subarray(offset, end));
        offset = end;
        if (type === 'IEND') {
            foundEnd = true;
            break;
        }
    }
    if (!foundEnd) throw new Error('PNG has no end chunk');
    return Buffer.concat(chunks);
}

function stripWebpMetadata(buffer) {
    if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF'
        || buffer.toString('ascii', 8, 12) !== 'WEBP') throw new Error('Invalid WebP structure');
    const declaredSize = buffer.readUInt32LE(4) + 8;
    if (declaredSize > buffer.length || declaredSize < 12) throw new Error('Invalid WebP size');
    const chunks = [buffer.subarray(0, 12)];
    let offset = 12;
    const privateChunks = new Set(['EXIF', 'XMP ']);
    while (offset + 8 <= declaredSize) {
        const length = buffer.readUInt32LE(offset + 4);
        const paddedLength = length + (length % 2);
        const end = offset + 8 + paddedLength;
        if (end > declaredSize) throw new Error('Invalid WebP chunk length');
        const type = buffer.toString('ascii', offset, offset + 4);
        if (!privateChunks.has(type)) {
            const chunk = Buffer.from(buffer.subarray(offset, end));
            if (type === 'VP8X' && length >= 1) chunk[8] &= ~0x0c;
            chunks.push(chunk);
        }
        offset = end;
    }
    if (offset !== declaredSize) throw new Error('Invalid WebP chunk alignment');
    const output = Buffer.concat(chunks);
    output.writeUInt32LE(output.length - 8, 4);
    return output;
}

function stripLocationMetadata(buffer) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError('Image data must be a buffer');
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return { extension: 'jpg', buffer: stripJpegMetadata(buffer) };
    }
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return { extension: 'png', buffer: stripPngMetadata(buffer) };
    }
    if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF'
        && buffer.toString('ascii', 8, 12) === 'WEBP') {
        return { extension: 'webp', buffer: stripWebpMetadata(buffer) };
    }
    throw new Error('Unsupported image format');
}

module.exports = { stripLocationMetadata };
