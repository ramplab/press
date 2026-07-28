// Progress store tests: the localStorage seam the hosted viewer will later
// swap for account-backed storage. Covers round-trips, isolation per lab id,
// and resilience to unavailable, throwing, or corrupted storage.
import { beforeEach, describe, expect, it } from 'vitest';
import type { ResolvedModule } from '@ramplab/spec';
import {
  createLocalProgressStore,
  emptyProgress,
  furthestVisitedModuleId,
  moduleProgressState,
  progressStorageKey,
} from '../src/index.js';

/** Minimal in-memory Storage double. */
function fakeStorage(backing: Map<string, string> = new Map()): Storage {
  return {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (key: string) => backing.get(key) ?? null,
    key: (index: number) => [...backing.keys()][index] ?? null,
    removeItem: (key: string) => {
      backing.delete(key);
    },
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
  };
}

function throwingStorage(): Storage {
  const boom = () => {
    throw new Error('storage disabled');
  };
  return {
    length: 0,
    clear: boom,
    getItem: boom,
    key: boom,
    removeItem: boom,
    setItem: boom,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('createLocalProgressStore', () => {
  it('starts empty and records checkpoint results per widget and question', () => {
    const store = createLocalProgressStore('my-lab', fakeStorage());
    expect(store.read()).toEqual({ viewedModules: {}, completedModules: {}, checkpoints: {} });

    const next = store.recordCheckpoint('quiz-1', 'q1', {
      selectedOptionId: 'a',
      correct: true,
    });
    expect(next.checkpoints['quiz-1']?.['q1']).toEqual({ selectedOptionId: 'a', correct: true });
  });

  it('keeps the latest result per question and tracks module completion', () => {
    const store = createLocalProgressStore('my-lab', fakeStorage());
    store.recordCheckpoint('quiz-1', 'q1', { selectedOptionId: 'b', correct: false });
    store.recordCheckpoint('quiz-1', 'q1', { selectedOptionId: 'a', correct: true });
    const withModule = store.setModuleCompleted('module-1', true);

    expect(withModule.checkpoints['quiz-1']?.['q1']).toEqual({
      selectedOptionId: 'a',
      correct: true,
    });
    expect(withModule.completedModules).toEqual({ 'module-1': true });
    expect(store.setModuleCompleted('module-1', false).completedModules).toEqual({});
  });

  it('round-trips progress through storage: a fresh store instance sees it (reload survival)', () => {
    const backing = new Map<string, string>();
    const before = createLocalProgressStore('my-lab', fakeStorage(backing));
    before.setModuleViewed('module-1');
    before.recordCheckpoint('quiz-1', 'q1', { selectedOptionId: 'a', correct: true });
    before.setModuleCompleted('module-1', true);

    const after = createLocalProgressStore('my-lab', fakeStorage(backing));
    expect(after.read()).toEqual({
      viewedModules: { 'module-1': true },
      completedModules: { 'module-1': true },
      checkpoints: { 'quiz-1': { q1: { selectedOptionId: 'a', correct: true } } },
    });
  });

  it('marks modules viewed idempotently, without writing when already viewed', () => {
    const backing = new Map<string, string>();
    let writes = 0;
    const storage = fakeStorage(backing);
    const counting: Storage = {
      ...storage,
      setItem: (key, value) => {
        writes += 1;
        storage.setItem(key, value);
      },
    };
    const store = createLocalProgressStore('my-lab', counting);

    expect(store.setModuleViewed('module-1').viewedModules).toEqual({ 'module-1': true });
    expect(writes).toBe(1);
    expect(store.setModuleViewed('module-1').viewedModules).toEqual({ 'module-1': true });
    expect(writes).toBe(1);
  });

  it('reads legacy v1 records that predate viewed-tracking (migration room)', () => {
    const legacy = JSON.stringify({
      completedModules: { 'module-1': true },
      checkpoints: { 'quiz-1': { q1: { selectedOptionId: 'a', correct: true } } },
    });
    const backing = new Map([[progressStorageKey('my-lab'), legacy]]);
    const store = createLocalProgressStore('my-lab', fakeStorage(backing));

    const progress = store.read();
    expect(progress.viewedModules).toEqual({});
    expect(progress.completedModules).toEqual({ 'module-1': true });
    // Completion implies viewed, so legacy records never render as unseen.
    expect(moduleProgressState('module-1', progress)).toBe('completed');
  });

  it('keys progress by lab id so labs never share results', () => {
    const backing = new Map<string, string>();
    const labA = createLocalProgressStore('lab-a', fakeStorage(backing));
    labA.recordCheckpoint('quiz-1', 'q1', { selectedOptionId: 'a', correct: true });

    const labB = createLocalProgressStore('lab-b', fakeStorage(backing));
    expect(labB.read().checkpoints).toEqual({});
    expect(backing.has(progressStorageKey('lab-a'))).toBe(true);
    expect(backing.has(progressStorageKey('lab-b'))).toBe(false);
  });

  it('reset wipes only this lab and returns the empty snapshot', () => {
    const backing = new Map<string, string>();
    const labA = createLocalProgressStore('lab-a', fakeStorage(backing));
    const labB = createLocalProgressStore('lab-b', fakeStorage(backing));
    labA.recordCheckpoint('quiz-1', 'q1', { selectedOptionId: 'a', correct: true });
    labB.recordCheckpoint('quiz-9', 'q9', { selectedOptionId: 'z', correct: true });

    expect(labA.reset()).toEqual({ viewedModules: {}, completedModules: {}, checkpoints: {} });
    expect(backing.has(progressStorageKey('lab-a'))).toBe(false);
    expect(createLocalProgressStore('lab-b', fakeStorage(backing)).read().checkpoints).toHaveProperty(
      'quiz-9',
    );
  });

  it('returns defensive copies — mutating a snapshot never corrupts the store', () => {
    const store = createLocalProgressStore('my-lab', fakeStorage());
    store.recordCheckpoint('quiz-1', 'q1', { selectedOptionId: 'a', correct: true });

    const snapshot = store.read();
    delete snapshot.checkpoints['quiz-1'];
    expect(store.read().checkpoints['quiz-1']?.['q1']?.correct).toBe(true);
  });

  it('works in memory when storage is unavailable', () => {
    const store = createLocalProgressStore('my-lab', undefined);
    const next = store.recordCheckpoint('quiz-1', 'q1', { selectedOptionId: 'a', correct: true });
    expect(next.checkpoints['quiz-1']?.['q1']?.correct).toBe(true);
  });

  it('degrades to in-memory progress when storage throws on every call', () => {
    const store = createLocalProgressStore('my-lab', throwingStorage());
    expect(store.read()).toEqual({ viewedModules: {}, completedModules: {}, checkpoints: {} });
    const next = store.recordCheckpoint('quiz-1', 'q1', { selectedOptionId: 'a', correct: true });
    expect(next.checkpoints['quiz-1']?.['q1']?.correct).toBe(true);
    expect(store.reset()).toEqual({ viewedModules: {}, completedModules: {}, checkpoints: {} });
  });

  it('treats corrupted or foreign-shaped persisted JSON as empty progress', () => {
    for (const raw of ['not json {', '"a string"', '[1,2]', '{"checkpoints":{"quiz-1":{"q1":{"correct":"yes"}}}}']) {
      const backing = new Map([[progressStorageKey('my-lab'), raw]]);
      const store = createLocalProgressStore('my-lab', fakeStorage(backing));
      expect(store.read()).toEqual({ viewedModules: {}, completedModules: {}, checkpoints: {} });
    }
  });

  it('defaults to window.localStorage keyed by lab id', () => {
    const store = createLocalProgressStore('default-lab');
    store.recordCheckpoint('quiz-1', 'q1', { selectedOptionId: 'a', correct: true });
    const raw = window.localStorage.getItem(progressStorageKey('default-lab'));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).checkpoints['quiz-1'].q1.correct).toBe(true);
  });
});

