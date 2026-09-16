import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.join(__dirname, "..", "public", "icons");

fs.mkdirSync(ICONS_DIR, { recursive: true });

function createSvg(size, maskable = false) {
  const padding = maskable ? size * 0.1 : 0;
  const innerSize = size - padding * 2;
  const cx = size / 2;
  const cy = size / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${maskable ? `<rect width="${size}" height="${size}" fill="#0053dc" rx="${size * 0.1}"/>` : ""}
  <g transform="translate(${padding}, ${padding})">
    <rect width="${innerSize}" height="${innerSize}" rx="${innerSize * 0.15}" fill="#0053dc"/>
    <rect x="${innerSize * 0.12}" y="${innerSize * 0.12}" width="${innerSize * 0.76}" height="${innerSize * 0.76}" rx="${innerSize * 0.08}" fill="white" opacity="0.15"/>
    <g transform="translate(${innerSize * 0.25}, ${innerSize * 0.25})">
      <rect width="${innerSize * 0.5}" height="${innerSize * 0.12}" rx="${innerSize * 0.03}" fill="white"/>
      <rect y="${innerSize * 0.17}" width="${innerSize * 0.38}" height="${innerSize * 0.12}" rx="${innerSize * 0.03}" fill="white" opacity="0.7"/>
      <rect y="${innerSize * 0.34}" width="${innerSize * 0.44}" height="${innerSize * 0.12}" rx="${innerSize * 0.03}" fill="white" opacity="0.5"/>
      <circle cx="${innerSize * 0.42}" cy="${innerSize * 0.42}" r="${innerSize * 0.05}" fill="white" opacity="0.3"/>
    </g>
  </g>
</svg>`;
}

// Generate SVG files
for (const [name, size, maskable] of [
  ["icon-192x192", 192, false],
  ["icon-512x512", 512, false],
  ["icon-maskable-512x512", 512, true],
]) {
  const svg = createSvg(size, maskable);
  fs.writeFileSync(path.join(ICONS_DIR, `${name}.svg`), svg);
  console.log(`Created ${name}.svg`);
}

// Try to generate PNGs with sharp (optional)
try {
  const sharp = (await import("sharp")).default;
  for (const [name, size] of [
    ["icon-192x192", 192],
    ["icon-512x512", 512],
    ["icon-maskable-512x512", 512],
  ]) {
    const svgPath = path.join(ICONS_DIR, `${name}.svg`);
    const pngPath = path.join(ICONS_DIR, `${name}.png`);
    await sharp(svgPath).resize(size, size).png().toFile(pngPath);
    console.log(`Created ${name}.png`);
  }
} catch {
  console.log("sharp not available — SVG icons generated. Install sharp for PNG conversion.");
}

console.log("Done!");
