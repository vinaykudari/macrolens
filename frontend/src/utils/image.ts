const MAX_BYTES_BEFORE_RESIZE = 2_500_000;
const MAX_DIMENSION_PX = 1800;

export async function prepareMealImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) {
    return file;
  }

  // Keep modest images untouched to preserve original quality
  if (file.size <= MAX_BYTES_BEFORE_RESIZE) {
    return file;
  }

  try {
    const dataUrl = await readFileAsDataUrl(file);
    const img = await loadImage(dataUrl);

    const { width, height } = img;
    const longest = Math.max(width, height);
    if (longest <= MAX_DIMENSION_PX && file.size <= 4_000_000) {
      return file;
    }

    const scale = longest > MAX_DIMENSION_PX ? MAX_DIMENSION_PX / longest : 1;
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;

    const ctx = canvas.getContext('2d');
    if (!ctx) return file;

    ctx.drawImage(img, 0, 0, targetW, targetH);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.88)
    );
    if (!blob) return file;

    const baseName = file.name.replace(/\.[^.]+$/, '') || 'meal';
    return new File([blob], `${baseName}.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now(),
    });
  } catch {
    return file;
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = src;
  });
}
