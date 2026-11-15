import { promisify } from "node:util";
import { crc32, deflate } from "node:zlib";

const SIZE = 128;
const ROW_BYTES = SIZE * 4;
export const AVATAR_PIXEL_BYTES = SIZE * ROW_BYTES;

const compress = promisify(deflate);
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

const chunk = (type: string, data: Buffer) => {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(type, 4, "ascii");
  data.copy(bytes, 8);
  bytes.writeUInt32BE(
    crc32(bytes.subarray(4, bytes.length - 4)),
    bytes.length - 4,
  );
  return bytes;
};

// Each row starts with a zero byte (PNG filter None). The request supplies
// pixels only, so the encoder controls every PNG header, chunk and checksum.
export const encodeProfileAvatar = async (rgba: Buffer): Promise<Buffer> => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // Bits per channel
  header[9] = 6; // RGBA

  const scanlines = Buffer.alloc(SIZE * (ROW_BYTES + 1));
  for (let row = 0; row < SIZE; row += 1) {
    rgba.copy(
      scanlines,
      row * (ROW_BYTES + 1) + 1,
      row * ROW_BYTES,
      (row + 1) * ROW_BYTES,
    );
  }

  const compressed = await compress(scanlines, { level: 3 });
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};
