# JHU Fuel — calorie & nutrient tracker for Johns Hopkins dining

An iPhone app (installable web app) that knows what the JHU dining halls are serving today. Take a photo of your plate and it matches what it sees to the actual menu, so you get JHU's real nutrition numbers. **It's completely free:** no App Store, no account, no AI subscription. Everything runs on your phone.

## Features

- **📷 Snap your plate.** An image-recognition model (CLIP), running on your phone, compares your photo with every item on that day's menu at Hopkins Café (formerly the FFC), Nolan's on 33rd, Levering Kitchens, Levering Café or Peabody. It checks different parts of the photo, so several foods on one plate are found. You confirm or swap matches, tap anything it missed, set servings, and log.
- **📦 Barcode scanning.** Photograph a barcode, or type its number, to look up the product's nutrition in Open Food Facts, with the USDA database as a fallback. If a product isn't in either, scan its label instead and it's remembered under that barcode.
- **🏷️ Nutrition label scanning.** Photograph a Nutrition Facts panel and on-device text recognition reads all the values into a form you can check. It straightens tilted photos and fixes common misreads.
- **🏛 Live JHU menus.** Every location and meal period, with full nutrition, diet labels and allergens. They are refreshed every morning.
- **🔍 Manual logging.** Search today's menus and your saved or recent foods, type a quick list ("2 slices pepperoni pizza, caesar salad from the FFC"), or add a custom food.
- **📊 17 nutrients tracked** against personal targets (Mifflin–St Jeor formula, Dietary Guidelines, NIH intakes), and you can override any target.
- **📈 Progress.** Daily calories and macros against your goal, a logging streak, a weight trend, % of the way to your goal weight, and a projected finish date.
- **💾 Private.** Your log is stored only on your phone. Save a backup to iCloud Drive from Goals → Backup.

## How it works (no server)

```
GitHub Actions (every morning, free)            Your iPhone (Safari / home-screen app)
  scripts/build-menus.mjs ─ JHU Nutrislice ─┐     public/  ← static app, hosted free on GitHub Pages
  scripts/build-embeddings.mjs (dish names) ├──▶  data/menus/*.json, data/embeddings.*
  deploy to GitHub Pages ───────────────────┘     IndexedDB: your log, weigh-ins, foods, photos
                                                  CLIP / Tesseract / ZXing: run on-device
```

- JHU's menu server doesn't let other websites read it from the browser, so a free daily GitHub Actions job downloads 4 weeks of menus (2 back, 2 ahead) and publishes them as static files next to the app.
- The same job also turns every dish name into numbers the recognition model can compare against (CLIP embeddings), so your phone only needs the image half of the model: a one-time download of about 90 MB, cached afterwards.
- A photo takes about 1–3 seconds and works offline after the first use.

| Piece | File |
|---|---|
| App shell, routing | `public/index.html`, `public/js/app.js` |
| On-device "backend" (same API the screens call) | `public/js/api.js` |
| Storage (IndexedDB) | `public/js/store.js` |
| Menus (reads the published files) | `public/js/menus.js` |
| Plate recognition + typed-meal matching | `public/js/recognize.js` |
| Barcodes / labels | `public/js/barcode.js`, `public/js/label.js` |
| Offline support | `public/sw.js`, `public/manifest.webmanifest` |
| Daily menu + embedding build, deploy | `scripts/`, `.github/workflows/deploy.yml` |

## Run it on your computer

```bash
npm install
npm run menus     # download menus + build embeddings (~1 min)
npm start         # http://localhost:3000
```

## Put it on your iPhone (free)

1. Push this folder to a **public** GitHub repository and turn on **Settings → Pages → Source: GitHub Actions**. The workflow publishes it to `https://<your-username>.github.io/<repo>/` and refreshes the menus every morning.
2. On your iPhone, open that address in **Safari**, tap **Share → Add to Home Screen**, and open **JHU Fuel** from the new icon.
3. The first time you open Snap, connect to Wi-Fi: the recognizer downloads once (about 90 MB).

The code is public, but your data is not. It lives only on your phone.

**Moving data from the old laptop version:** run `npm run export-old-data`, AirDrop the resulting `jhu-fuel-backup.json` to your phone, and in the app tap Goals → **Restore a backup**.
