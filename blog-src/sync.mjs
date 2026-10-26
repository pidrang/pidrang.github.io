import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const SITE_ROOT = dirname(SCRIPT_DIR);
export const BLOG_DIR = "blog";
export const ALLOWED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
export const CATEGORY_LABEL_PREFIX = "blog: ";
export const CATEGORIES = ["tutorials", "architecture", "releases", "community", "ecosystem"];
export const META_KEYS = ["slug", "description", "cover", "cover_alt"];
export const REPORT_FOOTER = "Merging publishes these changes to https://pidrang.dev/blog/. To roll back, revert this pull request.";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const COVER_PATTERN = /^\/assets\/blog\/[A-Za-z0-9._-]+$/;
const META_BLOCK_PATTERN = /^\s*<!--([\s\S]*?)-->/;

const CATEGORY_QUERY = `
  query BlogCategory($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      discussionCategory(slug: "blog") {
        id
      }
    }
  }
`;

const DISCUSSIONS_QUERY = `
  query BlogPosts($owner: String!, $name: String!, $categoryId: ID!) {
    repository(owner: $owner, name: $name) {
      discussions(first: 100, categoryId: $categoryId) {
        pageInfo {
          hasNextPage
        }
        nodes {
          number
          title
          body
          createdAt
          updatedAt
          url
          authorAssociation
          author {
            login
            url
          }
          labels(first: 20) {
            nodes {
              name
            }
          }
        }
      }
    }
  }
`;

export const BLOG_SECTION = {
  title: "Blog",
  description: "Articles about Pidrang: tutorials, architecture and release notes.",
};

export function parseMetadataBlock(body) {
  const match = META_BLOCK_PATTERN.exec(body);
  if (!match) {
    return { error: "The body does not start with a metadata block (<!-- ... -->)" };
  }
  const meta = {};
  const errors = [];
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) {
      errors.push(`Metadata line without ":": ${line}`);
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!META_KEYS.includes(key)) {
      errors.push(`Unknown metadata key: ${key}`);
      continue;
    }
    if (key in meta) {
      errors.push(`Duplicate metadata key: ${key}`);
      continue;
    }
    meta[key] = value;
  }
  const content = body.slice(match[0].length).replace(/^\s+/, "");
  return { meta, content, errors };
}

export function authorError(discussion) {
  return ALLOWED_ASSOCIATIONS.includes(discussion.authorAssociation)
    ? undefined
    : `author ${discussion.author?.login ?? "unknown"} is ${discussion.authorAssociation ?? "unknown"}, not an owner, member or collaborator`;
}

export function categoryOf(discussion) {
  const labels = (discussion.labels?.nodes ?? []).map((node) => node.name).filter((name) => name.startsWith(CATEGORY_LABEL_PREFIX));
  if (labels.length === 0) {
    return { error: `no "${CATEGORY_LABEL_PREFIX}<category>" label` };
  }
  if (labels.length > 1) {
    return { error: `several category labels: ${labels.join(", ")}` };
  }
  const category = labels[0].slice(CATEGORY_LABEL_PREFIX.length);
  if (!CATEGORIES.includes(category)) {
    return { error: `unknown category label: ${labels[0]}` };
  }
  return { category };
}

function coverError(cover, siteRoot) {
  if (!COVER_PATTERN.test(cover)) {
    return `cover must match ${COVER_PATTERN.source}`;
  }
  const segments = cover.slice(1).split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return `cover must not contain "." or ".." segments: ${cover}`;
  }
  const file = join(siteRoot, ...segments);
  let stats;
  try {
    stats = statSync(file);
  } catch {
    return `cover file not found in the site repository: ${cover}`;
  }
  if (!stats.isFile()) {
    return `cover is not a file in the site repository: ${cover}`;
  }
  return undefined;
}

