# Bundled dependency notices

`scripts/license-notices.ts` collects license, copyright and notice files from
the versions Cargo and Bun resolve. It also includes nested vendored notices,
the app's AGPL license, Sparkle and the web build helpers that contribute code
to the client. It writes into the built app, without changing source files.

Sparkle's license is copied verbatim from its pinned release artifact:
https://github.com/sparkle-project/Sparkle/blob/2.10.1/LICENSE

Some Rust crate archives omit their repository's license. Each fallback under
`rust/<name>-<version>/` includes upstream files from the commit identified by
that crate's `.cargo_vcs_info.json`. `SOURCES.json` records the immutable URLs
and SHA-256 hashes. The generator checks those hashes and fails for an unknown
version. When upgrading one of these crates, fetch its notices from its own
commit instead of renaming an old directory.

The objc2 repository provides a licensing policy with links to standard
license forms. The MIT option is used for those crates; the standard form from
https://spdx.org/licenses/MIT.txt is included alongside the unchanged upstream
policy and author information from Cargo metadata. Template placeholders in
that standard form are retained verbatim and do not assign copyright.
