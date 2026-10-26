# Pidrang

Landing page for **Pidrang**: generate an Angular admin from your Supabase schema. Build Angular admin applications faster.

Hosted via GitHub Pages at [pidrang.dev](https://pidrang.dev).

Static site: plain HTML and CSS, no build step, no dependencies.

## Demos

The live demos are built in [pidrang/pidrang](https://github.com/pidrang/pidrang) by its `Demo artifacts` workflow and served from this repository under `/demo-material/` and `/demo-tailwind/`. Their files, `404.html` (the only 404 page GitHub Pages uses, shared by both demos) and `metadata.json` (source commit and versions) are generated: do not edit them by hand.

To deploy new demos:

1. In `pidrang/pidrang`, run the `Demo artifacts` workflow manually on the commit to deploy and note its run id.
2. Here, run the `Deploy demos` workflow with that run id. It checks that the run is a successful manual `Demo artifacts` run and that `metadata.json` matches it, then opens a pull request with the files.
3. Merge the pull request to deploy. To roll back, revert it.

Repository settings the workflow needs: Actions may create pull requests, and, while `pidrang/pidrang` is private, a `MONOREPO_READ_TOKEN` secret holding a fine-grained token that can read the Actions of that repository.

## Docs

The documentation at `/docs/` is built in [pidrang/pidrang](https://github.com/pidrang/pidrang) by its `Docs artifacts` workflow (VitePress, sources in its `docs/` folder) and served from this repository under `/docs/`. Its files, including `metadata.json`, are generated: do not edit them by hand.

To deploy new docs:

1. In `pidrang/pidrang`, run the `Docs artifacts` workflow manually on the commit to deploy and note its run id.
2. Here, run the `Deploy docs` workflow with that run id. It checks the run, the artifact and its `metadata.json`, then opens a pull request with the files.
3. Merge the pull request to deploy. To roll back, revert it.

The docs pipeline is separate from the demos: it never touches `demo-material/`, `demo-tailwind/`, `demos/` or the root `404.html`, and a docs fix does not rebuild the Angular applications.

## Blog

The blog at `/blog/` is generated from the Blog category of the discussions of [pidrang/pidrang](https://github.com/pidrang/pidrang) by the `Sync blog` workflow (`.github/workflows/sync-blog.yml`; script and layouts in `blog-src/`). Each discussion is one post; its label picks the category among `blog: tutorials`, `blog: architecture`, `blog: releases`, `blog: community` and `blog: ecosystem`. To write a post or build locally, see `blog-src/README.md`.

Discussion events in `pidrang/pidrang` start the workflow through `blog-dispatch.yml`; it can also be run by hand from the Actions tab (`dry-run` builds and uploads `blog/` without a pull request). A run opens or updates the pull request `blog/sync`. Merging it publishes the posts; to roll back, revert it. A run with no difference closes an open `blog/sync` pull request, since that pull request would be out of date. `blog/` is generated: never edit it by hand.

Repository settings the blog needs:

- Actions may create pull requests.
- `MONOREPO_READ_TOKEN` (optional): a fine-grained token with `Discussions: read` on `pidrang/pidrang`. Without it, the workflow uses `github.token`; set the secret if that token cannot read the discussions.
- In `pidrang/pidrang`, the secret `BLOG_DISPATCH_TOKEN`: a fine-grained token limited to this repository with `Actions: Read and write`, used by `blog-dispatch.yml` to start `sync-blog.yml`.
- Optional variables: `BLOG_SOURCE_REPOSITORY` (default `pidrang/pidrang`, read by `sync-blog.yml`) and `BLOG_SITE_REPOSITORY` (default `pidrang/pidrang.github.io`, read by `blog-dispatch.yml` in `pidrang/pidrang`).

The blog pipeline is independent of the other pipelines: `Sync blog` only touches `blog/`, and `Deploy demos` and `Deploy docs` never touch `blog/` or `blog-src/`.


<!-- Security scan triggered at 2026-10-07 11:56:31 -->