export function validateDiscussion(discussion, siteRoot = SITE_ROOT) {
  const errors = [];
  if (!SLUG_PATTERN.test(discussion.slug ?? "")) {
    errors.push(`slug must match ${SLUG_PATTERN.source}: ${JSON.stringify(discussion.slug ?? "")}`);
  }
  if (!Number.isInteger(discussion.number) || discussion.number <= 0) {
    errors.push(`discussion number is invalid: ${discussion.number}`);
  }
  if (typeof discussion.title !== "string" || discussion.title.trim() === "") {
    errors.push("title is empty");
  }
  for (const key of ["createdAt", "updatedAt"]) {
    if (typeof discussion[key] !== "string" || Number.isNaN(Date.parse(discussion[key]))) {
      errors.push(`${key} is not a date`);
    }
  }
  for (const key of ["url", "discussionUrl"]) {
    if (typeof discussion[key] !== "string" || !discussion[key].startsWith("https://github.com/")) {
      errors.push(`${key} is not a GitHub URL`);
    }
  }
  const author = discussion.author;
  if (typeof author?.login !== "string" || author.login === "" || typeof author?.url !== "string") {
    errors.push("author login or profile URL is missing");
  }
  if (discussion.body.includes("user-attachments")) {
    errors.push("the body references user-attachments images, which are not supported");
  }
  if (/<script/i.test(discussion.body)) {
    errors.push("the body contains a <script> tag");
  }

  const parsed = parseMetadataBlock(discussion.body);
  errors.push(...(parsed.errors ?? []));
  const meta = parsed.meta ?? {};
  if (parsed.error !== undefined) {
    errors.push(parsed.error);
  }
  for (const key of META_KEYS) {
    if (meta[key] === "") {
      errors.push(`${key} is empty`);
    }
  }

  const description = meta.description ?? "";
  if (description.length < 1 || description.length > 160) {
    errors.push(`description must be 1 to 160 characters, got ${description.length}`);
  }

  if (meta.cover !== undefined) {
    const error = coverError(meta.cover, siteRoot);
    if (error !== undefined) {
      errors.push(error);
    }
    const alt = meta.cover_alt ?? "";
    if (alt.length < 1 || alt.length > 200) {
      errors.push(`cover_alt is required with a cover, 1 to 200 characters, got ${alt.length}`);
    }
  }

  const category = categoryOf(discussion);
  if (category.error !== undefined) {
    errors.push(category.error);
  }

  return { errors, category: category.category, meta, content: parsed.content ?? discussion.body };
}

export function validateDiscussions(discussions, siteRoot = SITE_ROOT) {
  const errors = [];
  const posts = [];
  const slugs = new Map();
  for (const discussion of discussions) {
    if (authorError(discussion) !== undefined) {
      continue;
    }
    const validation = validateDiscussion(discussion, siteRoot);
    if (typeof discussion.slug === "string" && SLUG_PATTERN.test(discussion.slug)) {
      slugs.set(discussion.slug, [...(slugs.get(discussion.slug) ?? []), discussion]);
    }
    if (validation.errors.length > 0) {
      errors.push({ discussion, messages: validation.errors });
    } else {
      posts.push({ discussion, category: validation.category, meta: validation.meta, content: validation.content });
    }
  }
  for (const [slug, group] of slugs) {
    if (group.length > 1) {
      posts.splice(0, posts.length, ...posts.filter((post) => post.discussion.slug !== slug));
      for (const discussion of group) {
        const message = `slug "${slug}" is used by several discussions: ${group.map((item) => `#${item.number}`).join(", ")}`;
        const existing = errors.find((entry) => entry.discussion.number === discussion.number);
        if (existing) {
        existing.messages.push(message);
        } else {
        errors.push({ discussion, messages: [message] });
        }
      }
    }
  }
  return { errors, posts };
}

export function normalizeDiscussion(raw) {
  const slug = raw.slug ?? parseMetadataBlock(typeof raw.body === "string" ? raw.body : "").meta?.slug;
  return {
    number: raw.number,
    title: raw.title,
    body: typeof raw.body === "string" ? raw.body : "",
    slug,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    url: raw.url,
    authorAssociation: raw.authorAssociation,
    author: raw.author,
    labels: raw.labels,
    discussionUrl: raw.discussionUrl ?? raw.url,
  };
}

export function frontMatter(post) {
  const { discussion, category, meta } = post;
  const data = {
    title: discussion.title,
    description: meta.description,
    date: discussion.createdAt,
    lastmod: discussion.updatedAt,
    slug: discussion.slug,
    categories: [category],
    discussion: discussion.number,
    discussion_url: discussion.discussionUrl,
    author: discussion.author.login,
    author_url: discussion.author.url,
  };
  if (meta.cover !== undefined) {
    data.cover = meta.cover;
    data.cover_alt = meta.cover_alt;
  }
  return data;
}

