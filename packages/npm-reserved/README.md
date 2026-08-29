# artifactshare (reserved package name)

This unscoped npm package name is reserved for Artifact Share. It is not the
supported CLI package.

Use [`@artifactshare/cli`](https://www.npmjs.com/package/@artifactshare/cli):

```sh
npm exec --yes --package=@artifactshare/cli -- artifactshare --help
```

The supported CLI source and documentation are in the
[public Artifact Share repository](https://github.com/artifactshare/artifactshare/tree/main/packages/cli).

Installing `artifactshare` does not install or proxy the supported CLI. Running
its placeholder command prints the same migration guidance so automated agents
can recover without guessing a package name.
