import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  assertOutput,
  authorError,
  buildReport,
  compareOutput,
  fetchDiscussions,
  frontMatter,
  loadFixtures,
  normalizeDiscussion,
  parseArgs,
  parseMetadataBlock,
  SCRIPT_DIR,
  SITE_ROOT,
  sync,
  validateDiscussion,
  validateDiscussions,
} from "./sync.mjs";

const DESCRIPTION = "A short description.";
const FIXTURES = join(SCRIPT_DIR, "fixtures", "discussions.json");
const URL_7 = "https://github.com/pidrang/pidrang/discussions/7";
const URL_42 = "https://github.com/pidrang/pidrang/discussions/42";

const temporaryDirs = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "blog-test-"));
  temporaryDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function block(lines) {
  return `<!--\n${lines.join("\n")}\n-->\nThe body.\n`;
}

function discussion(overrides = {}) {
  return {
    number: 7,
    title: "A post",
    body: block(["slug: a-post", `description: ${DESCRIPTION}`]),
    createdAt: "2026-10-20T09:30:00Z",
    updatedAt: "2026-10-21T09:30:00Z",
    url: URL_7,
    discussionUrl: URL_7,
    authorAssociation: "OWNER",
    author: { login: "fetrarij", url: "https://github.com/fetrarij" },
    labels: { nodes: [{ name: "blog: tutorials" }] },
    ...overrides,
    number: overrides.number ?? 7,
    slug: overrides.slug ?? "a-post",
  };
}

function messages(item) {
  return validateDiscussions([item]).errors.flatMap((entry) => entry.messages).join("\n");
}

function isValid(item) {
  return validateDiscussions([item]).errors.length === 0;
}

test("author filter keeps owners, members and collaborators", () => {
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    assert.equal(authorError(discussion({ authorAssociation: association })), undefined);
  }
  for (const association of ["CONTRIBUTOR", "NONE"]) {
    assert.match(authorError(discussion({ authorAssociation: association })), /not an owner, member or collaborator/);
  }
  const skipped = validateDiscussions([
    discussion({ number: 1, authorAssociation: "NONE" }),
    discussion({ number: 2 }),
  ]);
  assert.deepEqual(skipped.errors, []);
  assert.deepEqual(skipped.posts.map((post) => post.discussion.number), [2]);
});

test("slug format", () => {
  assert.ok(isValid(discussion()));
  assert.ok(isValid(discussion({ slug: "a" })));
  assert.ok(isValid(discussion({ slug: "release-0-1-1" })));
  for (const slug of ["A-post", "a_post", "-a", "a-", "a--b", "", "a b"]) {
    assert.match(messages(discussion({ slug })), /slug must match/, slug);
  }
});

test("slug uniqueness flags each discussion", () => {
  const result = validateDiscussions([discussion({ number: 1 }), discussion({ number: 2, title: "Other" })]);
  assert.equal(result.errors.length, 2);
  assert.deepEqual(result.errors.map((entry) => entry.discussion.number).sort(), [1, 2]);
  assert.ok(result.errors.every((entry) => entry.messages.some((message) => message.includes("several discussions"))));
  assert.equal(result.posts.length, 0);
});

test("description length and single line", () => {
  assert.ok(isValid(discussion({ body: block(["slug: a-post", `description: ${"x".repeat(160)}`]) })));
  assert.match(messages(discussion({ body: block(["slug: a-post", `description: ${"x".repeat(161)}`]) })), /1 to 160/);
  const empty = discussion({ body: block(["slug: a-post", "description:"]) });
  assert.match(messages(empty), /1 to 160/);
  assert.match(messages(empty), /1 to 160/);
  const multiLine = "<!--\nslug: a-post\ndescription: first\nsecond\n-->\nBody.\n";
  assert.match(messages(discussion({ body: multiLine })), /Metadata line without/);
  const twoDescriptions = discussion({ body: block(["slug: a-post", `description: ${DESCRIPTION}`, `description: ${DESCRIPTION}`]) });
  assert.match(messages(twoDescriptions), /Duplicate metadata key: description/);
});