/** Journey helpers only read module ids, so a minimal shape suffices. */
function modulesById(...ids: string[]): ResolvedModule[] {
  return ids.map((id) => ({ id, title: id, widgets: [] }) as unknown as ResolvedModule);
}

describe('moduleProgressState', () => {
  it('walks unseen → viewed → completed, with completed winning over viewed', () => {
    const progress = emptyProgress();
    expect(moduleProgressState('m1', progress)).toBe('unseen');

    progress.viewedModules['m1'] = true;
    expect(moduleProgressState('m1', progress)).toBe('viewed');

    progress.completedModules['m1'] = true;
    expect(moduleProgressState('m1', progress)).toBe('completed');
  });
});

describe('furthestVisitedModuleId', () => {
  const modules = modulesById('m1', 'm2', 'm3');

  it('is undefined until anything has been visited', () => {
    expect(furthestVisitedModuleId(modules, emptyProgress())).toBeUndefined();
  });

  it('returns the highest-index viewed module in spec order', () => {
    const progress = emptyProgress();
    progress.viewedModules['m1'] = true;
    progress.viewedModules['m2'] = true;
    expect(furthestVisitedModuleId(modules, progress)).toBe('m2');
  });

  it('counts completed-only modules (legacy records) as visited', () => {
    const progress = emptyProgress();
    progress.viewedModules['m2'] = true;
    progress.completedModules['m3'] = true;
    expect(furthestVisitedModuleId(modules, progress)).toBe('m3');
  });

  it('ignores progress for modules no longer in the spec', () => {
    const progress = emptyProgress();
    progress.viewedModules['removed-module'] = true;
    expect(furthestVisitedModuleId(modules, progress)).toBeUndefined();
  });
});
