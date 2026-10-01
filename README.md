# attic-action

Cache Nix derivations with [Attic](https://github.com/zhaofengli/attic).

## Usage

Configure your Attic instance with an endpoint, a cache, and a token that can read from and write to the cache. Then, add this step to a workflow job after Nix is installed:

```yaml
- name: Setup Attic cache
  uses: ryanccn/attic-action@v0
  with:
    endpoint: ${{ secrets.ATTIC_ENDPOINT }}
    cache: ${{ secrets.ATTIC_CACHE }}
    token: ${{ secrets.ATTIC_TOKEN }}
    path-discovery-mode: post-build-hook # or `store-scan`, which is the default if omitted
```

## Inputs

### `endpoint`

The Attic endpoint. This is the URL without the cache name.

### `cache`

The name of the Attic cache.

### `token`

The authorization token to provide to Attic (**optional**).

### `inputs-from`

Path to get the Nixpkgs flake input from instead of `github:NixOS/nixpkgs/nixpkgs-unstable` when installing Attic (**optional**).

### `push-args`

Additional command-line arguments to pass to `attic push` (**optional**).

### `skip-push`

Disable pushing new derivations to the cache automatically at the end of the job (**default is false**).

This requires you to invoke `attic push <cache>` with the paths you want to push to the cache manually.

### `path-discovery-mode`

How to discover store paths to push automatically (**default is `store-scan`**).

- `store-scan` snapshots `/nix/store` before and after the job and pushes the difference. This is the existing behavior and captures paths that were substituted during the job.
- `post-build-hook` installs a Nix post-build hook and pushes only paths Nix built locally via `OUT_PATHS`. This avoids paths that were merely substituted from another cache, but requires the workflow user to be allowed to set Nix's `post-build-hook` option.

Hook setup probes the active Nix store for client trust. If the store explicitly reports that the client is untrusted, setup fails. If trust cannot be determined, setup warns and continues; the daemon might ignore the hook. There is no automatic fallback to `store-scan`.

> [!WARNING]
> Run `attic-action` **after** other hook-installing actions (such as `cachix/cachix-action`) and **before** the builds you want to cache. Nix has a single effective `post-build-hook`; Attic chains the hook that is effective when setup runs.
>
> Attic installs its collector through `NIX_CONFIG`, which takes precedence over config files. A hook installed **later through a config file** (for example, through `NIX_USER_CONF_FILES`) is shadowed while the Attic overlay remains active: that later hook is not called or chained. This ordering does not bypass Attic; it silently drops the later hook.

Chained hooks run directly first. If the operating system reports an executable-format error (`ENOEXEC`, for example a script with whitespace before its shebang), Attic retries it with `/bin/sh`, matching Nix's `execvp` shell fallback. Arguments and environment are preserved; missing or non-executable hooks still fail, and the final hook result is propagated after recording captures and diagnostics.

Preserve the inherited `NIX_CONFIG` when adding settings after setup:

- A build step with its own `env: NIX_CONFIG` replaces the inherited value **for that step only**, bypassing Attic capture for its builds unless the collector setting is preserved.
- Replacing `NIX_CONFIG` through `GITHUB_ENV` bypasses capture for **all later steps that inherit that replacement**, until the collector setting is restored. Initial workflow/job-level environment values do not override the value subsequently exported by Attic.
- Append new settings to the existing value rather than replacing it, and do not overwrite its `post-build-hook` setting. For example, pass additions under a different variable and combine them in the build step:

```yaml
- name: Build with additional Nix settings
  env:
    EXTRA_NIX_CONFIG: |
      keep-going = true
  run: |
    export NIX_CONFIG="${NIX_CONFIG:-}
    ${EXTRA_NIX_CONFIG:-}"
    nix build .#package
```

This preserves both the inherited settings and Attic's hook line. Any later `GITHUB_ENV` update must likewise retain the inherited value, not write only the additions.

## Outputs

None

## License

MIT
