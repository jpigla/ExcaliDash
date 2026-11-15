type ImageDimensions = { width: number; height: number };

// JPEG start-of-frame markers, excluding tables and reserved markers.
const jpegFrames = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(data: DataView): ImageDimensions | undefined {
  let offset = 2;
  while (offset + 3 < data.byteLength && data.getUint8(offset) === 0xff) {
    const marker = data.getUint8(offset + 1);
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Frame dimensions must be present before the scan or end marker.
    if (marker === 0xda || marker === 0xd9) return;
    const length = data.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > data.byteLength) return;
    if (jpegFrames.has(marker) && length >= 8) {
      return {
        width: data.getUint16(offset + 7),
        height: data.getUint16(offset + 5),
      };
    }
    offset += 2 + length;
  }
}

function webpDimensions(data: DataView): ImageDimensions | undefined {
  const type = data.getUint32(12);
  const length = data.getUint32(16, true);
  if (length + 20 > data.byteLength) return;

  if (type === 0x56503858 && length >= 10) {
    // VP8X stores two 24-bit little-endian values, offset by one.
    return {
      width: (data.getUint32(24, true) & 0xffffff) + 1,
      height: 1 + data.getUint16(27, true) + data.getUint8(29) * 65536,
    };
  }
  if (type === 0x5650384c && length >= 5 && data.getUint8(20) === 0x2f) {
    const size = data.getUint32(21, true);
    return { width: (size & 0x3fff) + 1, height: ((size >>> 14) & 0x3fff) + 1 };
  }
  if (
    type === 0x56503820 &&
    length >= 10 &&
    data.getUint16(23) === 0x9d01 &&
    data.getUint8(25) === 0x2a
  ) {
    return {
      width: data.getUint16(26, true) & 0x3fff,
      height: data.getUint16(28, true) & 0x3fff,
    };
  }
}

export function profilePictureDimensions(
  bytes: ArrayBuffer,
): ImageDimensions | undefined {
  const data = new DataView(bytes);
  if (data.byteLength >= 2 && data.getUint16(0) === 0xffd8) {
    return jpegDimensions(data);
  }
  if (
    data.byteLength >= 24 &&
    data.getUint32(0) === 0x89504e47 &&
    data.getUint32(4) === 0x0d0a1a0a &&
    data.getUint32(8) === 13 &&
    data.getUint32(12) === 0x49484452
  ) {
    return { width: data.getUint32(16), height: data.getUint32(20) };
  }
  if (
    data.byteLength >= 20 &&
    data.getUint32(0) === 0x52494646 &&
    data.getUint32(8) === 0x57454250
  ) {
    return webpDimensions(data);
  }
}
