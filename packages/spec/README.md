# @ramplab/spec

The RampLab edition format: versioned Zod schemas, a parser and a resolver for
a lab spec. Everything that reads or writes an edition meets this contract,
which is why it is published on its own: an edition is a format, not a thing
only we can read.

```sh
npm install @ramplab/spec
```

```ts
import { parseLabSpec, safeParseLabSpec } from '@ramplab/spec';

const spec = parseLabSpec(JSON.parse(await readFile('lab.spec.json', 'utf8')));
```

Every teachable claim in a spec carries an anchor: a repo-relative file, an
optional line range and symbol, and a sha256 of the region it points at. That
is what makes an edition checkable against the code it describes rather than
taken on trust.

Pressed with [`@ramplab/cli`](https://www.npmjs.com/package/@ramplab/cli).

## Licence

MIT. See [LICENSE](./LICENSE).
