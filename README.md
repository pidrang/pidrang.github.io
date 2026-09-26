# Pidrang

Landing page for **Pidrang**, an open-source headless framework for building Angular admin applications faster.

Hosted via GitHub Pages at [pidrang.dev](https://pidrang.dev).

Static site: plain HTML and CSS, no build step, no dependencies.

## Demos

The live demos are built in [pidrang/pidrang](https://github.com/pidrang/pidrang) by its `Demo artifacts` workflow and served from this repository under `/demo-material/` and `/demo-tailwind/`. Their files, `404.html` (the only 404 page GitHub Pages uses, shared by both demos) and `metadata.json` (source commit and versions) are generated: do not edit them by hand.

To deploy new demos:

1. In `pidrang/pidrang`, run the `Demo artifacts` workflow manually on the commit to deploy and note its run id.
2. Here, run the `Deploy demos` workflow with that run id. It checks that the run is a successful manual `Demo artifacts` run and that `metadata.json` matches it, then opens a pull request with the files.
3. Merge the pull request to deploy. To roll back, revert it.

Repository settings the workflow needs: Actions may create pull requests, and, while `pidrang/pidrang` is private, a `MONOREPO_READ_TOKEN` secret holding a fine-grained token that can read the Actions of that repository.
