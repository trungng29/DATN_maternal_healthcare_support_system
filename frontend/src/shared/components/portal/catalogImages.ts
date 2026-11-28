import specialtyImages from './specialty_images.json';

export function specialtyImage(code?: string): string | undefined {
  if (!code || !Object.prototype.hasOwnProperty.call(specialtyImages, code)) return;
  return specialtyImages[code as keyof typeof specialtyImages];
}

export function useCatalogFallback(image: HTMLImageElement, fallback?: string) {
  if (fallback && image.getAttribute('src') !== fallback) image.src = fallback;
  else image.hidden = true;
}
