# @ramplab/renderer

React components that render a RampLab edition: the reader used by
`ramplab preview` to serve one locally and by `ramplab export` to write a self
contained copy you can host anywhere.

```sh
npm install @ramplab/renderer
```

```tsx
import { Lab } from '@ramplab/renderer';
import '@ramplab/renderer/style.css';

<Lab spec={spec} />;
```

Takes a spec parsed by
[`@ramplab/spec`](https://www.npmjs.com/package/@ramplab/spec). Every widget
type in the format has a component here, and an edition renders the same way
in the library, in a local preview and in an exported bundle.

## Licence

MIT. See [LICENSE](./LICENSE).
