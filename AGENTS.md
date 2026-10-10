# AGENTS.md

Rules for agents and maintainers who work in this repository. This file is tracked, so it is also published. Do not put internal discussion, issue text or private names here.

## Two remotes

| Remote | Repository | Visibility | Use |
|---|---|---|---|
| `public` | `githonllc/avouch` | public | All code: branches, pull requests, CI, review, releases (`release.yml` runs only here), and the issues of outside users. |
| `internal` | `githonllc/avouch-internal` | private | Internal issue tracking and discussion only. No code, no branches, no pull requests, no releases. |

Local setup, once per clone:

```sh
git config branch.main.remote public
gh repo set-default githonllc/avouch
```

## Rules

1. Push branches only to `public`, and open pull requests on `public`. Never push a branch or a tag to `internal`.
2. The baseline for a review or a diff is `public/main` (`git fetch public`, then `public/main..HEAD`).
3. Everything on `public` is public, including commit messages, pull request text, branch names, authors and emails, and it cannot be taken back. Write it as public text: no internal issue text, internal links, private names or customer names.
4. Internal issues and the two repositories' numbers: both repositories number their issues from 1, so a bare `#n` is ambiguous. On `public`, `#n` means a public issue or pull request. Do not refer to internal issues from `public` at all; restate what a public reader needs instead. In an internal issue, link public work as `githonllc/avouch#<n>`.
5. The private-content scan (`scripts/scan-private.mjs`) runs in CI and in the release workflow on `public`. Run it locally with the private patterns before you push, because the CI scan runs after the push.

## Release

A release needs the explicit approval of the project owner. The steps are in "Publishing" in `README.md`: merge the version change on `public`, tag the merge commit `v<version>`, push the tag to `public`, and the owner approves the `npm` environment. `release.yml` has `if: github.repository == 'githonllc/avouch'`, so a tag in any other repository publishes nothing.
