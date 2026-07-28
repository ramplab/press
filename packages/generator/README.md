# @ramplab/generator

The RampLab pipeline: it reads a repository, writes an edition of it, and
mechanically resolves every code anchor against the source so nothing
unverifiable survives.

```sh
npm install @ramplab/generator
```

Most people want [`@ramplab/cli`](https://www.npmjs.com/package/@ramplab/cli)
instead, which wraps this with a command line, credential handling and
progress reporting. Use this directly if you are embedding the press in
something of your own.

`resolveAnchors(spec, repoDir)` is the part worth knowing about even if you
never press anything: it is pure over (spec, repository directory), checks that
every anchored file, line range and symbol really exists, and fingerprints the
region it resolved. Grounding is enforced structurally rather than promised.

## Licence

MIT. See [LICENSE](./LICENSE).