export function renderPost(post) {
  return `${JSON.stringify(frontMatter(post), null, 2)}\n\n${post.content.trimEnd()}\n`;
}

export function renderContent(posts) {
  const files = new Map();
  files.set("blog/_index.md", `${JSON.stringify(BLOG_SECTION, null, 2)}\n`);
  for (const post of posts) {
    files.set(`blog/${post.discussion.slug}.md`, renderPost(post));
  }
  return files;
}

function compareEntries(before, after) {
  const added = [...after.keys()].filter((slug) => !before.has(slug)).sort();
  const changed = [...after.keys()].filter((slug) => before.has(slug) && before.get(slug) !== after.get(slug)).sort();
  const removed = [...before.keys()].filter((slug) => !after.has(slug)).sort();
  return { added, changed, removed };
}

async function readPosts(root) {
  const posts = new Map();
  const dir = join(root, BLOG_DIR);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return posts;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      posts.set(entry.name, await readFile(join(dir, entry.name, "index.html"), "utf8"));
    } catch {
      continue;
    }
  }
  return posts;
}

export async function compareOutput(beforeDir, afterDir) {
  return compareEntries(await readPosts(beforeDir), await readPosts(afterDir));
}

export function buildReport(after, discussions = []) {
  const urls = new Map();
  for (const discussion of discussions) {
    if (typeof discussion.slug === "string" && typeof discussion.discussionUrl === "string") {
      urls.set(discussion.slug, discussion.discussionUrl);
    }
  }
  const link = (slug) => {
    const url = urls.get(slug);
    return url === undefined ? `- \`${slug}\`` : `- [${slug}](<${url}>)`;
  };
  const lines = ["## Blog sync", ""];
  for (const [heading, slugs] of [
    ["Added", after.added],
    ["Changed", after.changed],
    ["Removed", after.removed],
  ]) {
    lines.push(`### ${heading} (${slugs.length})`, "");
    lines.push(...(slugs.length > 0 ? slugs.map(link) : ["Nothing."]));
    lines.push("");
  }
  lines.push(REPORT_FOOTER, "");
  return lines.join("\n");
}

export function assertOutput(root, entries = readdirSync(root, { withFileTypes: true }).map((entry) => entry.name)) {
  const errors = entries
    .filter((name) => !name.startsWith("."))
    .filter((name) => name !== BLOG_DIR)
    .map((name) => `the build wrote ${name} outside ${BLOG_DIR}/`);
  if (!entries.includes(BLOG_DIR)) {
    errors.push(`the build wrote no ${BLOG_DIR}/`);
  }
  return { errors };
}

export function checkOutput(root, slugs) {
  const { errors } = assertOutput(root);
  for (const slug of slugs) {
    if (!statSync(join(root, BLOG_DIR, slug, "index.html"), { throwIfNoEntry: false })?.isFile()) {
      errors.push(`missing ${BLOG_DIR}/${slug}/index.html`);
    }
  }
  for (const file of ["index.xml", "sitemap.xml"]) {
    if (!statSync(join(root, BLOG_DIR, file), { throwIfNoEntry: false })?.isFile()) {
      errors.push(`missing ${BLOG_DIR}/${file}`);
    }
  }
  return errors;
}

export async function installOutput(publicDir, repoRoot) {
  const generated = resolve(publicDir, BLOG_DIR);
  const errors = assertOutput(publicDir).errors;
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  await rm(resolve(repoRoot, BLOG_DIR), { recursive: true, force: true });
  await cp(generated, resolve(repoRoot, BLOG_DIR), { recursive: true });
}

function ownerAndName(repository) {
  const parts = (repository ?? "").split("/");
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name) {
    throw new Error("SOURCE_REPOSITORY must look like owner/name");
  }
  return { owner, name };
}

async function graphql(token, query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "pidrang-blog-sync",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`GitHub API answered ${response.status}: ${payload.message ?? ""}`.trim());
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`GitHub GraphQL errors: ${payload.errors.map((error) => error.message).join("; ")}`);
  }
  return payload.data;
}

