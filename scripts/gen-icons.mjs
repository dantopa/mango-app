// Generates PNG icons from the source SVGs for broad PWA / iOS compatibility.
// Run: node scripts/gen-icons.mjs   (requires the `sharp` devDependency)
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const pub = path.join(import.meta.dirname, "..", "public");

const targets = [
  { src: "icon.svg", out: "icon-192.png", size: 192 },
  { src: "icon.svg", out: "icon-512.png", size: 512 },
  { src: "icon.svg", out: "apple-icon.png", size: 180 },
  { src: "icon-maskable.svg", out: "icon-maskable-512.png", size: 512 },
];

for (const t of targets) {
  const svg = await readFile(path.join(pub, t.src));
  const png = await sharp(svg, { density: 384 })
    .resize(t.size, t.size)
    .png()
    .toBuffer();
  await writeFile(path.join(pub, t.out), png);
  console.log(`✓ ${t.out} (${t.size}px)`);
}