test("cover path and traversal", async () => {
  const withCover = (cover, alt = "A cover") => block(["slug: a-post", `description: ${DESCRIPTION}`, `cover: ${cover}`, `cover_alt: ${alt}`]);

  for (const cover of ["assets/blog/x.png", "/assets/x.png", "/assets/blog/a/b.png", "/assets/blog/../logo/x.png", "/assets/blog/", "/assets/blog/x.png?raw=1"]) {
    const result = validateDiscussion(discussion({ body: withCover(cover) }), SITE_ROOT);
    assert.ok(result.errors.some((message) => message.startsWith("cover must match")), cover);
  }
  for (const cover of ["/assets/blog/..", "/assets/blog/."]) {
    const result = validateDiscussion(discussion({ body: withCover(cover) }), SITE_ROOT);
    assert.equal(result.errors.length, 1, cover);
    assert.match(result.errors[0], /must not contain "\." or "\.\." segments/, cover);
  }
  assert.match(messages(discussion({ body: withCover("/assets/blog/missing.png") })), /cover file not found/);
});

test("cover must be a regular file", async () => {
  const siteRoot = await tempDir();
  await mkdir(join(siteRoot, "assets", "blog", "folder"), { recursive: true });
  const withCover = (cover) => block(["slug: a-post", `description: ${DESCRIPTION}`, `cover: ${cover}`, "cover_alt: A cover"]);
  const errors = validateDiscussion(discussion({ body: withCover("/assets/blog/folder") }), siteRoot).errors;
  assert.deepEqual(errors, ["cover is not a file in the site repository: /assets/blog/folder"]);
});

test("cover file is looked up under the site root", async () => {
  const siteRoot = await tempDir();
  await mkdir(join(siteRoot, "assets", "blog"), { recursive: true });
  await writeFile(join(siteRoot, "assets", "blog", "present.png"), "");
  const withCover = (cover) => block(["slug: a-post", `description: ${DESCRIPTION}`, `cover: ${cover}`, "cover_alt: A cover"]);

  const check = (root, file) => validateDiscussion(discussion({ body: withCover(file) }), root).errors;
  assert.deepEqual(check(siteRoot, "/assets/blog/missing.png"), ["cover file not found in the site repository: /assets/blog/missing.png"]);
  assert.deepEqual(check(siteRoot, "/assets/blog/present.png"), []);
  assert.deepEqual(check(join(siteRoot, "assets"), "/assets/blog/present.png"), ["cover file not found in the site repository: /assets/blog/present.png"]);
  const parsed = parseMetadataBlock(withCover("/assets/blog/present.png"));
  assert.equal(parsed.meta.cover, "/assets/blog/present.png");
  assert.equal(parsed.meta.cover_alt, "A cover");
  assert.match(messages(discussion({ body: block(["slug: a-post", `description: ${DESCRIPTION}`, "cover:", "cover_alt: A cover"]) })), /cover is empty/);
});

test("cover_alt is required with a cover, 1 to 200 characters", async () => {
  const siteRoot = await tempDir();
  await mkdir(join(siteRoot, "assets", "blog"), { recursive: true });
  await writeFile(join(siteRoot, "assets", "blog", "present.png"), "");
  const withAlt = (coverAlt) => block([
    "slug: a-post",
    `description: ${DESCRIPTION}`,
    "cover: /assets/blog/present.png",
    ...(coverAlt === undefined ? [] : [`cover_alt: ${coverAlt}`]),
  ]);
  const errorsFor = (body) => validateDiscussion(discussion({ body }), siteRoot).errors.join("\n");
  assert.match(errorsFor(withAlt(undefined)), /cover_alt is required/);
  assert.match(errorsFor(withAlt("")), /cover_alt is required/);
  assert.match(errorsFor(withAlt("x".repeat(201))), /cover_alt is required/);
  assert.doesNotMatch(errorsFor(withAlt("x".repeat(200))), /cover_alt/);
  assert.deepEqual(validateDiscussion(discussion(), siteRoot).errors, []);
});

