# @ramplab/cli

Press a guided reading of any codebase, from the command line. Every claim in
the result carries a code anchor that is mechanically checked against the
source, and the adversarial verify stage drops anything it cannot confirm.

```sh
npm install -g @ramplab/cli
cd path/to/your/repo
ramplab generate . --out lab.spec.json
ramplab preview lab.spec.json
```

Or hand it a GitHub URL, and it clones into a temporary checkout, presses
that, and removes the checkout afterwards:

```sh
ramplab generate https://github.com/owner/repo
```

## What it sends, and where

Worth stating precisely, because you are probably installing this on a machine
that holds somebody else's source.

- **Pressing sends excerpts of your code to Anthropic**, under your own
  credential. That is how the writing gets done and how the verify stage checks
  it. It is the same request your editor makes when you ask Claude about a file.
- **Nothing goes to RampLab while you press.** Our servers do not see the
  repository, the excerpts, or that the press ran at all.
- **`validate`, `preview` and `export` touch no network.**
- **`publish` uploads the finished edition** and nothing else. An edition
  quotes real lines of your source, so those lines go with it. That is the
  point of publishing one, and it is worth knowing before you do.

## Which credential it spends

If you use Claude Code you already have what you need: the press signs in the
way Claude Code does, so a Pro, Max, Team or Enterprise plan works with no API
key and no billing setup. It spends session allowance rather than API credit.

Set `ANTHROPIC_API_KEY` to meter it against an API key instead, at roughly $5
to $30 in tokens per edition. A key takes precedence wherever it is set, and
the press says which one it is about to spend before it starts.

## Commands

| | |
|---|---|
| `ramplab generate <repo\|url> [--out <file>]` | Press an edition. The only command that spends a credential or reads your source. |
| `ramplab validate <spec.json>` | Check a spec is loadable. Free, offline. |
| `ramplab preview <spec.json> [--port <n>]` | Read it on your own machine. |
| `ramplab export <spec.json> --static <dir>` | Write a self contained folder to host anywhere. |
| `ramplab publish <spec.json>` | Offer it to the library at library.ramplab.dev. |

Publishing to your workspace or out by link asks nothing of the repository.
The public shelf asks that the edition came from a public GitHub repository at
a commit, so the library can clone that exact tree and resolve every anchor
again itself, and then that a person has read it.

## Licence

MIT. See [LICENSE](./LICENSE).
