// Precompute CLIP text embeddings for every dish in the published menus, so phones only
// need the (smaller) image half of the model and never spend time encoding menu names.
//
// Output (public/data/):
//   embeddings.json   { model, dim, names: [...], scales: [...] }
//   embeddings.bin    int8 vectors, one row of `dim` per name (row i = names[i] * scales[i])

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, AutoTokenizer, CLIPTextModelWithProjection } from '@huggingface/transformers';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
// Must match prompt() in public/js/recognize.js.
const prompt = (name) => `a photo of ${name}, a type of food.`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'public', 'data');
env.cacheDir = process.env.HF_CACHE_DIR || path.join(root, 'data', 'models');

const names = new Set();
for (const f of fs.readdirSync(path.join(OUT, 'menus'))) {
  for (const menu of JSON.parse(fs.readFileSync(path.join(OUT, 'menus', f)))) {
    for (const st of menu.stations) for (const it of st.items) names.add(it.name);
  }
}
const list = [...names].sort();

const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
const model = await CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'q8' });

let dim = 0;
const rows = [];
const scales = [];
for (let i = 0; i < list.length; i += 64) {
  const { text_embeds } = await model(tokenizer(list.slice(i, i + 64).map(prompt), { padding: true, truncation: true }));
  dim = text_embeds.dims[1];
  for (let r = 0; r < text_embeds.dims[0]; r++) {
    const v = text_embeds.data.slice(r * dim, (r + 1) * dim);
    const norm = Math.hypot(...v);
    const max = Math.max(...v.map((x) => Math.abs(x / norm)));
    const scale = max / 127;
    rows.push(Int8Array.from(v, (x) => Math.round(x / norm / scale)));
    scales.push(+scale.toPrecision(6));
  }
}

const bin = new Int8Array(rows.length * dim);
rows.forEach((row, i) => bin.set(row, i * dim));
fs.writeFileSync(path.join(OUT, 'embeddings.bin'), bin);
fs.writeFileSync(path.join(OUT, 'embeddings.json'), JSON.stringify({ model: MODEL_ID, dim, names: list, scales }));
console.log(`Embedded ${list.length} dish names (${(bin.length / 1024).toFixed(0)} KB).`);
