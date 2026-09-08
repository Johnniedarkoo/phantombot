# Local development branches

This checkout keeps the upstream project line separate from the local runtime:

```text
upstream/main
    |
    +-- local/<feature>   preserved local logical change / future PR candidate
    `-- local/runtime     complete working PhantomBot integration
            ^
            deployed/*  known-good installed revisions
```

`main` is reserved for the clean upstream mirror. Existing feature branches
remain available when they already carry useful history. Temporary upstream PR
branches start fresh from upstream:

```text
git fetch upstream
git switch -c pr/<feature> upstream/main
git cherry-pick <relevant local commits>
# test, then push origin pr/<feature>
```

The Pi executable used by this runtime is the global
`@earendil-works/pi-coding-agent` npm package. PhantomBot's managed extensions
are embedded in its own binary and stamped into Pi's extension directory at
startup; the source for the managed dynamic-context extension lives under
`pi-extension/dynamic-context/`.
