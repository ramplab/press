// Renderer tests live at the spec seam: they feed spec JSON through
// @ramplab/spec parsing and assert only user-visible behavior.
//
// The Edition shell (#22): an uncontrolled Lab opens on the CONTENTS page
// (frontispiece, chapter list, appendix, colophon); chapters are opened from
// the contents and the running head's Contents control comes back.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseLabSpec } from '@ramplab/spec';
import { createLocalProgressStore, Lab, type LabProgress } from '../src/index.js';
import twoModuleLab from './fixtures/two-module-lab.json';

function renderFixtureLab() {
  const spec = parseLabSpec(structuredClone(twoModuleLab));
  render(<Lab spec={spec} />);
  return spec;
}

function contentsNav() {
  return screen.getByRole('navigation', { name: 'Modules' });
}

async function openChapter(user: ReturnType<typeof userEvent.setup>, title: RegExp) {
  await user.click(within(contentsNav()).getByRole('button', { name: title }));
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('<Lab />', () => {
  it('opens on the contents page with the lab title and repo provenance', () => {
    renderFixtureLab();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Renderer Fixture Lab' }),
    ).toBeVisible();
    // Repo provenance appears in the edition line (and again in the colophon).
    expect(screen.getAllByText('ramplab/ramplab').length).toBeGreaterThan(0);
    // Chapter list with both modules; no chapter content yet.
    expect(within(contentsNav()).getAllByRole('button')).toHaveLength(2);
    expect(
      screen.queryByText('Everything starts at the spec.'),
    ).not.toBeInTheDocument();
  });

  it('opens a chapter with its callout content and anchors', async () => {
    const user = userEvent.setup();
    renderFixtureLab();
    await openChapter(user, /First Module/);
    expect(screen.getByRole('heading', { level: 2, name: 'First Module' })).toBeVisible();
    expect(screen.getByText('Everything starts at the spec.')).toBeVisible();
    expect(
      screen.getByText('Every machine claim points back at real code.', { exact: false }),
    ).toBeVisible();
    expect(screen.getByText('Why anchors', { exact: false })).toBeVisible();
    // Anchors are user-visible provenance.
    expect(screen.getByText('packages/spec/src/schema.ts', { exact: false })).toBeVisible();
    expect(screen.getByText('anchorSchema', { exact: false })).toBeVisible();
  });

  it('exposes the callout kind as a styling hook', async () => {
    const user = userEvent.setup();
    renderFixtureLab();
    await openChapter(user, /First Module/);
    const why = screen
      .getByText('Every machine claim points back at real code.', { exact: false })
      .closest('[data-kind]');
    expect(why).toHaveAttribute('data-kind', 'why');

    const warning = screen
      .getByText('Regeneration rewrites the base', { exact: false })
      .closest('[data-kind]');
    expect(warning).toHaveAttribute('data-kind', 'warning');
  });

  it('renders unanchored overlay widgets, marked as team notes', async () => {
    const user = userEvent.setup();
    renderFixtureLab();
    await openChapter(user, /First Module/);
    const overlay = screen
      .getByText('the staging repo lags a day behind', { exact: false })
      .closest('[data-kind]');
    expect(overlay).not.toBeNull();
    expect(within(overlay as HTMLElement).getByText('team note')).toBeVisible();
  });

  it('lists all modules in the contents with roman numerals', () => {
    renderFixtureLab();
    const items = within(contentsNav()).getAllByRole('button');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('First Module'),
      expect.stringContaining('Second Module'),
    ]);
    expect(items[0]?.textContent?.startsWith('I')).toBe(true);
    expect(items[1]?.textContent?.startsWith('II')).toBe(true);
  });

  it('opens chapters from the contents and returns via the running head', async () => {
    const user = userEvent.setup();
    renderFixtureLab();

    // Second module's content is not shown on the contents page.
    expect(
      screen.queryByText('The renderer consumes the spec seam', { exact: false }),
    ).not.toBeInTheDocument();

    await openChapter(user, /Second Module/);

    expect(screen.getByRole('heading', { level: 2, name: 'Second Module' })).toBeVisible();
    expect(
      screen.getByText('The renderer consumes the spec seam', { exact: false }),
    ).toBeVisible();
    expect(
      screen.queryByText('Every machine claim points back at real code.', { exact: false }),
    ).not.toBeInTheDocument();
    // The chapter view carries no persistent nav — orientation is book
    // furniture. The running head brings the contents back.
    expect(screen.queryByRole('navigation', { name: 'Modules' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Contents' }));
    expect(contentsNav()).toBeVisible();
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Second Module' }),
    ).not.toBeInTheDocument();
  });

  it('shows the controlled module when activeModuleId is provided', () => {
    const spec = parseLabSpec(structuredClone(twoModuleLab));
    render(<Lab spec={spec} activeModuleId="second-module" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Second Module' })).toBeVisible();
    expect(
      screen.queryByRole('heading', { level: 2, name: 'First Module' }),
    ).not.toBeInTheDocument();
  });

  it('renders contents entries as permalinks and reports selection when moduleHref is given', async () => {
    const user = userEvent.setup();
    const spec = parseLabSpec(structuredClone(twoModuleLab));
    const onSelectModule = vi.fn();
    render(
      <Lab
        spec={spec}
        onSelectModule={onSelectModule}
        moduleHref={(moduleId) => `/lab/fixture/${moduleId}`}
      />,
    );

    const links = within(contentsNav()).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/lab/fixture/first-module',
      '/lab/fixture/second-module',
    ]);

    await user.click(within(contentsNav()).getByRole('link', { name: /Second Module/ }));
    expect(onSelectModule).toHaveBeenCalledWith('second-module');
  });

  it('marks modules viewed as the learner opens them and reports progress to the host', async () => {
    const user = userEvent.setup();
    const spec = parseLabSpec(structuredClone(twoModuleLab));
    // Isolated in-memory storage: other tests in this file share
    // window.localStorage through the default store.
    const backing = new Map<string, string>();
    const store = createLocalProgressStore(spec.id, {
      length: 0,
      clear: () => backing.clear(),
      getItem: (key) => backing.get(key) ?? null,
      key: () => null,
      removeItem: (key) => void backing.delete(key),
      setItem: (key, value) => void backing.set(key, value),
    });
    const onProgressChange = vi.fn();
    render(<Lab spec={spec} progressStore={store} onProgressChange={onProgressChange} />);

    // Nothing viewed from the contents page alone.
    expect(
      within(contentsNav()).getByRole('button', { name: /First Module/ }),
    ).not.toHaveAttribute('data-viewed');

    // Opening a chapter marks it viewed (visible after returning to contents).
    await openChapter(user, /First Module/);
    await user.click(screen.getByRole('button', { name: 'Contents' }));
    expect(within(contentsNav()).getByRole('button', { name: /First Module/ })).toHaveAttribute(
      'data-viewed',
      'true',
    );
    expect(
      within(contentsNav()).getByRole('button', { name: /Second Module/ }),
    ).not.toHaveAttribute('data-viewed');

    await openChapter(user, /Second Module/);
    await user.click(screen.getByRole('button', { name: 'Contents' }));
    expect(within(contentsNav()).getByRole('button', { name: /Second Module/ })).toHaveAttribute(
      'data-viewed',
      'true',
    );

    // The host sees every snapshot — this is what feeds resume + the ledger.
    const latest = onProgressChange.mock.lastCall?.[0] as LabProgress;
    expect(latest.viewedModules).toEqual({ 'first-module': true, 'second-module': true });
  });

  it('renders the moduleCoda inside its chapter only — never on the contents page', async () => {
    const user = userEvent.setup();
    const spec = parseLabSpec(structuredClone(twoModuleLab));
    render(
      <Lab
        spec={spec}
        moduleCoda={(module) =>
          module.id === 'second-module' ? <div>Live coda content</div> : null
        }
      />,
    );
    // Contents page: no coda.
    expect(screen.queryByText('Live coda content')).not.toBeInTheDocument();

    await openChapter(user, /First Module/);
    expect(screen.queryByText('Live coda content')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Contents' }));
    await openChapter(user, /Second Module/);
    const coda = screen.getByText('Live coda content');
    expect(coda).toBeVisible();
    // The coda belongs to the chapter body — before the end-of-chapter footer.
    expect(
      coda.compareDocumentPosition(screen.getByText(/End of Chapter/)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
