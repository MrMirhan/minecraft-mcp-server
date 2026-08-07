import test from 'ava';
import sinon from 'sinon';
import { ActionManager, raceWithAbort } from '../src/action-manager.js';

test('run resolves with success and the fn message when nothing interrupts it', async (t) => {
  const manager = new ActionManager();

  const result = await manager.run('noop', undefined, async () => 'done');

  t.deepEqual(result, { success: true, message: 'done', interrupted: false, timedout: false });
});

test('run reports failure and the thrown message when the fn throws', async (t) => {
  const manager = new ActionManager();

  const result = await manager.run('failing', undefined, async () => {
    throw new Error('boom');
  });

  t.false(result.success);
  t.is(result.message, 'boom');
  t.false(result.interrupted);
  t.false(result.timedout);
});

test('getCurrentAction returns null when idle', (t) => {
  const manager = new ActionManager();
  t.is(manager.getCurrentAction(), null);
});

test('interrupt resolves to null when nothing is running', async (t) => {
  const manager = new ActionManager();
  t.is(await manager.interrupt(), null);
});

test.serial('getCurrentAction reports the running label and elapsed time', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());

  const manager = new ActionManager();
  let releaseAction: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { releaseAction = resolve; });

  const runPromise = manager.run('long-task', undefined, async () => {
    await gate;
    return 'finished';
  });

  t.deepEqual(manager.getCurrentAction(), { label: 'long-task', runningForMs: 0 });

  await clock.tickAsync(500);
  t.deepEqual(manager.getCurrentAction(), { label: 'long-task', runningForMs: 500 });

  releaseAction();
  await runPromise;
  t.is(manager.getCurrentAction(), null);
});

test.serial('run enforces a timeout, aborts the signal and reports timedout', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());

  const manager = new ActionManager();
  let sawAbort = false;

  const runPromise = manager.run('slow', 1000, async (ctx) => {
    await new Promise<void>((resolve) => {
      ctx.signal.addEventListener('abort', () => {
        sawAbort = true;
        resolve();
      }, { once: true });
    });
    throw new Error('timed out waiting');
  });

  await clock.tickAsync(1000);
  const result = await runPromise;

  t.true(sawAbort);
  t.false(result.success);
  t.false(result.interrupted);
  t.true(result.timedout);
});

test('run without a timeout never aborts the signal', async (t) => {
  const manager = new ActionManager();

  const result = await manager.run('untimed', undefined, async (ctx) => {
    t.false(ctx.signal.aborted);
    return 'ok';
  });

  t.true(result.success);
  t.false(result.timedout);
});

test('starting a new action interrupts the previous one and waits for it to finish before starting', async (t) => {
  const manager = new ActionManager();
  const events: string[] = [];
  let releaseFirst: () => void = () => undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const firstPromise = manager.run('first', undefined, async (ctx) => {
    events.push('first:started');
    await new Promise<void>((resolve) => {
      ctx.signal.addEventListener('abort', () => {
        events.push('first:aborted');
        resolve();
      }, { once: true });
    });
    await firstGate;
    events.push('first:cleaned-up');
    return 'first done';
  });

  // Let the first action actually start before interrupting it.
  await new Promise((resolve) => setImmediate(resolve));

  const secondPromise = manager.run('second', undefined, async () => {
    events.push('second:started');
    return 'second done';
  });

  // The second action must not start until the first has fully cleaned up.
  await new Promise((resolve) => setImmediate(resolve));
  t.deepEqual(events, ['first:started', 'first:aborted']);

  releaseFirst();

  const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);

  t.deepEqual(events, ['first:started', 'first:aborted', 'first:cleaned-up', 'second:started']);
  t.false(firstResult.success);
  t.true(firstResult.interrupted);
  t.false(firstResult.timedout);
  t.true(secondResult.success);
  t.is(manager.getCurrentAction(), null);
});

test.serial('a never-settling, signal-ignoring action does not block a later run()', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());

  const manager = new ActionManager(1000);

  const stuckPromise = manager.run('stuck', undefined, () => new Promise<string>(() => undefined));
  const secondPromise = manager.run('second', undefined, async () => 'second done');

  await clock.tickAsync(1000);

  const secondResult = await secondPromise;
  t.true(secondResult.success);
  t.is(secondResult.message, 'second done');

  const stuckResult = await stuckPromise;
  t.false(stuckResult.success);
  t.true(stuckResult.interrupted);
  t.true(stuckResult.message.includes('abandoned'));
});

test.serial('a never-settling, signal-ignoring action does not block a later interrupt(), so stop still works', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());

  const manager = new ActionManager(1000);

  const stuckPromise = manager.run('stuck', undefined, () => new Promise<string>(() => undefined));

  const interruptPromise = manager.interrupt();
  await clock.tickAsync(1000);
  const interruptResult = await interruptPromise;

  t.deepEqual(interruptResult, { label: 'stuck' });
  t.is(manager.getCurrentAction(), null);

  const stuckResult = await stuckPromise;
  t.false(stuckResult.success);
  t.true(stuckResult.interrupted);
});

test.serial('an abandoned action that settles later cannot corrupt current or resolve a stale caller', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());

  const manager = new ActionManager(1000);

  let releaseStuck: (value: string) => void = () => undefined;
  const stuckPromise = manager.run('stuck', undefined, () => new Promise<string>((resolve) => { releaseStuck = resolve; }));

  let releaseSecond: (value: string) => void = () => undefined;
  const secondPromise = manager.run('second', undefined, () => new Promise<string>((resolve) => { releaseSecond = resolve; }));

  await clock.tickAsync(1000);

  const stuckResult = await stuckPromise;
  t.false(stuckResult.success);
  t.true(stuckResult.interrupted);
  t.true(stuckResult.message.includes('abandoned'));
  t.deepEqual(manager.getCurrentAction(), { label: 'second', runningForMs: 0 });

  // The abandoned fn settles late, well after its caller already got the abandonment result.
  releaseStuck('too late');
  await clock.tickAsync(0);

  t.deepEqual(manager.getCurrentAction(), { label: 'second', runningForMs: 0 });
  const stuckResultAgain = await stuckPromise;
  t.is(stuckResultAgain.message, stuckResult.message);

  releaseSecond('second done');
  const secondResult = await secondPromise;
  t.true(secondResult.success);
  t.is(secondResult.message, 'second done');
  t.is(manager.getCurrentAction(), null);
});

test('raceWithAbort resolves normally when the promise settles before the signal aborts', async (t) => {
  const controller = new AbortController();
  const onAbort = sinon.stub();

  const value = await raceWithAbort(Promise.resolve('value'), controller.signal, onAbort);

  t.is(value, 'value');
  t.true(onAbort.notCalled);
});

test('raceWithAbort calls onAbort and rejects as soon as the signal aborts, without waiting for the promise', async (t) => {
  const controller = new AbortController();
  const onAbort = sinon.stub();
  const neverSettles = new Promise<string>(() => undefined);

  const racePromise = raceWithAbort(neverSettles, controller.signal, onAbort);
  controller.abort(new Error('stop now'));

  await t.throwsAsync(racePromise, { message: 'stop now' });
  t.true(onAbort.calledOnce);
});

test('raceWithAbort rejects immediately and still calls onAbort when the signal is already aborted', async (t) => {
  const controller = new AbortController();
  controller.abort(new Error('already stopped'));
  const onAbort = sinon.stub();

  await t.throwsAsync(raceWithAbort(Promise.resolve('unused'), controller.signal, onAbort), {
    message: 'already stopped'
  });
  t.true(onAbort.calledOnce);
});