test("category labels", () => {
  assert.equal(validateDiscussion(discussion()).category, "tutorials");
  assert.match(messages(discussion({ labels: { nodes: [] } })), /no "blog: <category>" label/);
  assert.match(messages(discussion({ labels: { nodes: [{ name: "blog: tutorials" }, { name: "blog: releases" }] } })), /several category labels/);
  assert.match(messages(discussion({ labels: { nodes: [{ name: "blog: news" }] } })), /unknown category label/);
  assert.ok(isValid(discussion({ labels: { nodes: [{ name: "bug" }, { name: "blog: community" }] } })));
  assert.ok(isValid(discussion({ labels: { nodes: [{ name: "blog:tutorials" }, { name: "blog: ecosystem" }] } })));
});

test("body refusals", () => {
  const withText = (text) => `${block(["slug: a-post", `description: ${DESCRIPTION}`])}${text}`;
  assert.match(messages(discussion({ body: withText("![x](https://github.com/user-attachments/assets/1)") })), /user-attachments/);
  assert.match(messages(discussion({ body: withText("<script>alert(1)</script>") })), /<script>/);
  assert.match(messages(discussion({ body: withText("<SCRIPT src=x>") })), /<script>/);
  assert.ok(isValid(discussion({ body: withText("<strong>bold</strong>") })));
});

test("metadata block presence and syntax", () => {
  assert.match(messages(discussion({ body: `slug: a-post\ndescription: ${DESCRIPTION}\n` })), /does not start with a metadata block/);
  assert.match(messages(discussion({ body: block(["slug: a-post", `description: ${DESCRIPTION}`, "tags: x"]) })), /Unknown metadata key: tags/);
  const emptySlug = discussion({ body: block(["slug:", `description: ${DESCRIPTION}`]) });
  emptySlug.slug = "";
  assert.match(messages(emptySlug), /slug is empty/);
  const missingSlug = discussion({ body: block([`description: ${DESCRIPTION}`]) });
  missingSlug.slug = undefined;
  assert.match(messages(missingSlug), /slug must match/);
  assert.match(messages(discussion({ body: block(["slug: a-post", "no colon here"]) })), /Metadata line without/);
});

test("CRLF line endings and leading blank lines are accepted", () => {
  const body = `\r\n\r\n<!--\r\nslug: a-post\r\ndescription: ${DESCRIPTION}\r\n-->\r\nBody.\r\n`;
  const parsed = parseMetadataBlock(body);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.meta.slug, "a-post");
  assert.equal(parsed.content, "Body.\r\n");
  assert.ok(isValid(discussion({ body })));
});

test("spaces and blank lines before the metadata block are accepted", () => {
  const body = `\n  \n<!--\nslug: a-post\ndescription: ${DESCRIPTION}\n-->\n\n  The body.\n`;
  const parsed = parseMetadataBlock(body);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.content, "The body.\n");
  assert.ok(isValid(discussion({ body })));
  assert.ok(parseMetadataBlock(`  <!--\nslug: a-post\n-->`).meta);
  assert.match(parseMetadataBlock(`text\n<!--\nslug: a-post\n-->`).error, /does not start with a metadata block/);
});

test("a leading h1 in the body is dropped, since the layout renders the title", () => {
  const body = `<!--\nslug: a-post\ndescription: ${DESCRIPTION}\n-->\n# The post title\n\nThe body.\n`;
  assert.equal(parseMetadataBlock(body).content, "The body.\n");
  const kept = `<!--\nslug: a-post\ndescription: ${DESCRIPTION}\n-->\nIntro.\n\n# A section\n`;
  assert.match(parseMetadataBlock(kept).content, /^Intro\./);
});

