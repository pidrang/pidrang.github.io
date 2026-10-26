import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SCRIPT_DIR, SITE_ROOT, sync } from "./sync.mjs";

const FIXTURES = join(SCRIPT_DIR, "fixtures", "discussions.json");
const temporaryDirs = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "blog-test-"));
  temporaryDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("the real Hugo build works and is reproducible", { skip: process.env.HUGO_BIN === undefined ? "HUGO_BIN is not set" : false }, async () => {
  const site = SITE_ROOT;
  const previousBlog = await tempDir();
  if (existsSync(join(site, "blog"))) {
    await cp(join(site, "blog"), join(previousBlog, "blog"), { recursive: true });
  }
  try {
    await rm(join(site, "blog"), { recursive: true, force: true });
    const first = await sync({ fixtures: FIXTURES });
    assert.deepEqual(first.change, { added: ["signal-first-crud", "ui-agnostic-core"], changed: [], removed: [] });
    for (const file of [
      "blog/index.html",
      "blog/index.xml",
      "blog/sitemap.xml",
      "blog/signal-first-crud/index.html",
      "blog/ui-agnostic-core/index.html",
      "blog/categories/tutorials/index.html",
      "blog/categories/architecture/index.html",
    ]) {
      assert.ok(statSync(join(site, file)).size > 0, file);
    }

    const post = await readFile(join(site, "blog", "signal-first-crud", "index.html"), "utf8");
    assert.match(post, /<script type="application\/ld\+json">\{"@context":"https:\/\/schema.org","@type":"BlogPosting"/);
    assert.match(post, /data-term="12"/);
    assert.match(post, /data-repo="pidrang\/pidrang"/);
    assert.match(post, /data-goatcounter="https:\/\/pidrang.goatcounter.com\/count"/);
    assert.match(post, /href="https:\/\/github.com\/pidrang\/pidrang\/discussions\/12"/);
    assert.match(post, /<time datetime="2026-10-20T09:30:00Z">2026-10-20<\/time>/);
    assert.match(post, /<table>/);
    assert.match(post, /&ldquo;resource&rdquo;/);
    assert.doesNotMatch(post, /<h1[^>]*>.*<\/h1>[\s\S]*<h1/);

    const list = await readFile(join(site, "blog", "index.html"), "utf8");
    assert.ok(list.indexOf("signal-first-crud") < list.indexOf("ui-agnostic-core"));
    assert.doesNotMatch(list, /giscus/);
    assert.match(await readFile(join(site, "blog", "categories", "tutorials", "index.html"), "utf8"), /<title>Tutorials — Pidrang blog<\/title>/);

    for (const file of ["blog/index.xml", "blog/sitemap.xml", "blog/signal-first-crud/index.html"]) {
      assert.doesNotMatch(await readFile(join(site, file), "utf8"), /generator|lastBuildDate|<generator/i, file);
    }

    assert.deepEqual((await readdir(join(site, "blog-src"))).sort(), ["README.md", "fixtures", "hugo.toml", "layouts", "sync.integration.test.mjs", "sync.mjs", "sync.test.mjs"]);

    const snapshot = await tempDir();
    await cp(join(site, "blog"), join(snapshot, "blog"), { recursive: true });
    const second = await sync({ fixtures: FIXTURES });
    assert.deepEqual(second.change, { added: [], changed: [], removed: [] });
    assert.equal(execFileSync("diff", ["-r", join(snapshot, "blog"), join(site, "blog")], { encoding: "utf8" }), "");
    assert.match(first.report, /### Added \(2\)/);
  } finally {
    await rm(join(site, "blog"), { recursive: true, force: true });
    if (existsSync(join(previousBlog, "blog"))) {
      await cp(join(previousBlog, "blog"), join(site, "blog"), { recursive: true });
    }
  }
});
