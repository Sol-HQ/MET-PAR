async function drawJpeg(bitmap: ImageBitmap, side: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not read that image.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("Could not read that image.");
  return blob;
}

export async function shrinkImage(file: File): Promise<Blob> {
  return drawJpeg(await createImageBitmap(file), 512, 0.82);
}

/** A JPEG at or under the byte limit. It steps the quality, then the size, down until it fits. */
export async function shrinkImageUnder(file: File, maxBytes: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  for (const side of [768, 640, 512, 384]) {
    for (const quality of [0.85, 0.75, 0.65]) {
      const blob = await drawJpeg(bitmap, side, quality);
      if (blob.size <= maxBytes) return blob;
    }
  }
  throw new Error("That picture stays too large after shrinking. Try a simpler picture.");
}