test("every error is collected with number and URL", () => {
  const bad = discussion({ number: 42, url: URL_42, slug: "Bad Slug", body: "No block\nuser-attachments\n<script>", labels: { nodes: [] } });
  const result = validateDiscussions([bad]);
  assert.equal(result.errors.length, 1);
  const [entry] = result.errors;
  assert.equal(entry.discussion.number, 42);
  assert.equal(entry.discussion.url, URL_42);
  assert.ok(entry.messages.length >= 5);
});

test("front matter is JSON that survives quotes and colons", () => {
  const title = 'The "resource" API: a look at signals';
  const result = validateDiscussions([discussion({ title })]);
  const data = frontMatter(result.posts[0]);
  assert.equal(data.title, title);
  assert.deepEqual(data.categories, ["tutorials"]);
  assert.equal(data.discussion, 7);
  assert.equal(data.discussion_url, URL_7);
  assert.equal(data.author, "fetrarij");
  assert.ok(!("cover" in data));
  assert.equal(result.posts[0].content, "The body.\n");
});

test("report lists added, changed and removed slugs", () => {
  const report = buildReport(
    { added: ["new-post"], changed: ["edited-post"], removed: ["gone-post"] },
    [discussion({ slug: "new-post", discussionUrl: "https://github.com/pidrang/pidrang/discussions/20" })],
  );
  assert.match(report, /### Added \(1\)\n\n- \[new-post\]\(<https:\/\/github.com\/pidrang\/pidrang\/discussions\/20>\)/);
  assert.match(report, /### Changed \(1\)\n\n- `edited-post`/);
  assert.match(report, /### Removed \(1\)\n\n- `gone-post`/);
  assert.ok(report.trimEnd().endsWith("To roll back, revert this pull request."));
});

test("output check refuses a file outside blog/", async () => {
  const root = await tempDir();
  await mkdir(join(root, "blog"), { recursive: true });
  await writeFile(join(root, "index.html"), "");
  const { errors } = assertOutput(root);
  assert.ok(errors.some((message) => message.includes("outside blog/")));
  const clean = await tempDir();
  await mkdir(join(clean, "blog"), { recursive: true });
  assert.deepEqual(assertOutput(clean).errors, []);
  assert.deepEqual(assertOutput(join(clean, "blog")).errors.map((message) => message.includes("outside")), [false]);
});

test("compareOutput detects added, changed and removed posts", async () => {
  const before = await tempDir();
  const afterDir = await tempDir();
  for (const [root, edits] of [[before, { kept: "old", gone: "x" }], [afterDir, { kept: "new", fresh: "y" }]]) {
    for (const [slug, text] of Object.entries(edits)) {
      await mkdir(join(root, "blog", slug), { recursive: true });
      await writeFile(join(root, "blog", slug, "index.html"), text);
    }
  }
  assert.deepEqual(await compareOutput(before, afterDir), { added: ["fresh"], changed: ["kept"], removed: ["gone"] });
});

test("arguments", () => {
  assert.deepEqual(parseArgs([]), { fixtures: undefined, report: undefined });
  assert.deepEqual(parseArgs(["--fixtures", "a.json", "--report", "b.md"]), { fixtures: "a.json", report: "b.md" });
  assert.throws(() => parseArgs(["--fixtures"]), /needs a file/);
  assert.throws(() => parseArgs(["--other"]), /Unknown option/);
});

test("fixtures hold two valid posts", async () => {
  const fixtures = await loadFixtures(FIXTURES);
  assert.equal(fixtures.length, 2);
  const { errors, posts } = validateDiscussions(fixtures);
  assert.deepEqual(errors, []);
  assert.deepEqual(posts.map((post) => post.discussion.slug).sort(), ["signal-first-crud", "ui-agnostic-core"]);
  assert.deepEqual(posts.map((post) => post.category).sort(), ["architecture", "tutorials"]);
});

test("an invalid post writes nothing and names the discussion", async () => {
  const site = await tempDir();
  await mkdir(join(site, "blog", "kept"), { recursive: true });
  await writeFile(join(site, "blog", "kept", "index.html"), "kept");
  const fixtures = join(site, "fixtures.json");
  await writeFile(fixtures, JSON.stringify([normalizeDiscussion(discussion({ number: 99, slug: "Bad Slug" }))]));
  const before = await readdir(join(site, "blog"), { recursive: true });
  const beforeText = await readFile(join(site, "blog", "kept", "index.html"), "utf8");
  await assert.rejects(sync({ fixtures, siteRoot: site }), (error) => {
    assert.match(error.message, /^#99 https:\/\/github\.com\/pidrang\/pidrang\/discussions\/7: .*slug must match[\s\S]*nothing written$/);
    return true;
  });
  assert.deepEqual(await readdir(join(site, "blog"), { recursive: true }), before);
  assert.equal(await readFile(join(site, "blog", "kept", "index.html"), "utf8"), beforeText);
});

test("normalizeDiscussion reads the slug from the metadata block", () => {
  const node = {
    number: 5,
    title: "Post",
    body: block(["slug: from-body", `description: ${DESCRIPTION}`]),
    createdAt: "2026-10-20T09:30:00Z",
    updatedAt: "2026-10-20T09:30:00Z",
    url: "https://github.com/pidrang/pidrang/discussions/5",
    authorAssociation: "MEMBER",
    author: { login: "someone", url: "https://github.com/someone" },
    labels: { nodes: [{ name: "blog: releases" }] },
  };
  const normalized = normalizeDiscussion(node);
  assert.equal(normalized.slug, "from-body");
  assert.equal(normalized.discussionUrl, node.url);
  assert.equal(normalizeDiscussion({ ...node, slug: "explicit" }).slug, "explicit");
  assert.equal(normalizeDiscussion({ ...node, body: "no block" }).slug, undefined);
});

test("fetchDiscussions reads the blog category and the discussions", async () => {
  const calls = [];
  const fetchGraphql = async (_token, query, variables) => {
    calls.push({ query, variables });
    if (query.includes("discussionCategory(slug")) {
      return { repository: { discussionCategory: { id: "DIC_test" } } };
    }
    return {
      repository: {
        discussions: {
          pageInfo: { hasNextPage: false },
          nodes: [{
            number: 5,
            title: "Post",
            body: block(["slug: from-body", `description: ${DESCRIPTION}`]),
            createdAt: "2026-10-20T09:30:00Z",
            updatedAt: "2026-10-20T09:30:00Z",
            url: "https://github.com/pidrang/pidrang/discussions/5",
            authorAssociation: "MEMBER",
            author: { login: "someone", url: "https://github.com/someone" },
            labels: { nodes: [{ name: "blog: releases" }] },
          }],
        },
      },
    };
  };
  const discussions = await fetchDiscussions({ repository: "pidrang/pidrang", token: "t", fetchGraphql });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].variables.owner, "pidrang");
  assert.equal(calls[1].variables.categoryId, "DIC_test");
  assert.equal(calls[1].variables.owner, "pidrang");
  assert.equal(calls[1].variables.name, "pidrang");
  assert.ok(calls[1].query.includes("discussions(first: 100, categoryId: $categoryId)"));
  assert.equal(/type DiscussionCategory/.test(calls[1].query), false);
  assert.equal(discussions[0].slug, "from-body");
  assert.equal(discussions[0].discussionUrl, "https://github.com/pidrang/pidrang/discussions/5");
  assert.deepEqual(validateDiscussions(discussions).errors, []);
});

test("fetchDiscussions fails on missing category, API errors and pagination", async () => {
  const missing = async () => ({ repository: { discussionCategory: null } });
  await assert.rejects(fetchDiscussions({ repository: "pidrang/pidrang", token: "t", fetchGraphql: missing }), /no "blog" discussion category/);
  const failing = async () => {
    throw new Error("GitHub GraphQL errors: boom");
  };
  await assert.rejects(fetchDiscussions({ repository: "pidrang/pidrang", token: "t", fetchGraphql: failing }), /boom/);
  const paginated = async (_token, query) => (query.includes("discussionCategory(slug")
    ? { repository: { discussionCategory: { id: "DIC_test" } } }
    : { repository: { discussions: { pageInfo: { hasNextPage: true }, nodes: [] } } });
  await assert.rejects(fetchDiscussions({ repository: "pidrang/pidrang", token: "t", fetchGraphql: paginated }), /more than 100/);
  await assert.rejects(fetchDiscussions({ repository: "pidrang", token: "t", fetchGraphql: missing }), /owner\/name/);
});

test("missing environment fails clearly", async () => {
  await assert.rejects(sync({}, {}), /SOURCE_REPOSITORY is not set/);
  await assert.rejects(sync({}, { SOURCE_REPOSITORY: "pidrang/pidrang" }), /GITHUB_TOKEN is not set/);
});

test("the real Hugo build works and is reproducible", { skip: process.env.HUGO_BIN === undefined ? "HUGO_BIN is not set" : false }, async () => {
  const site = await tempDir();
  const first = await sync({ fixtures: FIXTURES, siteRoot: site });
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
    assert.ok((await statSync(join(site, file))).size > 0, file);
  }

  const post = await readFile(join(site, "blog", "signal-first-crud", "index.html"), "utf8");
  assert.match(post, /<script type="application\/ld\+json">\{"@context":"https:\/\/schema.org","@type":"BlogPosting"/);
  assert.match(post, /data-term="12"/);
  assert.match(post, /data-repo="pidrang\/pidrang"/);
  assert.match(post, /data-goatcounter="https:\/\/pidrang.goatcounter.com\/count"/);
  assert.match(post, /href="https:\/\/github.com\/pidrang\/pidrang\/discussions\/12"/);
  assert.match(post, /<time datetime="2026-10-20T09:30:00Z">2026-10-20<\/time>[\s\S]*in <a [^>]*>tutorials<\/a>[\s\S]*By <a href="https:\/\/github.com\/fetrarij">fetrarij<\/a>/);
  assert.match(post, /<table>/);
  assert.match(post, /&ldquo;resource&rdquo;/);
  assert.doesNotMatch(post, /Published /);

  const list = await readFile(join(site, "blog", "index.html"), "utf8");
  assert.ok(list.indexOf("signal-first-crud") < list.indexOf("ui-agnostic-core"));
  assert.doesNotMatch(list, /giscus/);
  assert.match(await readFile(join(site, "blog", "categories", "tutorials", "index.html"), "utf8"), /<title>Tutorials — Pidrang blog<\/title>/);

  for (const file of ["blog/index.xml", "blog/sitemap.xml", "blog/signal-first-crud/index.html"]) {
    assert.doesNotMatch(await readFile(join(site, file), "utf8"), /generator|lastBuildDate|<generator/i, file);
  }

  const snapshot = await tempDir();
  await cp(join(site, "blog"), join(snapshot, "blog"), { recursive: true });
  const second = await sync({ fixtures: FIXTURES, siteRoot: site });
  assert.deepEqual(second.change, { added: [], changed: [], removed: [] });
  assert.equal(execFileSync("diff", ["-r", join(snapshot, "blog"), join(site, "blog")], { encoding: "utf8" }), "");
  assert.match(first.report, /### Added \(2\)/);

  const source = await readdir(SCRIPT_DIR);
  assert.ok(!source.includes(".hugo_build.lock"), ".hugo_build.lock in blog-src/");
  assert.ok(!source.includes("resources"), "resources/ in blog-src/");
});
