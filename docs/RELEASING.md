# Release operations

Release Please owns `package.json` version changes, `.release-please-manifest.json`,
`CHANGELOG.md`, tags, and GitHub releases. Do not edit those generated release
artifacts by hand. Fix Conventional Commit inputs or the Release Please
configuration instead.

## Routine release

1. Merge releasable Conventional Commits into `main`. `feat:` is minor, `fix:`
   is patch, and a `!` or `BREAKING CHANGE:` footer is breaking. Review public
   CLI and runtime contracts rather than relying only on commit labels.
2. Let Release Please update its release PR. Before merging that PR, verify its
   exact version and changelog and run the complete release gate from a clean
   checkout:

   ```sh
   pnpm install --frozen-lockfile
   pnpm run check
   pnpm run validate:browser-use
   pnpm run validate:package:linux
   pnpm audit
   pnpm run validate:docs
   git diff --check
   ```

3. Merge the reviewed release PR. The Release Please workflow creates the tag
   and GitHub release, then the `npm` environment publishes the exact released
   commit as a public package. The publish job uses npm trusted publishing with
   GitHub Actions OIDC; it must not receive a long-lived npm token.
4. Verify the GitHub release, registry version, provenance, installed CLI
   version, and clean supervisor shutdown.

The hosted CI gate runs the reproducible current-platform, audit, and Node 22
Linux package checks. The external Browser Use gate remains a maintainer-run
release check because browser installation and control stay outside this
repository.

## `0.1.0` registry bootstrap

npm requires a package to exist before it can be assigned a trusted publisher.
The first `@sjunepark/htmlview@0.1.0` publication is therefore the only manual
registry bootstrap:

1. Review and merge the initial Release Please PR, which must target `0.1.0`.
   Let the workflow create `v0.1.0`; its first publish attempt cannot use OIDC
   yet. The workflow retains its exact Linux-built tarball as the
   `npm-package-0.1.0` artifact.
2. Download that artifact from the failed workflow run, authenticate the npm
   CLI interactively, and publish the retained tarball:

   ```sh
   candidate_dir="$(mktemp -d)"
   gh run download <run-id> --name npm-package-0.1.0 --dir "$candidate_dir"
   tarball="$(find "$candidate_dir" -type f -name '*.tgz' -print -quit)"
   npm publish "$tarball" --access public
   ```

   Do not rebuild the bootstrap artifact on another platform. Generated source
   maps make otherwise equivalent macOS and Linux package archives differ at
   the byte level.

3. In npm package settings, add the GitHub Actions trusted publisher with these
   exact values:

   - organization or user: `sjunepark`
   - repository: `htmlview`
   - workflow filename: `release-please.yml`
   - environment: `npm`
   - allowed action: `npm publish`

4. Rerun the failed publish job. It compares the registry integrity with the
   retained Linux tarball and treats exact `0.1.0` bytes as success. Future
   versions publish with short-lived OIDC credentials and automatic provenance.

Do not create a permanent npm automation token as a bootstrap shortcut. If a
release job fails, fix and rerun the documented pipeline; do not hand-edit a
tag, manifest, changelog, version, or GitHub release.
