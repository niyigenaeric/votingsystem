const test = require('node:test');
const assert = require('node:assert/strict');
const { stripLocationMetadata } = require('../db/imagePrivacy');

function pngChunk(type, data = Buffer.alloc(0)) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    header.write(type, 4, 4, 'ascii');
    return Buffer.concat([header, data, Buffer.alloc(4)]);
}

test('removes JPEG EXIF, IPTC, and comment segments without changing image data', () => {
    const app1Data = Buffer.from('Exif\0\0GPS');
    const app1Header = Buffer.from([0xff, 0xe1, 0x00, app1Data.length + 2]);
    const app1 = Buffer.concat([app1Header, app1Data]);
    const scan = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0xff, 0xd9]);
    const result = stripLocationMetadata(Buffer.concat([Buffer.from([0xff, 0xd8]), app1, scan]));
    assert.equal(result.extension, 'jpg');
    assert.equal(result.buffer.includes(Buffer.from('GPS')), false);
    assert.equal(result.buffer.subarray(-scan.length).equals(scan), true);
});

test('removes PNG text and EXIF chunks', () => {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const imageData = pngChunk('IDAT', Buffer.from([1, 2, 3]));
    const text = pngChunk('tEXt', Buffer.from('Location\0Kigali'));
    const exif = pngChunk('eXIf', Buffer.from('GPS'));
    const end = pngChunk('IEND');
    const result = stripLocationMetadata(Buffer.concat([signature, imageData, text, exif, end]));
    assert.equal(result.extension, 'png');
    assert.equal(result.buffer.includes(Buffer.from('Location')), false);
    assert.equal(result.buffer.includes(Buffer.from('GPS')), false);
    assert.equal(result.buffer.includes(imageData), true);
});

test('removes WebP EXIF/XMP chunks and clears feature flags', () => {
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x0c;
    const chunks = [
        Buffer.from('VP8X'),
        uint32(10),
        vp8x,
        Buffer.from('EXIF'),
        uint32(3),
        Buffer.from('GPS'),
        Buffer.from([0]),
        Buffer.from('VP8 '),
        uint32(2),
        Buffer.from([0x01, 0x02])
    ];
    const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
    const header = Buffer.concat([Buffer.from('RIFF'), uint32(body.length), body]);
    const result = stripLocationMetadata(header);
    assert.equal(result.extension, 'webp');
    assert.equal(result.buffer.includes(Buffer.from('GPS')), false);
    const vp8xIndex = result.buffer.indexOf(Buffer.from('VP8X'));
    assert.equal(result.buffer[vp8xIndex + 8] & 0x0c, 0);
    assert.equal(result.buffer.readUInt32LE(4), result.buffer.length - 8);
});

function uint32(value) {
    const result = Buffer.alloc(4);
    result.writeUInt32LE(value);
    return result;
}
