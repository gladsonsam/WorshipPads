// Rasterize the SVG logo to a 1024×1024 PNG used as the source for app icons.
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(resolve(root, "src/assets/logo.svg"));
const out = resolve(root, "scripts/logo-1024.png");

await sharp(svg, { density: 384 }).resize(1024, 1024).png().toFile(out);
console.log("wrote", out);
