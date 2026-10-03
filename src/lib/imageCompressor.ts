/**
 * Client-side high-quality image compressor.
 *
 * Scales images down so that neither dimension exceeds `maxDimension` (default 2048px),
 * preserving crisp readability of blackboard writing and handwritten notes while
 * drastically reducing file size (e.g. from 15MB camera capture to ~400KB WebP/JPEG).
 */

export interface CompressionResult {
  file: File;
  width: number;
  height: number;
  size: number;
  previewUrl: string;
}

export async function compressImage(
  file: File,
  maxDimension = 2048,
  quality = 0.85
): Promise<CompressionResult> {
  // If not an image, return original
  if (!file.type.startsWith('image/')) {
    return {
      file,
      width: 0,
      height: 0,
      size: file.size,
      previewUrl: URL.createObjectURL(file),
    };
  }

  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      let { width, height } = img;

      // Calculate new dimensions maintaining aspect ratio
      if (width > maxDimension || height > maxDimension) {
        if (width > height) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        // Fallback to original
        resolve({
          file,
          width: img.width,
          height: img.height,
          size: file.size,
          previewUrl: URL.createObjectURL(file),
        });
        return;
      }

      // Draw with smooth scaling
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);

      // Prefer WebP with fallback to JPEG
      const outputMime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';

      canvas.toBlob(
        (blob) => {
          if (!blob || blob.size >= file.size) {
            // If compression didn't help (rare), use original
            resolve({
              file,
              width: img.width,
              height: img.height,
              size: file.size,
              previewUrl: URL.createObjectURL(file),
            });
            return;
          }

          const compressedFileName = file.name.replace(/\.[^/.]+$/, '') + (outputMime === 'image/png' ? '.png' : '.jpg');
          const compressedFile = new File([blob], compressedFileName, {
            type: outputMime,
            lastModified: Date.now(),
          });

          resolve({
            file: compressedFile,
            width,
            height,
            size: compressedFile.size,
            previewUrl: URL.createObjectURL(compressedFile),
          });
        },
        outputMime,
        quality
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({
        file,
        width: 0,
        height: 0,
        size: file.size,
        previewUrl: URL.createObjectURL(file),
      });
    };

    img.src = objectUrl;
  });
}
