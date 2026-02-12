export function createIconDataUrl(label: string, fill: string): string {
  const safeLabel = escapeXml(label.slice(0, 2).toUpperCase());
  const safeFill = escapeXml(fill);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<circle cx="16" cy="16" r="14" fill="${safeFill}"/>` +
    `<text x="16" y="20" text-anchor="middle" font-size="11" fill="#e2e8f0" font-family="Arial, sans-serif">${safeLabel}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
