import mongoose from "mongoose";
import { syncArticles } from "../services/article-sync.service";
import { ApiArticle } from "../types/api";

// Seeds a fake hint article (id >= 900000) so the hint board can be tried before the hunt.
// Remove with: db.articles.deleteMany({ id: { $gte: 900000 } }); db.hintcells.deleteMany({ articleId: { $gte: 900000 } })
//
// Refuses to run when NODE_ENV=production unless --force is passed. The Docker image sets
// NODE_ENV=production, so running this inside the container requires the flag, e.g.:
//   docker compose exec server bun run seed-hint --force
if (process.env.NODE_ENV === "production" && !process.argv.includes("--force")) {
  console.error("Refusing to seed a test hint article with NODE_ENV=production. Pass --force to override.");
  process.exit(1);
}

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error("MONGO_URI is not set");
  process.exit(1);
}
await mongoose.connect(uri);

const id = 900000 + Math.floor(Math.random() * 100000);
const content =
  `<div><strong>Testhint</strong><br>Merida volgt de irrlichten...<br>` +
  `Alpha: <img src="https://placehold.co/600x200?text=Alpha"><br>` +
  `Bravo: -<br>` +
  `Charlie: tweeduizend honderdzesentwintig vierduizend zeshonderdtweeënnegentig<br>` +
  `Delta: <img src="https://placehold.co/600x200?text=Delta"><br>` +
  `Echo: --<br>` +
  `Foxtrot: 1234 5678 in spiegelschrift<br>` +
  `Golf: <img src="https://placehold.co/600x200?text=Golf"><br>` +
  `Hotel: -<br>` +
  `Oscar: Neem lijn 7 tot de laatste halte</div>`;

const article = {
  id,
  title: `Testhint ${id}`,
  type: "hint",
  publish_at: new Date().toISOString(),
  message: { content },
} as ApiArticle;

const result = await syncArticles([article]);
console.log(`Seeded hint article ${id} with ${result.cellsCreated} cells`);
await mongoose.disconnect();
