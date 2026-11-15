import { profilePictureDimensions } from "./profilePictureDimensions";

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_INPUT_DIMENSION = 8192;
const MAX_INPUT_PIXELS = 32_000_000;
const AVATAR_SIZE = 128;

export const prepareProfilePicture = async (
  file: File,
): Promise<ArrayBuffer> => {
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error("Choose a JPEG, PNG or WebP image of up to 10 MB");
  }

  const dimensions = profilePictureDimensions(await file.arrayBuffer());
  if (!dimensions || dimensions.width === 0 || dimensions.height === 0) {
    throw new Error("Choose a valid JPEG, PNG or WebP image");
  }
  const { width, height } = dimensions;
  if (
    width > MAX_INPUT_DIMENSION ||
    height > MAX_INPUT_DIMENSION ||
    width * height > MAX_INPUT_PIXELS
  ) {
    throw new Error(
      "Choose an image with up to 32 megapixels and 8,192 pixels per side",
    );
  }

  const image = await createImageBitmap(file).catch(() => {
    throw new Error("Could not read the selected image");
  });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not resize the selected image");

    const cropSize = Math.min(image.width, image.height);
    context.drawImage(
      image,
      (image.width - cropSize) / 2,
      (image.height - cropSize) / 2,
      cropSize,
      cropSize,
      0,
      0,
      AVATAR_SIZE,
      AVATAR_SIZE,
    );
    return context.getImageData(0, 0, AVATAR_SIZE, AVATAR_SIZE).data.buffer;
  } finally {
    image.close();
  }
};