export async function fetchDiscussions({ repository, token, fetchGraphql = graphql }) {
  const { owner, name } = ownerAndName(repository);
  const category = await fetchGraphql(token, CATEGORY_QUERY, { owner, name });
  const categoryId = category.repository?.discussionCategory?.id;
  if (categoryId === undefined) {
    throw new Error(`The repository ${owner}/${name} has no "blog" discussion category`);
  }
  const data = await fetchGraphql(token, DISCUSSIONS_QUERY, { owner, name, categoryId });
  const connection = data.repository?.discussions;
  if (connection?.pageInfo?.hasNextPage) {
    throw new Error("The Blog category has more than 100 discussions: pagination is not supported");
  }
  return (connection?.nodes ?? []).map((node) => normalizeDiscussion(node));
}

export async function loadFixtures(file) {
  const raw = JSON.parse(await readFile(file, "utf8"));
  const nodes = Array.isArray(raw) ? raw : raw.discussions;
  if (!Array.isArray(nodes)) {
    throw new Error(`${file} holds no discussions array`);
  }
  return nodes.map(normalizeDiscussion);
}

export function parseArgs(argv) {
  const options = { fixtures: undefined, report: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--fixtures" || arg === "--report") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${arg} needs a file`);
      }
      options[arg.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

async function runHugo(contentDir, destination, workDir) {
  const hugo = process.env.HUGO_BIN || "hugo";
  await execFileAsync(
    hugo,
    [
      "--source", SCRIPT_DIR,
      "--contentDir", contentDir,
      "--destination", destination,
      "--cleanDestinationDir",
      "--noBuildLock",
      "--cacheDir", join(workDir, "cache"),
    ],
    { env: { ...process.env, HUGO_ENVIRONMENT: "production" } },
  );
}

export async function sync(options, env = process.env) {
  const siteRoot = options.siteRoot ?? SITE_ROOT;
  const discussions = options.fixtures !== undefined
    ? await loadFixtures(options.fixtures)
    : await fetchDiscussionsFromEnv(env);

  for (const discussion of discussions) {
    const why = authorError(discussion);
    if (why !== undefined) {
      console.log(`Skipped discussion #${discussion.number} ${discussion.url}: ${why}`);
    }
  }
  const kept = discussions.filter((discussion) => authorError(discussion) === undefined);
  const { errors, posts } = validateDiscussions(kept, siteRoot);

  if (errors.length > 0) {
    const lines = errors.flatMap(({ discussion, messages }) => messages.map((message) => `#${discussion.number} ${discussion.url}: ${message}`));
    throw new Error(`${lines.join("\n")}\n${errors.length} invalid discussion(s), nothing written`);
  }

  const work = await mkdtemp(join(tmpdir(), "pidrang-blog-"));
  try {
    const contentDir = join(work, "content");
    const publicDir = join(work, "public");
    for (const [path, text] of renderContent(posts)) {
      await mkdir(dirname(join(contentDir, path)), { recursive: true });
      await writeFile(join(contentDir, path), text);
    }
    await runHugo(contentDir, publicDir, work);
    const outputErrors = checkOutput(publicDir, posts.map((post) => post.discussion.slug));
    if (outputErrors.length > 0) {
      throw new Error(`Unexpected Hugo output: ${outputErrors.join("; ")}`);
    }
    const change = await compareOutput(siteRoot, publicDir);
    await installOutput(publicDir, siteRoot);
    const report = buildReport(change, discussions);
    return { change, report };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function fetchDiscussionsFromEnv(env) {
  if (!env.SOURCE_REPOSITORY) {
    throw new Error("SOURCE_REPOSITORY is not set (owner/name of the repository holding the Blog discussions)");
  }
  if (!env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is not set");
  }
  return fetchDiscussions({ repository: env.SOURCE_REPOSITORY, token: env.GITHUB_TOKEN });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { change, report } = await sync(options);
  if (options.report !== undefined) {
    await writeFile(options.report, report);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, report, { flag: "a" });
  }
  console.log(`Added: ${change.added.join(", ") || "none"}`);
  console.log(`Changed: ${change.changed.join(", ") || "none"}`);
  console.log(`Removed: ${change.removed.join(", ") || "none"}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
